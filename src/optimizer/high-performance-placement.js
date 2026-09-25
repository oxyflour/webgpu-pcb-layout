import { MultiStartGlobalPlacer } from './multistart-global.js';
import { FastDeltaLnsOptimizer } from './fast-delta-lns.js';
import { GpuLnsOptimizer } from './lns.js';

/**
 * Production placement pipeline optimized for random initial layouts.
 * Routing is intentionally not part of optimize(); callers may validate later.
 */
export class HighPerformancePlacementOptimizer {
  constructor(problem, exactScorer, options={}){
    this.problem=problem; this.exactScorer=exactScorer;
    this.options={
      seed:options.seed??1,
      global:options.global??{},
      fastLns:options.fastLns??{},
      polish:options.polish??{},
      approximate:options.approximate??{},
    };
  }

  async optimize(initial){
    const o=this.options;
    const t0=performance.now();
    const global=new MultiStartGlobalPlacer(this.problem,this.exactScorer,{seed:o.seed^0xA511,...o.global});
    const gr=await global.optimize(initial);
    const t1=performance.now();
    const fast=new FastDeltaLnsOptimizer(this.problem,this.exactScorer,{seed:o.seed^0x51A2,approximate:o.approximate,...o.fastLns});
    const fr=await fast.optimize(gr.layout);
    const t2=performance.now();
    const polish=new GpuLnsOptimizer(this.problem,this.exactScorer,{iterations:28,population:128,movesPerCandidate:1,translationScale:1.6,rotationProbability:0,temperature:.012,cooling:.965,seed:o.seed^0x9E37,...o.polish});
    const pr=await polish.optimize(fr.layout);
    const t3=performance.now();
    return {layout:pr.layout,score:pr.score,timing:{globalMs:t1-t0,fastLnsMs:t2-t1,polishMs:t3-t2,totalMs:t3-t0},global:gr,fast:fr,polish:pr};
  }
}
