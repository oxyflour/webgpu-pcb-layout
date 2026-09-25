import fs from 'node:fs';
import { normalizeProblem } from '../src/problem.js';
import { CpuBatchScorer } from '../src/cpu/batch-scorer.js';
import { CpuGridRouter } from '../src/cpu/grid-router.js';
import { GpuLnsOptimizer } from '../src/optimizer/lns.js';
import { GpuNegotiatedRouter } from '../src/router/negotiated-router.js';

function rng32(seed){let x=seed>>>0||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return(x>>>0)/4294967296;};}
const rnd=rng32(20260923);

const canvas={width:160,height:120};
const cx=80,cy=60;
const bgaSize=48;
const rows=8,cols=8,padMargin=5,pitch=(bgaSize-2*padMargin)/(cols-1);
const bgaPins=[];
for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const x=-bgaSize/2+padMargin+c*pitch;
  const y=-bgaSize/2+padMargin+r*pitch;
  const ds=[['top',Math.abs(y+bgaSize/2),[0,-1]],['bottom',Math.abs(y-bgaSize/2),[0,1]],['left',Math.abs(x+bgaSize/2),[-1,0]],['right',Math.abs(x-bgaSize/2),[1,0]]].sort((a,b)=>a[1]-b[1])[0];
  bgaPins.push({id:`P${r}_${c}`,x,y,side:ds[0],normal:ds[2]});
}

const components=[{id:'U0_BGA',width:bgaSize,height:bgaSize,rotatable:false,fixed:{x:cx,y:cy,rotation:0},pins:bgaPins}];
const ring=[];
function makePeripheral(id,side,nominal){
  const horizontal=side==='top'||side==='bottom';
  const w=horizontal?11:7,h=horizontal?7:11;
  let pins;
  if(side==='top') pins=[
    {id:'chipA',x:-2.3,y:h/2,side:'bottom'},{id:'chipB',x:2.3,y:h/2,side:'bottom'},
    {id:'prev',x:-w/2,y:0,side:'left'},{id:'next',x:w/2,y:0,side:'right'}];
  if(side==='right') pins=[
    {id:'chipA',x:-w/2,y:-2.3,side:'left'},{id:'chipB',x:-w/2,y:2.3,side:'left'},
    {id:'prev',x:0,y:-h/2,side:'top'},{id:'next',x:0,y:h/2,side:'bottom'}];
  if(side==='bottom') pins=[
    {id:'chipA',x:2.3,y:-h/2,side:'top'},{id:'chipB',x:-2.3,y:-h/2,side:'top'},
    {id:'prev',x:w/2,y:0,side:'right'},{id:'next',x:-w/2,y:0,side:'left'}];
  if(side==='left') pins=[
    {id:'chipA',x:w/2,y:2.3,side:'right'},{id:'chipB',x:w/2,y:-2.3,side:'right'},
    {id:'prev',x:0,y:h/2,side:'bottom'},{id:'next',x:0,y:-h/2,side:'top'}];
  components.push({id,width:w,height:h,rotatable:false,pins});
  ring.push({id,side,nominal,index:components.length-1});
}

[50,70,90,110].forEach((x,i)=>makePeripheral(`T${i}`,'top',{x,y:22}));
[35,52,68,85].forEach((y,i)=>makePeripheral(`R${i}`,'right',{x:128,y}));
[110,90,70,50].forEach((x,i)=>makePeripheral(`B${i}`,'bottom',{x,y:98}));
[85,68,52,35].forEach((y,i)=>makePeripheral(`L${i}`,'left',{x:32,y}));

const nets=[];
// Peripheral-to-peripheral direct ring connections.
for(let i=0;i<ring.length;i++){
  const a=ring[i],b=ring[(i+1)%ring.length];
  nets.push({id:`RING_${a.id}_${b.id}`,pins:[{componentId:a.id,pinId:'next'},{componentId:b.id,pinId:'prev'}]});
}

// 24 BGA spokes: six orderly escape pads on each package side, distributed 2/2/1/1 to four nearby peripherals.
const groups={
  top:{comps:ring.slice(0,4),pads:[1,2,3,4,5,6].map(c=>`P0_${c}`)},
  right:{comps:ring.slice(4,8),pads:[1,2,3,4,5,6].map(r=>`P${r}_7`)},
  bottom:{comps:ring.slice(8,12),pads:[6,5,4,3,2,1].map(c=>`P7_${c}`)},
  left:{comps:ring.slice(12,16),pads:[6,5,4,3,2,1].map(r=>`P${r}_0`)}
};
for(const [side,g] of Object.entries(groups)){
  let k=0;
  for(let i=0;i<4;i++){
    const count=i<2?2:1;
    for(let q=0;q<count;q++){
      const pinId=q===0?'chipA':'chipB';
      nets.push({id:`BGA_${side}_${i}_${q}`,pins:[{componentId:'U0_BGA',pinId:g.pads[k++]},{componentId:g.comps[i].id,pinId}]});
    }
  }
}

