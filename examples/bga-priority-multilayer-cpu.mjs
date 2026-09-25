import fs from 'node:fs';
import { normalizeProblem } from '../src/problem.js';
import { CpuGridRouter } from '../src/cpu/grid-router.js';
import { GpuNegotiatedRouter } from '../src/router/negotiated-router.js';
import { PriorityMultilayerRouter } from '../src/router/priority-multilayer-router.js';

const baseTracePath=process.argv[2] ?? '/mnt/data/bga-random-global-trace.json';
const outPath=process.argv[3] ?? '/mnt/data/bga-priority-multilayer-trace.json';
const base=JSON.parse(fs.readFileSync(baseTracePath,'utf8'));
const input=structuredClone(base.input);
const layout=structuredClone(base.finalLayout);

// Add two previously-unused routing pins to every peripheral component. These
// create intentionally crossing/chord-style low-priority nets without changing
// the placement geometry produced by the repository's earlier random/global run.
function auxPins(c){
  const id=c.id;const side=id[0];const w=c.width,h=c.height;
  if(side==='T') return [
    {id:'auxA',x:-w*0.22,y:-h/2,side:'top'}, {id:'auxB',x:w*0.22,y:-h/2,side:'top'}];
  if(side==='B') return [
    {id:'auxA',x:w*0.22,y:h/2,side:'bottom'}, {id:'auxB',x:-w*0.22,y:h/2,side:'bottom'}];
  if(side==='L') return [
    {id:'auxA',x:-w/2,y:h*0.22,side:'left'}, {id:'auxB',x:-w/2,y:-h*0.22,side:'left'}];
  if(side==='R') return [
    {id:'auxA',x:w/2,y:-h*0.22,side:'right'}, {id:'auxB',x:w/2,y:h*0.22,side:'right'}];
  return [];
}
for(const c of input.components) if(c.id!=='U0_BGA') c.pins.push(...auxPins(c));

const chords=[
  ['X_T0_B2','T0','auxA','B2','auxA'],
  ['X_T1_B3','T1','auxA','B3','auxA'],
  ['X_T2_B0','T2','auxA','B0','auxA'],
  ['X_T3_B1','T3','auxA','B1','auxA'],
  ['X_L0_R2','L0','auxA','R2','auxA'],
  ['X_L1_R3','L1','auxA','R3','auxA'],
  ['X_L2_R0','L2','auxA','R0','auxA'],
  ['X_L3_R1','L3','auxA','R1','auxA'],
  ['X_T0_R2','T0','auxB','R2','auxB'],
  ['X_T2_L0','T2','auxB','L0','auxB'],
  ['X_B1_R3','B1','auxB','R3','auxB'],
  ['X_B3_L2','B3','auxB','L2','auxB'],
];
for(const [id,a,ap,b,bp] of chords) input.nets.push({id,pins:[{componentId:a,pinId:ap},{componentId:b,pinId:bp}]});

// Surface priority policy. Critical BGA escape nets are hard-locked to TOP;
// remaining BGA nets are strongly surface-preferred, ring links are medium,
// and long chord nets are cheap to sink to inner layers.
const policy={};
for(const n of input.nets){
  if(n.id.startsWith('BGA_')) policy[n.id]={priority:86};
  else if(n.id.startsWith('RING_')) policy[n.id]={priority:55};
  else if(n.id.startsWith('X_')) policy[n.id]={priority:12};
}
const locked=[
  'BGA_top_0_0','BGA_top_1_0','BGA_right_0_0','BGA_right_1_0',
  'BGA_bottom_0_0','BGA_bottom_1_0','BGA_left_0_0','BGA_left_1_0'
];
for(const id of locked) if(policy[id]) policy[id]={priority:100,topLocked:true,allowedLayers:['TOP']};
// A few surface-sensitive peripheral links outrank ordinary ring connections.
for(const id of ['RING_T0_T1','RING_R0_R1','RING_B0_B1','RING_L0_L1']) if(policy[id]) policy[id].priority=72;

const fullProblem=normalizeProblem(input);
async function routeFullTop(){
  const router=new GpuNegotiatedRouter(null,fullProblem,{waveRouter:new CpuGridRouter(),gridWidth:112,gridHeight:84,componentClearance:0.7,wireClearanceCells:0,escapeCells:12,maxRounds:10,presentFactor:4,historyFactor:10,seed:0x551122,blockComponents:true});
  return await router.route(layout);
}
const allTop=await routeFullTop();

const decisionFrames=[];
const allocator=new PriorityMultilayerRouter(input,layout,{
  policy,
  layers:[
    {id:'TOP',blockComponents:true},
    {id:'L2',blockComponents:false},
    {id:'L3',blockComponents:false},
    {id:'BOTTOM',blockComponents:true}
  ],
  gridWidth:96,gridHeight:72,componentClearance:0.7,wireClearanceCells:0,escapeCells:12,maxRounds:7,presentFactor:4,historyFactor:10,seed:0x778899,
  onDecision: async row=>{
    if(row.accepted===false || row.priority>=72 || decisionFrames.length%4===0) decisionFrames.push(row);
  }
});
const allocation=await allocator.route();

// Re-route the final assignment at a higher resolution so the exported GIF
// shows actual final per-layer polylines, not the coarse feasibility trials.
const highRes=[];
for(let li=0;li<allocation.routesByLayer.length;li++){
  const lr=allocation.routesByLayer[li];
  if(!lr.netIds.length){highRes.push({...lr,route:{status:'routed',routes:[],conflicts:0,rounds:0}});continue;}
  const keep=new Set(lr.netIds);
  const sub=normalizeProblem({canvas:input.canvas,components:input.components,nets:input.nets.filter(n=>keep.has(n.id))});
  const router=new GpuNegotiatedRouter(null,sub,{waveRouter:new CpuGridRouter(),gridWidth:144,gridHeight:108,componentClearance:0.65,wireClearanceCells:0,escapeCells:14,maxRounds:16,presentFactor:4,historyFactor:11,seed:0x9900+li*101,blockComponents:lr.blockComponents});
  const rr=await router.route(layout);
  highRes.push({...lr,route:rr});
}

const layerSummary=highRes.map(x=>({layer:x.layer,netCount:x.netIds.length,prioritySum:x.netIds.reduce((s,id)=>s+(policy[id]?.priority??50),0),status:x.route.status,failedNets:x.route.failedNets??0,conflicts:x.route.conflicts??0,rounds:x.route.rounds}));
const assignment=allocation.assignment;
const vias=[];
for(const n of input.nets){
  const layer=assignment[n.id];if(!layer||layer==='TOP')continue;
  for(const ref of n.pins) vias.push({netId:n.id,layer,componentId:ref.componentId,pinId:ref.pinId});
}

const out={meta:{description:'Priority-aware multilayer routing demo using repository negotiated router for layer feasibility and final per-layer routes',sourceTrace:baseTracePath,backend:'CPU reference in this container'},input,layout,policy,allTop:{status:allTop.status,failedNets:allTop.failedNets??0,conflicts:allTop.conflicts??0,rounds:allTop.rounds},decisionFrames,allocation:{status:allocation.status,unassigned:allocation.unassigned??[],assignment,decisions:allocation.decisions},layers:highRes,layerSummary,vias};
fs.writeFileSync(outPath,JSON.stringify(out,null,2));
console.log(JSON.stringify({outPath,allTop:out.allTop,allocationStatus:allocation.status,layerSummary,viaCount:vias.length,unassigned:allocation.unassigned??[]},null,2));
