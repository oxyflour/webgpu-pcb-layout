import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {args,readJson,writeJson,sha} from '../harness/io.mjs';
import {stateOf,better} from '../harness/session.mjs';
import {runtimeRoot,repositoryMetrics} from '../harness/runtime.mjs';
import {loadBoard} from '../harness/board.mjs';
import {renderComparison} from './comparison-html.mjs';
const a=args(),out=path.resolve(a.out),experiment=readJson(path.join(out,'experiment.json')),plan=readJson(path.join(out,'protocol.json'));
if(!experiment.complete||experiment.records.length!==6)throw Error('All three repetitions of each condition must finish before reporting');
const require=createRequire(path.join(runtimeRoot,'package.json')),{Resvg}=require('@resvg/resvg-js');
const log=ws=>fs.readFileSync(path.join(ws,'tools.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
const verify=(state,candidate)=>new Promise(resolve=>{
  const child=fork(new URL('./reference-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,execArgv:[]});let reply,error;
  const timer=setTimeout(()=>{error='reference timeout';child.kill();},165000);child.on('message',r=>{reply=r;});child.on('error',e=>{error=e.message;});child.on('close',()=>{clearTimeout(timer);resolve(reply??{error:error??'missing reference output'});});child.stderr.on('data',()=>{});child.send({state,candidate});
});
const rerouteDir=path.join(out,'reroute');fs.mkdirSync(rerouteDir,{recursive:true});
const reroutes=new Map();
async function independentlyCheck(state,file,expected,label){
  const saved=readJson(file),hash=sha(JSON.stringify(saved.layout));
  let result=reroutes.get(hash);
  if(!result){
    const stem=path.join(rerouteDir,hash.slice(0,16)),json=stem+'.json';
    result=fs.existsSync(json)?readJson(json):await verify(state,file);
    if(!fs.existsSync(json)){const {svg,...record}=result;if(svg){fs.writeFileSync(stem+'.svg',svg);fs.writeFileSync(stem+'.png',new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng());}writeJson(json,record);result=record;}
    if(!fs.existsSync(stem+'.png')&&fs.existsSync(stem+'.svg'))fs.writeFileSync(stem+'.png',new Resvg(fs.readFileSync(stem+'.svg','utf8'),{font:{loadSystemFonts:true}}).render().asPng());
    reroutes.set(hash,result);
  }
  const differences=[];
  if(result.error)differences.push(result.error);
  if(expected?.metrics){
    const actual=expected.scored===false?Object.fromEntries(Object.keys(expected.metrics).map(k=>[k,result.metrics?.[k]])):result.metrics;
    if(JSON.stringify(actual)!==JSON.stringify(expected.metrics))differences.push('metric/configuration/geometry mismatch');
  }
  if(saved.observations?.netStatus&&JSON.stringify(result.netStatus)!==JSON.stringify(saved.observations.netStatus))differences.push('per-net status mismatch');
  const check={label,file,hash,passed:!differences.length,differences,metrics:result.metrics,figure:'reroute/'+hash.slice(0,16)+'.png'};
  console.log(JSON.stringify({label,passed:check.passed,clean:result.metrics?.cleanNets,vias:result.metrics?.vias}));return check;
}
const records=[],checks=[];
for(const record of experiment.records){
  const dir=record.dir,ws=path.join(dir,'workspace'),state=stateOf(ws),summary=readJson(path.join(dir,'summary.json')),manifest=readJson(path.join(dir,'manifest.json'));
  const {problem}=loadBoard(state);
  const entries=log(ws),calls=entries.filter(e=>e.type==='call'),results=new Map(entries.filter(e=>e.type==='result').map(e=>[e.callId,e]));
  const attempts=[],scope=[];
  for(const call of calls.filter(c=>c.command==='place')){
    const result=results.get(call.callId),candidate=result?.candidate&&state.candidates[result.candidate];
    if(candidate){
      const file=path.join(ws,candidate.file),saved=readJson(file),source=readJson(path.join(ws,state.candidates[call.input.candidate].file));
      const changed=saved.placement.filter((p,i)=>['x','y','rotation','side'].some(k=>p[k]!==source.placement[i][k])).map(p=>p.ref);
      const allowed=new Set([...(call.input.targets??[]).map(p=>p.ref),...(call.input.relax?.refs??[])]);
      const leaks=call.input.relax?changed.filter(r=>!allowed.has(r)):[];
      const targetDrifts=(call.input.targets??[]).filter(t=>{const p=saved.placement.find(p=>p.ref===t.ref);return !p||Object.keys(t).some(k=>t[k]!==p[k]);}).map(t=>t.ref);
      scope.push({candidate:candidate.id,leaks,targetDrifts,changed,passed:!leaks.length&&!targetDrifts.length});
      const check=await independentlyCheck(state,file,candidate,`rep${record.rep}-${record.arm}/${candidate.id}`);checks.push(check);
      const rawFile=path.join(ws,'jobs',call.callId,'raw-layout.json'),rawQuality=fs.existsSync(rawFile)?repositoryMetrics(problem,readJson(rawFile)):null;
      attempts.push({input:call.input,candidate,check,engine:result.engine,seconds:result.seconds,diagnostics:result.diagnostics,rawQuality,legalHpwlDeltaMm:rawQuality?+(candidate.metrics.hpwlMm-rawQuality.metrics.hpwl_mm).toFixed(3):null});
    }else attempts.push({input:call.input,error:result?.error??'Missing result',seconds:result?.seconds});
  }
  const selected=summary.best??null,lastDiagnostic=[...attempts].reverse().find(t=>t.candidate)??null;
  const file=selected?path.join(ws,selected.file):null,final=path.join(ws,'final-layout.json');
  const finalExact=selected?fs.existsSync(final)&&JSON.stringify(readJson(final).layout)===JSON.stringify(readJson(file).layout):!fs.existsSync(final);
  const rankingExact=!Object.values(state.candidates).some(c=>better(c,selected));
  let decisions=null;const df=path.join(dir,'agent-workspace/DECISIONS.json');if(fs.existsSync(df)){try{decisions=readJson(df);}catch{decisions={raw:fs.readFileSync(df,'utf8')};}}
  const context=readJson(path.join(dir,'context.json'));
  const humanLayout=readJson(path.join(out,'human-layout-private.json')).layout;
  const initialPlacement=readJson(path.join(ws,'c000.json')).placement;
  const expectedTeacher=plan.teacherRefs.map(ref=>{const i=initialPlacement.findIndex(p=>p.ref===ref),p=humanLayout[i];return {ref,x:p.x,y:p.y,rotation:p.rotation*90,side:p.side?'bottom':'top'};});
  const baselineFixedSequence=record.arm!=='cypress'||calls.filter(c=>c.command==='place').length===2&&calls.filter(c=>c.command==='place').every(c=>Object.keys(c.input).every(k=>k==='candidate'));
  const scoreCalls=calls.filter(c=>c.command==='score').map(c=>({candidate:c.input.candidate,seconds:results.get(c.callId)?.seconds,error:results.get(c.callId)?.error,metrics:results.get(c.callId)?.metrics}));
  const teacherExecuted=false;
  const bridgePassed=attempts.filter(t=>t.candidate).every(t=>t.engine.engine==='NVIDIA Cypress'&&t.engine.pipeline==='cypress+shared-legalize'&&t.engine.inputPinErrorMm<=.011&&t.engine.wrapperPinErrorMm<=.025&&t.engine.finalPinErrorMm<=.025&&t.engine.objective.powerNets>0&&t.engine.engineSourceHash&&t.engine.basicSourceHash&&t.engine.rsmtDiagnosticExcludesDegreeGe===150);
  const budgetedTermination=['agent finished','session deadline'].includes(summary.stopReason)&&summary.seconds<=plan.minutesPerAgent*60+5;
  const protocol={sourceUnchanged:summary.sourceHashBefore===summary.sourceHashAfter,boardUnchanged:summary.boardHashBefore===summary.boardHashAfter&&summary.boardHashAfter===plan.boardSha256,startUnchanged:sha(fs.readFileSync(path.join(manifest.resume,'session.json')))===manifest.startStateHash&&sha(fs.readFileSync(path.join(manifest.resume,'c000.json')))===manifest.startCandidateHash,finalExact,rankingExact,scopePassed:scope.every(s=>s.passed),bridgePassed,baselineFixedSequence,modeMatched:manifest.mode===record.arm,noHumanMovableInput:manifest.exposure==='task-only',selectedScored:!selected||selected.scored===true,toolBudgetPassed:Math.max(summary.maxDshToolSeconds,summary.maxLayoutToolSeconds)<180,quotaPassed:summary.places<=2,budgetedTermination};
  records.push({...record,summary,manifest,selected,lastDiagnostic,attempts,scoreCalls,scope,decisions,protocol,context});
}
const pairs=[1,2,3].map(rep=>{
  const c=records.find(r=>r.rep===rep&&r.arm==='cypress'),t=records.find(r=>r.rep===rep&&r.arm==='harness');
  const matched=['sourceHash','boardHash','seed','startStateHash','startCandidateHash'].every(k=>c.manifest[k]===t.manifest[k]);
  const cudaOutputs={cypress:c.attempts.filter(a=>a.candidate).length,harness:t.attempts.filter(a=>a.candidate).length};
  return {rep,matched,cudaOutputs,equalCudaOutputs:cudaOutputs.cypress===cudaOutputs.harness,comparable:!!c.selected&&!!t.selected,delta:t.selected&&c.selected?Object.fromEntries(['cleanNets','vias','hpwlMm'].map(k=>[k,t.selected.metrics[k]-c.selected.metrics[k]])):null};
});
const humanFile=path.join(out,'human-layout-private.json'),human=await independentlyCheck(stateOf(path.join(records[0].dir,'workspace')),humanFile,null,'human');checks.push(human);
const distributions=Object.fromEntries(['cypress','harness'].map(arm=>{const runs=records.filter(r=>r.arm===arm),valid=runs.filter(r=>r.selected);return [arm,{repetitions:runs.length,eligible:valid.length,allThreeEligible:valid.length===3,metrics:valid.length===3?Object.fromEntries(['cleanNets','vias','hpwlMm'].map(key=>{const values=valid.map(r=>r.selected.metrics[key]).sort((a,b)=>a-b);return [key,{min:values[0],median:values[1],max:values[2],values}];})):null}];}));
const engines=records.flatMap(r=>r.attempts.filter(t=>t.candidate).map(t=>JSON.stringify([t.engine.engineSourceHash,t.engine.basicSourceHash])));
const engineSourcesMatched=engines.length>0&&new Set(engines).size===1;
const protocolPassed=records.every(r=>Object.values(r.protocol).every(Boolean))&&pairs.every(p=>p.matched)&&new Set(records.map(r=>r.manifest.agentWorkspace)).size===6&&engineSourcesMatched;
const audit={complete:true,engine:'NVIDIA Cypress',plan,protocolPassed,reroutePassed:checks.every(c=>c.passed),engineSourcesMatched,pairs,distributions,human,checks,records};
writeJson(path.join(out,'audit.json'),audit);
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const href=f=>path.relative(out,f).replaceAll('\\','/');
const maxSeconds=Math.max(...records.map(r=>Math.max(r.summary.maxDshToolSeconds,r.summary.maxLayoutToolSeconds)));
const html=renderComparison(audit,{out,maxToolSeconds:maxSeconds});
fs.writeFileSync(path.join(out,'report.html'),html);
fs.cpSync(path.resolve('harness'),path.join(out,'source-harness'),{recursive:true});
writeJson(path.join(out,'verification.json'),{complete:true,protocolPassed,reroutePassed:audit.reroutePassed,allTeacherHintsExecuted:audit.allTeacherHintsExecuted,reroutedLayouts:reroutes.size,checkedCandidates:checks.length,maxToolSeconds:maxSeconds,pairs,distributions,report:'report.html'});
console.log(JSON.stringify({report:path.join(out,'report.html'),protocolPassed,reroutePassed:audit.reroutePassed,pairs,distributions},null,2));
