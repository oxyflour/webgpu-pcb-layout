import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {args,readJson,writeJson,sha} from './io.mjs';
import {initSession} from './init.mjs';
import {parseKicadBoard,designToProblem,runtimeRoot} from './runtime.mjs';
const a=args(),out=path.resolve(a.out),board='k60',boardFile=path.resolve(a.file??'C:/Projects/webgpu_pcb_placer/benchmark/ciaa-Hardware/PCB/FSL/CIAA_K60/CIAA_K60.kicad_pcb');
if(fs.existsSync(out))throw Error('Use a fresh comparison directory');fs.mkdirSync(out,{recursive:true});
const data=path.join(out,'data');fs.mkdirSync(data);const copy=path.join(data,board+'.kicad_pcb');fs.copyFileSync(boardFile,copy);
const adapted=designToProblem(parseKicadBoard(fs.readFileSync(copy,'utf8'),board),{preplace:true,sides:'original'});
writeJson(path.join(out,'human-layout-private.json'),{layout:adapted.originalLayout,provenance:'Offline reference only; neither condition receives human movable poses'});
const task='K60, with the original assigned sides and fixed mechanical/through-hole positions as declared constraints. All movable positions begin from the same seeded uniform start. No human movable coordinates are supplied. At most two NVIDIA Cypress solves; same predetermined seed sequence, CUDA configuration, shared legalizer, routing, ranking and nine-minute session budget in both conditions.';
const contexts={cypress:{exposure:'task-only',provenance:'Fixed global Cypress sequence; gateway forbids placement-advisor inputs',text:task+' Execute only the fixed two global-solve/score sequence; no placement advice.'},harness:{exposure:'task-only',provenance:'Netlist, physical pads and declared constraints; no human movable poses',text:task+' Infer a main-IC floorplan from the real connector/pad correspondence, preview it, then use Cypress to optimize remaining parts. Score each saved candidate, and use measured diagnostics for one bounded repair when useful. Reserve enough time to score and report the first candidate.'}};
for(const [arm,context]of Object.entries(contexts))writeJson(path.join(out,arm+'-context.json'),context);
const seeds=[1000,8919,16838],minutes=9;
const plan={board,seeds,replicas:3,arms:['cypress','harness'],comparison:'standalone-cypress-versus-harness',maxPlaces:2,minutesPerAgent:minutes,concurrency:1,teacherRefs:[],boardSha256:sha(fs.readFileSync(copy)),runtime:runtimeRoot,engine:'NVIDIA Cypress',pipeline:'cypress+shared-legalize',cudaSolveSeconds:120,workerSeconds:165,toolSeconds:175,solverConfig:'Identical HPWL/density/rotation Cypress preset; crossing flag disabled, complete electrical input retained',enginePatches:'Crossing flag respected in evaluation and rotation selection; only the post-solve FLUTE diagnostic excludes degree >=150',legalClearanceMm:.35,routeProtocol:'calibrated-full, actual pitch, 80 rounds',gpuPolicy:'Sequential dsh sessions and CUDA jobs',baseline:'Two fixed global solves, second warm-started from first output; gateway accepts only candidate input. dsh only executes the script.',harness:'dsh may inspect, infer targets/orientations and select a local repair; no human movable answers',order:['cypress','harness','harness','cypress','cypress','harness'],description:'Three matched starts; identical tool code, evaluator, seeds and solve/time limits. Counts all failures. Does not imply statistical significance or superiority to an optimally tuned Cypress baseline.'};
writeJson(path.join(out,'protocol.json'),plan);
const records=[];
for(let i=0;i<3;i++){
  const start=path.join(out,'starts','rep'+(i+1));initSession(start,{board,boardFile:copy,seed:seeds[i]});
  for(const arm of i===1?['harness','cypress']:['cypress','harness']){
    const dir=path.join(out,`rep${i+1}-${arm}`),fd=fs.openSync(dir+'.log','wx');
    console.log(`rep${i+1}-${arm}: dsh + NVIDIA Cypress, seed ${seeds[i]}`);
    const child=spawn(process.execPath,[path.join(import.meta.dirname,'run-agent.mjs'),'--resume',start,'--context',path.join(out,arm+'-context.json'),'--mode',arm,'--prompt',path.join(import.meta.dirname,'prompts',arm==='cypress'?'cypress-baseline.txt':'cypress-v1.txt'),'--minutes',String(minutes),'--runs','2','--out',dir],{stdio:['ignore',fd,fd],windowsHide:true});fs.closeSync(fd);
    const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    const summary=fs.existsSync(path.join(dir,'summary.json'))?readJson(path.join(dir,'summary.json')):{error:'Missing summary',exitCode};
    records.push({rep:i+1,arm,seed:seeds[i],dir,summary});writeJson(path.join(out,'experiment.json'),{complete:records.length===6,records});
    console.log(JSON.stringify({rep:i+1,arm,exitCode,best:summary.best?.metrics??null,seconds:summary.seconds,stop:summary.stopReason}));
    if(summary.sourceHashBefore!==summary.sourceHashAfter)throw Error('Source changed during comparison; stop');
  }
}
