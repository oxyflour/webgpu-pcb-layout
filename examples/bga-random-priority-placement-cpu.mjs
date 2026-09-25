import fs from 'node:fs';
import { normalizeProblem } from '../src/problem.js';
import { PriorityCpuBatchScorer } from '../src/cpu/priority-batch-scorer.js';
import { AnalyticalGlobalPlacer } from '../src/optimizer/global-placement.js';
import { GpuLnsOptimizer } from '../src/optimizer/lns.js';
import { PriorityMultilayerRouter } from '../src/router/priority-multilayer-router.js';

function rng32(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
const seed=Number(process.argv[3] ?? 20260923);const rnd=rng32(seed);
const canvas={width:160,height:120};const cx=80,cy=60,bgaSize=48;
const rows=8,cols=8,padMargin=5,pitch=(bgaSize-2*padMargin)/(cols-1);const bgaPins=[];
for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const x=-bgaSize/2+padMargin+c*pitch,y=-bgaSize/2+padMargin+r*pitch;
  const ds=[['top',Math.abs(y+bgaSize/2),[0,-1]],['bottom',Math.abs(y-bgaSize/2),[0,1]],['left',Math.abs(x+bgaSize/2),[-1,0]],['right',Math.abs(x-bgaSize/2),[1,0]]].sort((a,b)=>a[1]-b[1])[0];
  bgaPins.push({id:`P${r}_${c}`,x,y,side:ds[0],normal:ds[2]});
}
const components=[{id:'U0_BGA',width:bgaSize,height:bgaSize,rotatable:false,fixed:{x:cx,y:cy,rotation:0},pins:bgaPins}];
const ring=[];
function makePeripheral(id,side){
  const horizontal=side==='top'||side==='bottom';const w=horizontal?11:7,h=horizontal?7:11;let pins;
  if(side==='top')pins=[{id:'chipA',x:-2.3,y:h/2,side:'bottom'},{id:'chipB',x:2.3,y:h/2,side:'bottom'},{id:'prev',x:-w/2,y:0,side:'left'},{id:'next',x:w/2,y:0,side:'right'}];
  if(side==='right')pins=[{id:'chipA',x:-w/2,y:-2.3,side:'left'},{id:'chipB',x:-w/2,y:2.3,side:'left'},{id:'prev',x:0,y:-h/2,side:'top'},{id:'next',x:0,y:h/2,side:'bottom'}];
  if(side==='bottom')pins=[{id:'chipA',x:2.3,y:-h/2,side:'top'},{id:'chipB',x:-2.3,y:-h/2,side:'top'},{id:'prev',x:w/2,y:0,side:'right'},{id:'next',x:-w/2,y:0,side:'left'}];
  if(side==='left')pins=[{id:'chipA',x:w/2,y:2.3,side:'right'},{id:'chipB',x:w/2,y:-2.3,side:'right'},{id:'prev',x:0,y:h/2,side:'bottom'},{id:'next',x:0,y:-h/2,side:'top'}];
  // Extra pins are used by low-priority cross-board nets; they influence placement only weakly.
  if(side==='top') pins.push({id:'auxA',x:-w*.22,y:-h/2,side:'top'},{id:'auxB',x:w*.22,y:-h/2,side:'top'});
  if(side==='bottom') pins.push({id:'auxA',x:w*.22,y:h/2,side:'bottom'},{id:'auxB',x:-w*.22,y:h/2,side:'bottom'});
  if(side==='left') pins.push({id:'auxA',x:-w/2,y:h*.22,side:'left'},{id:'auxB',x:-w/2,y:-h*.22,side:'left'});
  if(side==='right') pins.push({id:'auxA',x:w/2,y:-h*.22,side:'right'},{id:'auxB',x:w/2,y:h*.22,side:'right'});
  components.push({id,width:w,height:h,rotatable:false,pins});ring.push({id,side,index:components.length-1});
}
['T0','T1','T2','T3'].forEach(id=>makePeripheral(id,'top'));
['R0','R1','R2','R3'].forEach(id=>makePeripheral(id,'right'));
['B0','B1','B2','B3'].forEach(id=>makePeripheral(id,'bottom'));
['L0','L1','L2','L3'].forEach(id=>makePeripheral(id,'left'));
const nets=[];
for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length];nets.push({id:`RING_${a.id}_${b.id}`,pins:[{componentId:a.id,pinId:'next'},{componentId:b.id,pinId:'prev'}]});}
const groups={
 top:{comps:ring.slice(0,4),pads:[1,2,3,4,5,6].map(c=>`P0_${c}`)},
 right:{comps:ring.slice(4,8),pads:[1,2,3,4,5,6].map(r=>`P${r}_7`)},
 bottom:{comps:ring.slice(8,12),pads:[6,5,4,3,2,1].map(c=>`P7_${c}`)},
 left:{comps:ring.slice(12,16),pads:[6,5,4,3,2,1].map(r=>`P${r}_0`)}
};
for(const [side,g] of Object.entries(groups)){let k=0;for(let i=0;i<4;i++){const count=i<2?2:1;for(let q=0;q<count;q++){const pinId=q===0?'chipA':'chipB';nets.push({id:`BGA_${side}_${i}_${q}`,pins:[{componentId:'U0_BGA',pinId:g.pads[k++]},{componentId:g.comps[i].id,pinId}]});}}}
const chords=[
 ['X_T0_B2','T0','auxA','B2','auxA'],['X_T1_B3','T1','auxA','B3','auxA'],['X_T2_B0','T2','auxA','B0','auxA'],['X_T3_B1','T3','auxA','B1','auxA'],
 ['X_L0_R2','L0','auxA','R2','auxA'],['X_L1_R3','L1','auxA','R3','auxA'],['X_L2_R0','L2','auxA','R0','auxA'],['X_L3_R1','L3','auxA','R1','auxA'],
 ['X_T0_R2','T0','auxB','R2','auxB'],['X_T2_L0','T2','auxB','L0','auxB'],['X_B1_R3','B1','auxB','R3','auxB'],['X_B3_L2','B3','auxB','L2','auxB']
];
for(const [id,a,ap,b,bp] of chords)nets.push({id,pins:[{componentId:a,pinId:ap},{componentId:b,pinId:bp}]});

