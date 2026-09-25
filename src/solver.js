import { normalizeProblem } from './problem.js';
import { analyzeTopology, initialLayoutFromEmbedding } from './topology/planarity.js';
import { GpuBatchScorer } from './gpu/batch-scorer.js';
import { GpuLnsOptimizer } from './optimizer/lns.js';
import { GpuNegotiatedRouter } from './router/negotiated-router.js';

/** End-to-end topology-first solver. */
export async function solveAutoLayout(input, device, options={}) {
  const problem=input.componentIndex ? input : normalizeProblem(input);
  const topology=await analyzeTopology(problem);
  if(!topology.planar) return {status:'topologically-impossible',problem,topology};
  const seed=options.initialLayout ?? initialLayoutFromEmbedding(problem,topology,options.embeddingMargin ?? 0.08);
  const scorer=new GpuBatchScorer(device,problem,{weights:options.weights});
  try {
    const attempts=options.restarts ?? 2; let best=null;
    for(let a=0;a<attempts;a++) {
      const optimizer=new GpuLnsOptimizer(problem,scorer,{...options.optimizer,seed:(options.optimizer?.seed??1)+a*7919});
      const optimized=await optimizer.optimize(a===0?seed:(best?.layout??seed),options.onIteration);
      if(!best||optimized.score.total<best.score.total)best=optimized;
      const router=new GpuNegotiatedRouter(device,problem,{...options.router,seed:(options.router?.seed??7)+a*104729});
      const routed=await router.route(optimized.layout);
      if(routed.status==='routed') return {status:'routed',problem,topology,layout:optimized.layout,score:optimized.score,optimization:optimized,routing:routed};
    }
    const router=new GpuNegotiatedRouter(device,problem,options.router);
    const routing=await router.route(best.layout);
    return {status:'geometrically-unresolved',problem,topology,layout:best.layout,score:best.score,optimization:best,routing};
  } finally { scorer.destroy(); }
}
