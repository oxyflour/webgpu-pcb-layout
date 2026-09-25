import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, analyzeTopology } from '../src/index.js';

async function topoloomAvailable(){try{await import('@khalidsaidi/topoloom');return true;}catch{return false;}}
function comp(id){return{id,width:10,height:10,pins:[0,1,2].map(i=>({id:`p${i}`,x:i===0?-5:i===1?5:0,y:i===2?5:-5}))};}
function k33Problem(){
  const components=[comp('L0'),comp('L1'),comp('L2'),comp('R0'),comp('R1'),comp('R2')];
  const nets=[];
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)nets.push({id:`e${i}${j}`,pins:[{componentId:`L${i}`,pinId:`p${j}`},{componentId:`R${j}`,pinId:`p${i}`}]});
  return{canvas:{width:200,height:120},components,nets};
}

test('pin-order-aware topology accepts a simple planar case',async t=>{
  if(!(await topoloomAvailable()))return t.skip('dependency not installed in source-only validation environment');
  const p=normalizeProblem({canvas:{width:100,height:80},components:[
    {id:'A',width:10,height:10,pins:[{id:'p',x:5,y:0}]},{id:'B',width:10,height:10,pins:[{id:'p',x:-5,y:0}]}
  ],nets:[{id:'N',pins:[{componentId:'A',pinId:'p'},{componentId:'B',pinId:'p'}]}]});
  const r=await analyzeTopology(p); assert.equal(r.planar,true);
});

test('K3,3 subdivision is rejected before geometry optimization',async t=>{
  if(!(await topoloomAvailable()))return t.skip('dependency not installed in source-only validation environment');
  const r=await analyzeTopology(normalizeProblem(k33Problem()));
  assert.equal(r.planar,false);
});