const policy={};
for(const n of nets){
  if(n.id.startsWith('BGA_'))policy[n.id]={priority:86};
  else if(n.id.startsWith('RING_'))policy[n.id]={priority:55};
  else policy[n.id]={priority:12};
}
const locked=['BGA_top_0_0','BGA_top_1_0','BGA_right_0_0','BGA_right_1_0','BGA_bottom_0_0','BGA_bottom_1_0','BGA_left_0_0','BGA_left_1_0'];
for(const id of locked)policy[id]={priority:100,topLocked:true,allowedLayers:['TOP']};
for(const id of ['RING_T0_T1','RING_R0_R1','RING_B0_B1','RING_L0_L1'])if(policy[id])policy[id].priority=72;

const input={canvas,components,nets};const problem=normalizeProblem(input);
const initialLayout=problem.components.map(c=>c.fixed?{...c.fixed}:{x:7+rnd()*(canvas.width-14),y:7+rnd()*(canvas.height-14),rotation:0});
const scorer=new PriorityCpuBatchScorer(problem,{policy,weights:{hpwl:1,overlap:5200,bounds:5200,congestion:4.5},coarse:{gridWidth:40,gridHeight:30,capacity:2.5},priorityScale:55,minNetWeight:.18,topLockedBoost:2.4});
const initialScore=(await scorer.scoreLayouts([initialLayout]))[0];
const weightForNet=(net)=>{const q=policy[net.id]??{priority:50};let w=.20+q.priority/58;if(q.topLocked)w*=2.4;return w;};
const globalFrames=[];
const global=new AnalyticalGlobalPlacer(problem,{iterations:950,wireStrength:.92,densityStrength:.86,overlapStrength:4.0,macroStrength:7.4,boundaryStrength:2.6,clearance:3.3,macroClearance:6.5,egressGap:8.5,fixedAnchorBoost:4.8,movableNetScale:.72,damping:.66,step:.58,maxMove:2.45,cooling:.9986,recordEvery:8,netWeight:weightForNet,onIteration:async row=>globalFrames.push({iteration:row.iteration,layout:row.layout})});
const globalResult=await global.optimize(initialLayout);const globalScore=(await scorer.scoreLayouts([globalResult.layout]))[0];
const lnsFrames=[];
const lns=new GpuLnsOptimizer(problem,scorer,{iterations:120,population:768,movesPerCandidate:2,translationScale:3.2,rotationProbability:0,temperature:.035,cooling:.978,seed:seed^0x51A2});
const refined=await lns.optimize(globalResult.layout,async row=>{if(row.iteration===0||row.iteration%4===3||row.iteration===119)lnsFrames.push({iteration:row.iteration,layout:row.bestLayout,score:row.bestScore});});

// Placement is the deliverable. Routing is run ONCE afterward only as acceptance/diagnostic feedback.
const verifier=new PriorityMultilayerRouter(input,refined.layout,{policy,layers:[{id:'TOP',blockComponents:true},{id:'L2',blockComponents:false},{id:'L3',blockComponents:false},{id:'L4',blockComponents:false},{id:'L5',blockComponents:false},{id:'BOTTOM',blockComponents:true}],gridWidth:96,gridHeight:72,componentClearance:.7,wireClearanceCells:0,escapeCells:12,maxRounds:7,presentFactor:4,historyFactor:10,seed:seed^0x73AB});
const verify=await verifier.route();
const counts={};for(const [id,lid] of Object.entries(verify.assignment??{}))counts[lid]=(counts[lid]??0)+1;
const topLockedKept=locked.filter(id=>verify.assignment?.[id]==='TOP').length;
const out={meta:{description:'Fully random priority-aware placement demo; routing used only as final validation',seed,backend:'CPU reference in this container'},input,policy,initialLayout,initialScore,globalFrames,globalLayout:globalResult.layout,globalScore,lnsFrames,finalLayout:refined.layout,finalScore:refined.score,validation:{status:verify.status,unassigned:verify.unassigned??[],layerCounts:counts,topLockedKept,totalTopLocked:locked.length}};
const outPath=process.argv[2]??'/mnt/data/bga-random-priority-placement-trace.json';fs.writeFileSync(outPath,JSON.stringify(out,null,2));
console.log(JSON.stringify({outPath,seed,initialScore,globalScore,finalScore:refined.score,validation:out.validation},null,2));
