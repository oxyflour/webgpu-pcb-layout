import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, scoreLayoutCpu, buildAugmentedGraph } from '../src/index.js';

const input={canvas:{width:100,height:60},components:[
  {id:'A',width:20,height:10,pins:[{id:'p',x:10,y:0,side:'right'}]},
  {id:'B',width:20,height:10,pins:[{id:'p',x:-10,y:0,side:'left'}]}
],nets:[{id:'N',pins:[{componentId:'A',pinId:'p'},{componentId:'B',pinId:'p'}]}]};

test('normalization and CPU score',()=>{
  const p=normalizeProblem(input);
  const separated=[{x:20,y:30,rotation:0},{x:80,y:30,rotation:0}];
  const overlapping=[{x:40,y:30,rotation:0},{x:48,y:30,rotation:0}];
  const a=scoreLayoutCpu(p,separated),b=scoreLayoutCpu(p,overlapping);
  assert.equal(a.overlap,0);
  assert.ok(b.overlap>0);
  assert.ok(Number.isFinite(a.total));
});

test('augmented graph contains component hubs, pins and net vertices',()=>{
  const p=normalizeProblem(input); const g=buildAugmentedGraph(p);
  assert.ok(g.vertices.includes('c:0:hub'));
  assert.ok(g.vertices.includes('p:0'));
  assert.ok(g.vertices.includes('n:0'));
  assert.ok(g.edges.some(([a,b])=>a==='n:0'&&b==='p:0'));
});

test('a pin cannot belong to multiple nets',()=>{
  assert.throws(()=>normalizeProblem({...input,nets:[...input.nets,{id:'N2',pins:[{componentId:'A',pinId:'p'},{componentId:'B',pinId:'p'}]}]}),/multiple nets/);
});
