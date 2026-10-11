import { scoreLayoutCpu } from '../cpu-score.js';

/** CPU reference backend with the same scoreLayouts() interface as GpuBatchScorer. */
export class CpuBatchScorer {
  constructor(problem, options={}) {
    this.problem=problem;
    this.weights=options.weights ?? {};
    this.coarse=options.coarse ?? {};
  }
  async scoreLayouts(layouts) {
    return layouts.map(layout=>scoreLayoutCpu(this.problem,layout,this.weights,this.coarse));
  }
  destroy() {}
}
