import { AnalyticalGlobalPlacer } from './global-placement.js';
import { GpuAnalyticalGlobalPlacer } from '../gpu/global-placer.js';

function rng32(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
function randomLayout(problem,rnd){
  return problem.components.map(c=>{
    if(c.fixed)return {...c.fixed};
    const w=c.width,h=c.height;
    return {x:w/2+rnd()*(problem.canvas.width-w),y:h/2+rnd()*(problem.canvas.height-h),rotation:0};
  });
}

/**
 * Batched multi-start global placement. With `options.device` every start (and then
 * every finalist) runs in a single WebGPU batch; otherwise starts run one by one on
 * the CPU reference placer.
 */
export class MultiStartGlobalPlacer {
  constructor(problem, exactScorer, options={}){
    this.problem=problem;this.exactScorer=exactScorer;
    this.options={starts:options.starts??12,coarseIterations:options.coarseIterations??180,finalists:options.finalists??3,
      fineIterations:options.fineIterations??260,seed:options.seed??1,placer:options.placer??{},device:options.device??null,
      // Explicit starting layouts (e.g. expanded module placements) replace the random starts.
      initials:options.initials??null};
  }
  async #run(layouts,iterations){
    const o=this.options;
    if(o.device){
      const placer=new GpuAnalyticalGlobalPlacer(o.device,this.problem,o.placer);
      try{ return await placer.optimizeBatch(layouts,iterations); } finally { placer.destroy(); }
    }
    const out=[];
    for(const initial of layouts){
      const placer=new AnalyticalGlobalPlacer(this.problem,{...o.placer,iterations,recordEvery:1e9});
      out.push((await placer.optimize(initial)).layout);
    }
    return out;
  }
  async optimize(primaryInitial=null){
    const o=this.options,rnd=rng32(o.seed),initials=[];
    if(o.initials?.length)initials.push(...o.initials);
    else for(let s=0;s<o.starts;s++)initials.push(s===0&&primaryInitial?primaryInitial:randomLayout(this.problem,rnd));
    const runs=await this.#run(initials,o.coarseIterations);
    const scores=await this.exactScorer.scoreLayouts(runs);const ord=scores.map((_,i)=>i).sort((a,b)=>scores[a].total-scores[b].total).slice(0,o.finalists);
    const fine=await this.#run(ord.map(i=>runs[i]),o.fineIterations);
    const fineScores=await this.exactScorer.scoreLayouts(fine);let bi=0;for(let i=1;i<fine.length;i++)if(fineScores[i].total<fineScores[bi].total)bi=i;
    return {layout:fine[bi],score:fineScores[bi],coarseLayouts:runs,coarseScores:scores,finalistIndices:ord};
  }
}
