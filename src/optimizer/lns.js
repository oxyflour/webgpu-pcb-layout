function rng32(seed) { let x=seed>>>0||1; return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;}; }
function normal(rnd){const u=Math.max(1e-12,rnd()),v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
function cloneLayout(l){return l.map(p=>({...p}));}

/** Parallel-proposal simulated annealing / LNS driven by GpuBatchScorer. */
export class GpuLnsOptimizer {
  constructor(problem, scorer, options={}) {
    this.problem=problem;this.scorer=scorer;this.options={
      iterations:options.iterations ?? 80,
      population:options.population ?? 1024,
      movesPerCandidate:options.movesPerCandidate ?? 3,
      translationScale:options.translationScale ?? 0.08*Math.min(problem.canvas.width,problem.canvas.height),
      rotationProbability:options.rotationProbability ?? 0.15,
      temperature:options.temperature ?? 0.05,
      cooling:options.cooling ?? 0.97,
      seed:options.seed ?? 1
    };
    this.movable=problem.components.filter(c=>!c.fixed);
  }

  #mutate(base,rnd,scale) {
    const out=cloneLayout(base); const movable=this.movable;
    if(!movable.length)return out;
    for(let m=0;m<this.options.movesPerCandidate;m++) {
      const c=movable[Math.floor(rnd()*movable.length)],p=out[c.index];
      p.x += normal(rnd)*scale; p.y += normal(rnd)*scale;
      if(c.rotatable && rnd()<this.options.rotationProbability)p.rotation=(p.rotation+(rnd()<.5?1:3))&3;
    }
    return out;
  }

  /** Same proposals as #mutate (identical RNG stream), written into flat slabs for scoreSlabs(). */
  async #scorePopulationSlabs(current,rnd,scale) {
    const n=this.problem.components.length,pop=this.options.population,movable=this.movable;
    if(!this.slabs||this.slabs.x.length!==pop*n)this.slabs={x:new Float64Array(pop*n),y:new Float64Array(pop*n),r:new Uint8Array(pop*n)};
    const {x,y,r}=this.slabs;
    for(let k=0;k<pop;k++) {
      const off=k*n;
      for(let i=0;i<n;i++){x[off+i]=current[i].x;y[off+i]=current[i].y;r[off+i]=current[i].rotation&3;}
      if(k===0||!movable.length)continue;
      for(let m=0;m<this.options.movesPerCandidate;m++) {
        const c=movable[Math.floor(rnd()*movable.length)],q=off+c.index;
        x[q]+=normal(rnd)*scale; y[q]+=normal(rnd)*scale;
        if(c.rotatable && rnd()<this.options.rotationProbability)r[q]=(r[q]+(rnd()<.5?1:3))&3;
      }
    }
    const scores=await this.scorer.scoreSlabs(x,y,r,pop);
    let bi=0;for(let k=1;k<pop;k++)if(scores[k].total<scores[bi].total)bi=k;
    const layout=bi===0?current:Array.from({length:n},(_,i)=>({x:x[bi*n+i],y:y[bi*n+i],rotation:r[bi*n+i]}));
    return {layout,score:scores[bi]};
  }

  async optimize(initial,onIteration=null) {
    const rnd=rng32(this.options.seed); let current=cloneLayout(initial);
    let [currentScore]=await this.scorer.scoreLayouts([current]); let best=cloneLayout(current),bestScore=currentScore;
    let temp=this.options.temperature,scale=this.options.translationScale;
    const trace=[];
    for(let it=0;it<this.options.iterations;it++) {
      let cand,candScore;
      if(typeof this.scorer.scoreSlabs==='function') {
        ({layout:cand,score:candScore}=await this.#scorePopulationSlabs(current,rnd,scale));
      } else {
        const candidates=new Array(this.options.population); candidates[0]=current;
        for(let k=1;k<candidates.length;k++)candidates[k]=this.#mutate(current,rnd,scale);
        const scores=await this.scorer.scoreLayouts(candidates);
        let bi=0;for(let k=1;k<scores.length;k++)if(scores[k].total<scores[bi].total)bi=k;
        cand=candidates[bi];candScore=scores[bi];
      }
      const delta=candScore.total-currentScore.total;
      const denom=Math.max(1,Math.abs(currentScore.total));
      if(delta<=0 || rnd()<Math.exp(-delta/(Math.max(1e-12,temp)*denom))) { current=cand;currentScore=candScore; }
      if(candScore.total<bestScore.total) { best=cloneLayout(cand);bestScore=candScore; }
      temp*=this.options.cooling; scale*=Math.max(0.985,this.options.cooling);
      const row={iteration:it,current:currentScore.total,best:bestScore.total,temperature:temp,scale};trace.push(row);if(onIteration)await onIteration({...row,currentLayout:cloneLayout(current),bestLayout:cloneLayout(best),currentScore:{...currentScore},bestScore:{...bestScore}});
    }
    return {layout:best,score:bestScore,trace};
  }
}
