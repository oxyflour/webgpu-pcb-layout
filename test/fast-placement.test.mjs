import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem } from '../src/problem.js';
import { PriorityCpuBatchScorer } from '../src/cpu/priority-batch-scorer.js';
import { FastDeltaLnsOptimizer } from '../src/optimizer/fast-delta-lns.js';

const input={canvas:{width:100,height:70},components:[
  {id:'A',width:10,height:8,rotatable:false,pins:[{id:'p',x:5,y:0}]},
  {id:'B',width:10,height:8,rotatable:false,pins:[{id:'p',x:-5,y:0}]},
  {id:'C',width:10,height:8,rotatable:false,pins:[{id:'p',x:5,y:0}]},
  {id:'D',width:10,height:8,rotatable:false,pins:[{id:'p',x:-5,y:0}]}
],nets:[
  {id:'N1',pins:[{componentId:'A',pinId:'p'},{componentId:'B',pinId:'p'}]},
  {id:'N2',pins:[{componentId:'C',pinId:'p'},{componentId:'D',pinId:'p'}]}
]};
const problem=normalizeProblem(input);
const scorer=new PriorityCpuBatchScorer(problem,{weights:{hpwl:1,overlap:5000,bounds:5000,congestion:0},coarse:{gridWidth:10,gridHeight:7,capacity:2}});

test('FastDeltaLnsOptimizer improves a poor placement', async()=>{
  const initial=[{x:10,y:10,rotation:0},{x:90,y:60,rotation:0},{x:12,y:12,rotation:0},{x:88,y:58,rotation:0}];
  const [before]=await scorer.scoreLayouts([initial]);
  const opt=new FastDeltaLnsOptimizer(problem,scorer,{iterations:30,population:128,topK:8,movesPerCandidate:1,translationScale:12,seed:3,
    approximate:{weights:{hpwl:1,overlap:5000,bounds:5000,congestion:0},coarse:{gridWidth:10,gridHeight:7,capacity:2}}});
  const out=await opt.optimize(initial);
  assert.ok(out.score.total < before.total, `${out.score.total} !< ${before.total}`);
  assert.equal(out.layout.length,4);
});
