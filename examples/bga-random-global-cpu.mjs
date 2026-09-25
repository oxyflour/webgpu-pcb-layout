import fs from 'node:fs';
import { normalizeProblem } from '../src/problem.js';
import { CpuBatchScorer } from '../src/cpu/batch-scorer.js';
import { CpuGridRouter } from '../src/cpu/grid-router.js';
import { AnalyticalGlobalPlacer } from '../src/optimizer/global-placement.js';
import { GpuLnsOptimizer } from '../src/optimizer/lns.js';
import { GpuNegotiatedRouter } from '../src/router/negotiated-router.js';

function rng32(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
const seed=Number(process.argv[3] ?? 31415926);const rnd=rng32(seed);
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
const input={canvas,components,nets};const problem=normalizeProblem(input);
const initialLayout=problem.components.map((c)=>{
  if(c.fixed)return {...c.fixed};
  const margin=8;return{x:margin+rnd()*(canvas.width-2*margin),y:margin+rnd()*(canvas.height-2*margin),rotation:0};
});
const scorer=new CpuBatchScorer(problem,{weights:{hpwl:1,overlap:4500,bounds:4500,congestion:8},coarse:{gridWidth:40,gridHeight:30,capacity:1}});
const initialScore=(await scorer.scoreLayouts([initialLayout]))[0];

// Baseline: the repository's old local LNS directly from the same fully random seed.
const baselineOpt=new GpuLnsOptimizer(problem,scorer,{iterations:90,population:512,movesPerCandidate:3,translationScale:5.0,rotationProbability:0,temperature:0.05,cooling:0.972,seed:seed^0xA5A5});
const baseline=await baselineOpt.optimize(initialLayout);

const globalFrames=[];
const global=new AnalyticalGlobalPlacer(problem,{iterations:800,wireStrength:1.15,densityStrength:0.80,overlapStrength:3.8,macroStrength:7.0,boundaryStrength:2.5,clearance:3,macroClearance:6,egressGap:8,fixedAnchorBoost:5.0,movableNetScale:0.70,damping:0.66,step:0.60,maxMove:2.5,cooling:0.9985,recordEvery:8,onIteration:async row=>{globalFrames.push({iteration:row.iteration,layout:row.layout});}});
const globalResult=await global.optimize(initialLayout);
const globalScore=(await scorer.scoreLayouts([globalResult.layout]))[0];

const lnsFrames=[];
const optimizer=new GpuLnsOptimizer(problem,scorer,{iterations:110,population:768,movesPerCandidate:2,translationScale:4.0,rotationProbability:0,temperature:0.04,cooling:0.976,seed:seed^0x55AA});
const optimized=await optimizer.optimize(globalResult.layout,async row=>{if(row.iteration===0||row.iteration%4===3||row.iteration===109)lnsFrames.push({iteration:row.iteration,layout:row.bestLayout,score:row.bestScore});});

function scaleFromCenter(layout,factor){return layout.map((p,i)=>problem.components[i].fixed?{...p}:{x:cx+(p.x-cx)*factor,y:cy+(p.y-cy)*factor,rotation:p.rotation});}
async function routeLayout(layout,seedBase){
  const router=new GpuNegotiatedRouter(null,problem,{waveRouter:new CpuGridRouter(),gridWidth:160,gridHeight:120,componentClearance:0.7,wireClearanceCells:0,escapeCells:12,maxRounds:22,presentFactor:4,historyFactor:10,seed:seedBase});
  return await router.route(layout);
}
const baselineRouting=await routeLayout(baseline.layout,seed^0x1234);
const attempts=[];let finalLayout=null,finalRouting=null;
for(const factor of [1.00,1.04,1.08,1.12,1.16,1.20,1.25,1.30,1.35,1.40]){
  const candidate=scaleFromCenter(optimized.layout,factor);const routing=await routeLayout(candidate,seed^0xBEEF);
  attempts.push({factor,status:routing.status,failedNets:routing.failedNets??0,conflicts:routing.conflicts??0,rounds:routing.rounds});
  if(routing.status==='routed'){finalLayout=candidate;finalRouting=routing;break;}
}
if(!finalRouting){finalLayout=scaleFromCenter(optimized.layout,1.40);finalRouting=await routeLayout(finalLayout,seed^0xDEAD);}
const finalScore=(await scorer.scoreLayouts([finalLayout]))[0];
const out={meta:{description:'Fully random BGA placement using repository AnalyticalGlobalPlacer + LNS + negotiated router',seed,backend:'CPU reference for this container'},input,initialLayout,initialScore,baseline:{score:baseline.score,layout:baseline.layout,routing:{status:baselineRouting.status,failedNets:baselineRouting.failedNets??0,conflicts:baselineRouting.conflicts??0,rounds:baselineRouting.rounds}},globalFrames,globalLayout:globalResult.layout,globalScore,lnsFrames,optimizedLayout:optimized.layout,optimizedScore:optimized.score,legalizationAttempts:attempts,finalLayout,finalScore,routing:finalRouting};
const path=process.argv[2]??'/mnt/data/bga-random-global-trace.json';fs.writeFileSync(path,JSON.stringify(out,null,2));
console.log(JSON.stringify({path,seed,initialScore,baseline:{score:baseline.score,routing:out.baseline.routing},globalScore,optimizedScore:optimized.score,attempts,final:{score:finalScore,routing:{status:finalRouting.status,failedNets:finalRouting.failedNets??0,conflicts:finalRouting.conflicts??0,rounds:finalRouting.rounds}}},null,2));
