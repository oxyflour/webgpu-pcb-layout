import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, scoreLayoutCpu, GpuBatchScorer } from '../src/index.js';
import { getGpuOrSkip } from './gpu-helper.mjs';

test('WebGPU batch scorer matches CPU reference',async t=>{
  const device=await getGpuOrSkip(t);if(!device)return;
  const problem=normalizeProblem({canvas:{width:100,height:70},components:[
    {id:'A',width:20,height:12,pins:[{id:'a',x:10,y:-3},{id:'b',x:10,y:3}]},
    {id:'B',width:16,height:18,pins:[{id:'a',x:-8,y:-4},{id:'b',x:-8,y:4}]},
    {id:'C',width:12,height:12,pins:[{id:'a',x:0,y:-6}]}
  ],nets:[
    {id:'N1',pins:[{componentId:'A',pinId:'a'},{componentId:'B',pinId:'a'},{componentId:'C',pinId:'a'}]},
    {id:'N2',pins:[{componentId:'A',pinId:'b'},{componentId:'B',pinId:'b'}]}
  ]});
  const layouts=[
    [{x:20,y:30,rotation:0},{x:75,y:32,rotation:0},{x:52,y:58,rotation:0}],
    [{x:42,y:30,rotation:1},{x:48,y:32,rotation:0},{x:52,y:58,rotation:2}],
    [{x:-3,y:5,rotation:0},{x:90,y:63,rotation:1},{x:50,y:35,rotation:0}]
  ];
  const scorer=new GpuBatchScorer(device,problem); const gpu=await scorer.scoreLayouts(layouts);
  layouts.forEach((l,i)=>{const cpu=scoreLayoutCpu(problem,l);for(const k of ['hpwl','overlap','bounds','congestion','total'])assert.ok(Math.abs(gpu[i][k]-cpu[k])<1e-3*Math.max(1,Math.abs(cpu[k])),`${k}: ${gpu[i][k]} vs ${cpu[k]}`);});
  scorer.destroy();device.destroy();
});
