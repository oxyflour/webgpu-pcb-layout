import { AnalyticalGlobalPlacer } from './global-placement.js';

function rng32(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
function randomLayout(problem,rnd){
  return problem.components.map(c=>{
    if(c.fixed)return {...c.fixed};
    const w=c.width,h=c.height;
    return {x:w/2+rnd()*(problem.canvas.width-w),y:h/2+rnd()*(problem.canvas.height-h),rotation:0};
  });
}

/** CPU reference for the same batched multi-start policy used by the WebGPU path. */
export class MultiStartGlobalPlacer {
  constructor(problem, exactScorer, options={}){
    this.problem=problem;this.exactScorer=exactScorer;
    this.options={starts:options.starts??12,coarseIterations:options.coarseIterations??180,finalists:options.finalists??3,
      fineIterations:options.fineIterations??260,seed:options.seed??1,placer:options.placer??{}};
  }
  async optimize(primaryInitial=null){
    const o=this.options,rnd=rng32(o.seed),runs=[];
    for(let s=0;s<o.starts;s++){
      const initial=s===0&&primaryInitial?primaryInitial:randomLayout(this.problem,rnd);
      const placer=new AnalyticalGlobalPlacer(this.problem,{...o.placer,iterations:o.coarseIterations,recordEvery:1e9});
      const out=await placer.optimize(initial);runs.push(out.layout);
    }
    const scores=await this.exactScorer.scoreLayouts(runs);const ord=scores.map((_,i)=>i).sort((a,b)=>scores[a].total-scores[b].total).slice(0,o.finalists);
    const fine=[];
    for(const i of ord){
      const placer=new AnalyticalGlobalPlacer(this.problem,{...o.placer,iterations:o.fineIterations,recordEvery:1e9});
      const out=await placer.optimize(runs[i]);fine.push(out.layout);
    }
    const fineScores=await this.exactScorer.scoreLayouts(fine);let bi=0;for(let i=1;i<fine.length;i++)if(fineScores[i].total<fineScores[bi].total)bi=i;
    return {layout:fine[bi],score:fineScores[bi],coarseLayouts:runs,coarseScores:scores,finalistIndices:ord};
  }
}
