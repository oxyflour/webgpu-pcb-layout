import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CYPRESS_RUNTIME??=path.resolve('results/runtime-cypress-v1');
const {bakeOrientation,exportIncremental,importIncremental}=await import('../harness/bridge.mjs');
const {normalizeProblem,worldPin}=await import('../harness/runtime.mjs');
const {withElectricalPower}=await import('../harness/board.mjs');
const {callTool}=await import('../harness/session.mjs');
const {writeJson,sha}=await import('../harness/io.mjs');
const {heldGeometry}=await import('../harness/held-geometry.mjs');
function fixture(rotation,side){
  const layout=[{x:15.123,y:10.789,rotation,side},{x:30,y:20,rotation:1,side:0}];
  const adapted={input:{canvas:{width:50,height:35},components:[{id:'A',width:3,height:5,sides:side?'bottom':'top',pins:[{id:'p0',x:.37,y:-1.2},{id:'p1',x:.8,y:.3}]},{id:'B',width:2,height:3,sides:'top',fixed:layout[1],pins:[{id:'p2',x:-.2,y:.9}]}],nets:[{id:'same-net',pins:[{componentId:'A',pinId:'p0'},{componentId:'A',pinId:'p1'},{componentId:'B',pinId:'p2'}]}]}};
  return {adapted,layout};
}
test('incremental baking preserves all original pin coordinates, dimensions, side and fixed poses',()=>{
  for(let r=0;r<4;r++)for(let s=0;s<2;s++){
    const {adapted,layout}=fixture(r,s),before=structuredClone({adapted,layout});
    const baked=bakeOrientation(adapted,layout,['A']),p=normalizeProblem(adapted.input),bp=normalizeProblem(baked.adapted.input);
    for(let pi=0;pi<p.pins.length;pi++)assert.deepEqual(worldPin(p,layout,pi),worldPin(bp,baked.initial,pi));
    assert.equal(bp.components[0].width,r%2?5:3);assert.equal(bp.components[0].rotatable,false);assert.deepEqual(bp.components[1].fixed,layout[1]);assert.deepEqual({adapted,layout},before);
  }
});
test('export quantization preserves duplicate node/net pins and import maps delta rotation correctly',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cypress-bridge-'));
  try{for(let r=0;r<4;r++)for(let s=0;s<2;s++){
    const {adapted,layout}=fixture(r,s),baked=exportIncremental(adapted,layout,dir,['A']);
    assert.equal(baked.bridge.expectedPins.length,3);assert.ok(baked.inputPinErrorMm<=.011);
    for(let delta=0;delta<4;delta++){
      const expected=layout.map((p,i)=>i?{...p}:{...p,x:17,y:12,rotation:(r+delta)%4}),problem=normalizeProblem(adapted.input);
      const placements=expected.map((p,i)=>({id:i?'B':'A',...p,rotation:i?p.rotation:delta}));
      const engine_pins=problem.nets.flatMap((n,ni)=>n.pins.map(pi=>{const [x,y]=worldPin(problem,expected,pi);return {id:problem.pins[pi].componentId,net:'n'+ni,x,y};}));
      assert.deepEqual(importIncremental(adapted,baked,{placements,engine_pins}).layout,expected);
      assert.throws(()=>importIncremental(adapted,baked,{placements,engine_pins:engine_pins.slice(1)}),/Missing final engine pin/);
    }
  }}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('power restoration retains every supplied pad and signal mapping without mutation',()=>{
  const f=fixture(3,1);f.adapted.power=[{name:'+3V3',pads:[{comp:0,padIndex:3,x:1,y:1},{comp:1,padIndex:4,x:0,y:1}]},{name:'GND',pads:[{comp:0,padIndex:5,x:-1,y:1},{comp:1,padIndex:6,x:0,y:-1}]}];
  const before=structuredClone(f.adapted),restored=withElectricalPower(f.adapted),p=normalizeProblem(restored.input);
  assert.equal(p.nets.length,3);assert.equal(p.pins.length,7);assert.deepEqual(restored.input.nets[0],f.adapted.input.nets[0]);assert.deepEqual(f.adapted,before);
});
test('held targets cannot hide conflicts behind the source fixed-fixed exemption',()=>{
  const {adapted,layout}=fixture(0,0),p=normalizeProblem(adapted.input);
  const invalid=layout.map(q=>({...q}));invalid[0].x=layout[1].x;invalid[0].y=layout[1].y;
  assert.equal(heldGeometry(p,invalid,[0]).passed,false);
  assert.deepEqual(heldGeometry(p,invalid,[0]).conflicts[0].refs,['A','B']);
  assert.equal(heldGeometry(p,layout,[0]).passed,true);
  assert.equal(heldGeometry(p,invalid,[]).passed,true);
  const back=fixture(0,1);assert.equal(heldGeometry(normalizeProblem(back.adapted.input),invalid.map((q,i)=>i?q:{...q,side:1}),[0]).passed,true);
});
test('invalid or stale candidate paths and unknown tool options are rejected before worker launch',async()=>{
  const ws=fs.mkdtempSync(path.join(os.tmpdir(),'cypress-session-'));
  try{const state={current:'c000',best:null,placeCalls:0,candidates:{c000:{id:'c000',file:'c000.json'}}};writeJson(path.join(ws,'session.json'),state);writeJson(path.join(ws,'c000.json'),fixture(0,0));const hash=sha(fs.readFileSync(path.join(ws,'session.json')));
    assert.match((await callTool(ws,'place',{candidate:'../other'})).error,/Unknown candidate/);
    assert.match((await callTool(ws,'place',{candidate:'c000',mode:'lns'})).error,/Unknown input key/);
    assert.equal(sha(fs.readFileSync(path.join(ws,'session.json'))),hash);
  }finally{fs.rmSync(ws,{recursive:true,force:true});}
});
