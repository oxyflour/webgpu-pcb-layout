import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {args,readJson,writeJson,sha} from './io.mjs';
import {initSession} from './init.mjs';
import {parseKicadBoard,designToProblem,normalizeProblem,runtimeRoot} from './runtime.mjs';
const a=args(),out=path.resolve(a.out),board=a.board??'pico',boardFile=path.resolve(a.file??'C:/Projects/webgpu_pcb_placer/benchmark/ciaa-Hardware/PCB/pico/picociaa.kicad_pcb');
if(fs.existsSync(out))throw Error('Use a fresh experiment directory');fs.mkdirSync(out,{recursive:true});
const data=path.join(out,'data');fs.mkdirSync(data);const copy=path.join(data,board+'.kicad_pcb');fs.copyFileSync(boardFile,copy);
const adapted=designToProblem(parseKicadBoard(fs.readFileSync(copy,'utf8'),board),{preplace:true,sides:'original'}),problem=normalizeProblem(adapted.input);
const teacherRefs=problem.components.filter(c=>!c.fixed&&/^U\d/.test(c.id)).sort((a,b)=>b.pins.length-a.pins.length).slice(0,board==='k60'?3:2).map(c=>c.id);
const teacher=teacherRefs.map(ref=>{const i=problem.components.findIndex(c=>c.id===ref),p=adapted.originalLayout[i];return {ref,x:p.x,y:p.y,rotation:p.rotation*90,side:p.side?'bottom':'top'};});
const shared='Improve this whole board from seeded uniform movable positions. All fixed mechanical/through-hole positions and assigned sides are given task constraints. Use Cypress for every optimization. Inspect pin connectivity and physical pad geometry, and consider main IC fanout to fixed connectors. You have at most two new Cypress place calls. Record DECISIONS.json. First evaluate one specific floorplan, then use measured failed/high-via nets for a bounded repair when plausible. Keep a useful floorplan during local repair. No human small-part coordinates or numerical motif offsets are available.';
const contexts={control:{exposure:'task-only',provenance:'Board netlist, physical footprints and declared mechanical/side constraints; no human movable poses',text:shared+' Infer IC positions and rotations from input yourself.'},teacher:{exposure:'human-key-poses',provenance:`Exactly ${teacherRefs.length} main IC poses from this board human layout; all other movable positions remain unknown`,text:shared+' LIMITED HUMAN KEY INFORMATION: '+JSON.stringify(teacher)+'. These are complete main-IC body-centre poses from the reference. Use them as exact held targets in at least one Cypress solve. Infer the surrounding components from the netlist; do not assume their hidden human positions. Disclose this assistance.'}};
for(const [arm,context]of Object.entries(contexts))writeJson(path.join(out,arm+'-context.json'),context);
writeJson(path.join(out,'human-layout-private.json'),{layout:adapted.originalLayout,provenance:'Offline evaluation only; inaccessible through model gateway'});
const seeds=[1000,8919,16838],minutes=Number(a.minutes??7);
const plan={board,seeds,replicas:3,arms:['control','teacher'],maxPlaces:2,minutesPerAgent:minutes,concurrency:1,gpuPolicy:'Sequential dsh sessions and Cypress CUDA jobs; no overlapping DREAMPlace.log writers',teacherRefs,boardSha256:sha(fs.readFileSync(copy)),runtime:runtimeRoot,engine:'NVIDIA Cypress',pipeline:'cypress+shared-legalize',cudaSolveSeconds:120,workerSeconds:165,toolSeconds:175,solverConfig:'Existing adapter config with crossing disabled; power/ground restored and current rotations baked. HPWL/density/rotation remain Cypress',order:['control','teacher','teacher','control','control','teacher'],description:'Three matched seeded starts per condition. Same prompt, tools, CUDA config and solver-seed sequence. Only explicit teacher text differs. No claim of statistical significance.'};
plan.enginePatches='Crossing flag respected in iteration evaluation/rotation selection; post-solve FLUTE diagnostic excludes degree >=150 at its compiled MAXD limit. CUDA optimization retains every electrical pin.';
writeJson(path.join(out,'protocol.json'),plan);
const records=[];
for(let i=0;i<3;i++){
  const start=path.join(out,'starts','rep'+(i+1));initSession(start,{board,boardFile:copy,seed:seeds[i]});
  const arms=i===1?['teacher','control']:['control','teacher'];
  for(const arm of arms){
    const dir=path.join(out,`rep${i+1}-${arm}`),fd=fs.openSync(dir+'.log','wx');
    console.log(`rep${i+1}-${arm}: dsh / DeepSeek Flash + NVIDIA Cypress; seed ${seeds[i]}`);
    const child=spawn(process.execPath,[path.join(import.meta.dirname,'run-agent.mjs'),'--resume',start,'--context',path.join(out,arm+'-context.json'),'--minutes',String(minutes),'--runs','2','--out',dir],{stdio:['ignore',fd,fd],windowsHide:true});fs.closeSync(fd);
    const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    const summary=fs.existsSync(path.join(dir,'summary.json'))?readJson(path.join(dir,'summary.json')):{error:'Missing summary',exitCode};
    records.push({rep:i+1,arm,seed:seeds[i],dir,summary});writeJson(path.join(out,'experiment.json'),{complete:records.length===6,records});
    console.log(JSON.stringify({rep:i+1,arm,exitCode,best:summary.best?.metrics??null,seconds:summary.seconds,stop:summary.stopReason}));
    if(summary.sourceHashBefore!==summary.sourceHashAfter)throw Error('Source changed during experiment; stop comparison');
  }
}
