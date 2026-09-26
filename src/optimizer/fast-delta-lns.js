import { CompiledPlacementModel, packOrientation } from './compiled-placement-model.js';
import { clampToRegion } from '../problem.js';

function rng32(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
function normal(rnd){const u=Math.max(1e-12,rnd()),v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
function cloneLayout(l){return l.map(p=>({...p}));}

/**
 * High-throughput LNS:
 *  - proposals live in flat typed-array slabs (no per-candidate object graph),
 *  - a compiled approximate objective ranks the whole population,
 *  - only topK finalists pay for the exact scorer / exact congestion map.
 */
export class FastDeltaLnsOptimizer {
  constructor(problem, exactScorer, options={}){
    this.problem=problem;this.exactScorer=exactScorer;
    this.options={
      iterations:options.iterations??55,
      population:options.population??256,
      topK:options.topK??10,
      movesPerCandidate:options.movesPerCandidate??2,
      translationScale:options.translationScale??3.2,
      rotationProbability:options.rotationProbability??0.12,
      // Probability of moving a part to the other board side (parts with sides:'any').
      flipProbability:options.flipProbability??0.08,
      temperature:options.temperature??0.035,
      cooling:options.cooling??0.975,
      seed:options.seed??1,
      // Use exactScorer.scoreSlabs() for the full population when the scorer provides it.
      batchExact:options.batchExact??true,
    };
    this.model=options.model??new CompiledPlacementModel(problem,options.approximate??{});
    this.movable=[];for(let i=0;i<problem.components.length;i++)if(!problem.components[i].fixed)this.movable.push(i);
    // Optional per-component {x,y,width,height} the part must stay inside (module regions).
    this.regions=options.regions??null;
  }

  async optimize(initial,onIteration=null){
    const o=this.options,n=this.problem.components.length,pop=o.population,rnd=rng32(o.seed);
    let current=cloneLayout(initial);let [currentScore]=await this.exactScorer.scoreLayouts([current]);
    let best=cloneLayout(current),bestScore=currentScore,temp=o.temperature,scale=o.translationScale;
    const slabX=new Float64Array(pop*n),slabY=new Float64Array(pop*n);const slabR=new Uint8Array(pop*n);
    const approx=new Float64Array(pop);const idx=new Uint32Array(pop);for(let k=0;k<pop;k++)idx[k]=k;
    const trace=[];
    const batchExact=o.batchExact&&typeof this.exactScorer.scoreSlabs==='function';
    for(let it=0;it<o.iterations;it++){
      // Copy current once into each contiguous candidate slice, then mutate in place.
      for(let k=0;k<pop;k++){
        const off=k*n;
        for(let i=0;i<n;i++){slabX[off+i]=current[i].x;slabY[off+i]=current[i].y;slabR[off+i]=packOrientation(current[i]);}
        if(k===0)continue;
        for(let m=0;m<o.movesPerCandidate;m++){
          const ci=this.movable[Math.floor(rnd()*this.movable.length)],c=this.problem.components[ci];
          slabX[off+ci]+=normal(rnd)*scale;slabY[off+ci]+=normal(rnd)*scale;
          const rr=slabR[off+ci]&3;const w=(rr&1)?c.height:c.width,h=(rr&1)?c.width:c.height;
          slabX[off+ci]=Math.max(w/2,Math.min(this.problem.canvas.width-w/2,slabX[off+ci]));
          slabY[off+ci]=Math.max(h/2,Math.min(this.problem.canvas.height-h/2,slabY[off+ci]));
          if(c.rotatable&&rnd()<o.rotationProbability)slabR[off+ci]=(slabR[off+ci]&4)|((rr+(rnd()<.5?1:3))&3);
          if(c.sides==='any'&&rnd()<o.flipProbability)slabR[off+ci]^=4;
          const region=this.regions?.[ci];
          if(region)[slabX[off+ci],slabY[off+ci]]=clampToRegion(c,{x:slabX[off+ci],y:slabY[off+ci],rotation:slabR[off+ci]&3},region);
        }
      }
      let cand,candScore,exact;
      if(batchExact){
        // A batch scorer (WebGPU) scores the whole population exactly; no approximate pre-ranking.
        exact=await this.exactScorer.scoreSlabs(slabX,slabY,slabR,pop);
        let bi=0;for(let k=1;k<pop;k++)if(exact[k].total<exact[bi].total)bi=k;
        cand=bi===0?current:this.model.flatToLayout(slabX,slabY,slabR,bi*n);candScore=exact[bi];
      } else {
        for(let k=0;k<pop;k++)approx[k]=this.model.scoreFlat(slabX,slabY,slabR,k*n).total;
        const order=Array.from(idx);order.sort((a,b)=>approx[a]-approx[b]);
        const finalists=[];const finalistIdx=[];
        const kmax=Math.min(o.topK,pop);
        for(let q=0;q<kmax;q++){
          const k=order[q];finalistIdx.push(k);finalists.push(this.model.flatToLayout(slabX,slabY,slabR,k*n));
        }
        // Ensure current is present even if the approximate congestion model ranks it poorly.
        if(!finalistIdx.includes(0)){finalistIdx.push(0);finalists.push(current);}
        exact=await this.exactScorer.scoreLayouts(finalists);
        let bi=0;for(let q=1;q<exact.length;q++)if(exact[q].total<exact[bi].total)bi=q;
        cand=finalists[bi];candScore=exact[bi];
      }
      const delta=candScore.total-currentScore.total,denom=Math.max(1,Math.abs(currentScore.total));
      if(delta<=0||rnd()<Math.exp(-delta/(Math.max(1e-12,temp)*denom))){current=cloneLayout(cand);currentScore=candScore;}
      if(candScore.total<bestScore.total){best=cloneLayout(cand);bestScore=candScore;}
      temp*=o.cooling;scale*=Math.max(.985,o.cooling);
      const row={iteration:it,current:currentScore.total,best:bestScore.total,temperature:temp,scale,approxEvaluations:batchExact?0:pop,exactEvaluations:exact.length};trace.push(row);
      if(onIteration)await onIteration({...row,currentLayout:cloneLayout(current),bestLayout:cloneLayout(best),currentScore:{...currentScore},bestScore:{...bestScore}});
    }
    return {layout:best,score:bestScore,trace};
  }
}