const input={canvas,components,nets};
const problem=normalizeProblem(input);

// Deliberately noisy starting positions. U0_BGA is fixed; all others are optimized by the repository LNS.
const initialLayout=problem.components.map((c,i)=>{
  if(c.fixed)return {...c.fixed};
  const r=ring.find(x=>x.index===i);
  let x=r.nominal.x+(rnd()-.5)*8;
  let y=r.nominal.y+(rnd()-.5)*8;
  // Intentionally squeeze a few neighboring pairs to create overlap/congestion.
  if(['T1','T2'].includes(c.id))x+=(c.id==='T1'?3:-3);
  if(['R1','R2'].includes(c.id))y+=(c.id==='R1'?3:-3);
  if(['B1','B2'].includes(c.id))x+=(c.id==='B1'?-3:3);
  return {x,y,rotation:0};
});

const scorer=new CpuBatchScorer(problem,{weights:{hpwl:1,overlap:4500,bounds:4500,congestion:8},coarse:{gridWidth:40,gridHeight:30,capacity:1}});
const optFrames=[];
const optimizer=new GpuLnsOptimizer(problem,scorer,{iterations:90,population:512,movesPerCandidate:2,translationScale:3.8,rotationProbability:0,temperature:0.035,cooling:0.972,seed:90210});
const optimized=await optimizer.optimize(initialLayout,async row=>{
  if(row.iteration===0 || row.iteration%3===2 || row.iteration===89)optFrames.push({iteration:row.iteration,layout:row.bestLayout,score:row.bestScore});
});

function radialScale(layout,factor){
  return layout.map((p,i)=>{
    if(problem.components[i].fixed)return {...p};
    return {x:cx+(p.x-cx)*factor,y:cy+(p.y-cy)*factor,rotation:p.rotation};
  });
}

const attempts=[];
let finalLayout=optimized.layout,finalRouting=null;
for(const factor of [1.00,1.04,1.08,1.12,1.16,1.20,1.25,1.30,1.35,1.40]){
  const candidate=radialScale(optimized.layout,factor);
  const roundFrames=[];
  const router=new GpuNegotiatedRouter(null,problem,{
    waveRouter:new CpuGridRouter(),gridWidth:160,gridHeight:120,
    componentClearance:0.7,wireClearanceCells:0,escapeCells:12,maxRounds:18,
    presentFactor:4,historyFactor:10,seed:7001,onRound:async r=>{
      roundFrames.push({round:r.round,failed:r.failed,conflicts:r.conflicts,metric:r.metric,routes:r.routes});
    }
  });
  const routing=await router.route(candidate);
  attempts.push({factor,status:routing.status,failedNets:routing.failedNets??0,conflicts:routing.conflicts??0,rounds:routing.rounds,roundFrames});
  if(routing.status==='routed'){finalLayout=candidate;finalRouting=routing;break;}
}
if(!finalRouting){
  const last=attempts.at(-1);throw new Error(`routing unresolved after legalization: ${JSON.stringify(last)}`);
}

const initialScore=(await scorer.scoreLayouts([initialLayout]))[0];
const finalScore=(await scorer.scoreLayouts([finalLayout]))[0];
const out={
  meta:{description:'BGA top-view actual repository algorithm run',backend:'CPU reference backend matching repository interfaces',components:components.length,nets:nets.length,bgaPads:bgaPins.length,connectedBgaPads:24},
  input,initialLayout,initialScore,optFrames,optimizedLayout:optimized.layout,optimizedScore:optimized.score,
  legalizationAttempts:attempts.map(({roundFrames,...x})=>x),finalLayout,finalScore,routing:finalRouting,
  routeRoundFrames:attempts.find(a=>a.status==='routed')?.roundFrames??[]
};
const path=process.argv[2]??'/mnt/data/bga-layout-trace.json';
fs.writeFileSync(path,JSON.stringify(out,null,2));
console.log(JSON.stringify({path,initialScore,optimizedScore:optimized.score,finalScore,legalizationAttempts:out.legalizationAttempts,routing:{status:finalRouting.status,rounds:finalRouting.rounds,conflicts:finalRouting.conflicts},components:components.length,nets:nets.length,pads:bgaPins.length},null,2));
