import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, GpuNegotiatedRouter } from '../src/index.js';
import { getGpuOrSkip } from './gpu-helper.mjs';

test('negotiated router produces conflict-free routes for a multi-net case',async t=>{
  const device=await getGpuOrSkip(t);if(!device)return;
  const problem=normalizeProblem({canvas:{width:100,height:60},components:[
    {id:'A',width:12,height:24,pins:[{id:'n1',x:6,y:-6,side:'right'},{id:'n2',x:6,y:6,side:'right'}]},
    {id:'B',width:12,height:24,pins:[{id:'n1',x:-6,y:-6,side:'left'},{id:'n2',x:-6,y:6,side:'left'}]}
  ],nets:[
    {id:'N1',pins:[{componentId:'A',pinId:'n1'},{componentId:'B',pinId:'n1'}]},
    {id:'N2',pins:[{componentId:'A',pinId:'n2'},{componentId:'B',pinId:'n2'}]}
  ]});
  const layout=[{x:15,y:30,rotation:0},{x:85,y:30,rotation:0}];
  const router=new GpuNegotiatedRouter(device,problem,{gridWidth:64,gridHeight:40,wireClearanceCells:1,maxRounds:8,maxWaveIterations:180});
  const r=await router.route(layout); assert.equal(r.status,'routed');assert.equal(r.conflicts,0);assert.ok(r.routes.every(x=>x.ok));device.destroy();
});
