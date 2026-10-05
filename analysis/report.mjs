import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {args,readJson,writeJson,sha} from '../harness/io.mjs';
import {stateOf,better} from '../harness/session.mjs';
import {runtimeRoot} from '../harness/runtime.mjs';
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
  if(expected?.metrics&&JSON.stringify(result.metrics)!==JSON.stringify(expected.metrics))differences.push('metric/configuration/geometry mismatch');
  if(saved.observations?.netStatus&&JSON.stringify(result.netStatus)!==JSON.stringify(saved.observations.netStatus))differences.push('per-net status mismatch');
  const check={label,file,hash,passed:!differences.length,differences,metrics:result.metrics,figure:'reroute/'+hash.slice(0,16)+'.png'};
  console.log(JSON.stringify({label,passed:check.passed,clean:result.metrics?.cleanNets,vias:result.metrics?.vias}));return check;
}
const records=[],checks=[];
for(const record of experiment.records){
  const dir=record.dir,ws=path.join(dir,'workspace'),state=stateOf(ws),summary=readJson(path.join(dir,'summary.json')),manifest=readJson(path.join(dir,'manifest.json'));
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
      attempts.push({input:call.input,candidate,check,engine:result.engine,seconds:result.seconds,diagnostics:result.diagnostics});
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
  const teacherExecuted=attempts.some(t=>t.input.targets&&expectedTeacher.every(expected=>t.input.targets.some(p=>Object.keys(expected).every(k=>typeof expected[k]==='number'?Math.abs(p[k]-expected[k])<=1e-6:p[k]===expected[k])))&&t.candidate&&!scope.find(s=>s.candidate===t.candidate.id)?.targetDrifts.length);
  const bridgePassed=attempts.filter(t=>t.candidate).every(t=>t.engine.engine==='NVIDIA Cypress'&&t.engine.pipeline==='cypress+shared-legalize'&&t.engine.inputPinErrorMm<=.011&&t.engine.wrapperPinErrorMm<=.025&&t.engine.finalPinErrorMm<=.025&&t.engine.objective.powerNets>0&&t.engine.engineSourceHash&&t.engine.basicSourceHash&&t.engine.rsmtDiagnosticExcludesDegreeGe===150);
  const protocol={sourceUnchanged:summary.sourceHashBefore===summary.sourceHashAfter,boardUnchanged:summary.boardHashBefore===summary.boardHashAfter&&summary.boardHashAfter===plan.boardSha256,startUnchanged:sha(fs.readFileSync(path.join(manifest.resume,'session.json')))===manifest.startStateHash&&sha(fs.readFileSync(path.join(manifest.resume,'c000.json')))===manifest.startCandidateHash,finalExact,rankingExact,scopePassed:scope.every(s=>s.passed),bridgePassed,toolBudgetPassed:Math.max(summary.maxDshToolSeconds,summary.maxLayoutToolSeconds)<180,quotaPassed:summary.places<=2,normalExit:summary.exitCode===0&&summary.stopReason==='agent finished'};
  records.push({...record,summary,manifest,selected,lastDiagnostic,attempts,scope,decisions,teacherExecuted,protocol,context});
}
const pairs=[1,2,3].map(rep=>{
  const c=records.find(r=>r.rep===rep&&r.arm==='control'),t=records.find(r=>r.rep===rep&&r.arm==='teacher');
  const matched=['sourceHash','boardHash','seed','startStateHash','startCandidateHash'].every(k=>c.manifest[k]===t.manifest[k]);
  return {rep,matched,comparable:!!c.selected&&!!t.selected,delta:t.selected&&c.selected?Object.fromEntries(['cleanNets','vias','hpwlMm'].map(k=>[k,t.selected.metrics[k]-c.selected.metrics[k]])):null,teacherExecuted:t.teacherExecuted};
});
const humanFile=path.join(out,'human-layout-private.json'),human=await independentlyCheck(stateOf(path.join(records[0].dir,'workspace')),humanFile,null,'human');checks.push(human);
const distributions=Object.fromEntries(['control','teacher'].map(arm=>{const runs=records.filter(r=>r.arm===arm),valid=runs.filter(r=>r.selected);return [arm,{repetitions:runs.length,eligible:valid.length,allThreeEligible:valid.length===3,metrics:valid.length===3?Object.fromEntries(['cleanNets','vias','hpwlMm'].map(key=>{const values=valid.map(r=>r.selected.metrics[key]).sort((a,b)=>a-b);return [key,{min:values[0],median:values[1],max:values[2],values}];})):null}];}));
const engines=records.flatMap(r=>r.attempts.filter(t=>t.candidate).map(t=>JSON.stringify([t.engine.engineSourceHash,t.engine.basicSourceHash])));
const engineSourcesMatched=engines.length>0&&new Set(engines).size===1;
const protocolPassed=records.every(r=>Object.values(r.protocol).every(Boolean))&&pairs.every(p=>p.matched)&&new Set(records.map(r=>r.manifest.agentWorkspace)).size===6&&engineSourcesMatched;
const audit={complete:true,engine:'NVIDIA Cypress',plan,protocolPassed,reroutePassed:checks.every(c=>c.passed),allTeacherHintsExecuted:records.filter(r=>r.arm==='teacher').every(r=>r.teacherExecuted),pairs,distributions,human,checks,records};
writeJson(path.join(out,'audit.json'),audit);
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const href=f=>path.relative(out,f).replaceAll('\\','/');
const rows=records.map(r=>{const d=r.selected??r.lastDiagnostic?.candidate,m=d?.metrics;return `<tr><td>${r.rep}</td><td>${r.arm}</td><td>${r.selected?'合格':'无合格结果；诊断值'}</td><td>${m?m.cleanNets+'/'+m.nets:'—'}</td><td>${m?.vias??'—'}</td><td>${m?.hpwlMm??'—'}</td><td>${m?.violations??'—'}</td><td>${r.summary.places}</td><td>${(r.summary.seconds/60).toFixed(2)}</td></tr>`;}).join('');
const details=records.map(r=>`<details><summary>重复 ${r.rep} · ${r.arm} · ${esc(r.summary.stopReason)}</summary><p><a href="${href(path.join(r.dir,'events.jsonl'))}">dsh trajectory</a> · <a href="${href(path.join(r.dir,'workspace/tools.jsonl'))}">工具账本</a> · <a href="${href(path.join(r.dir,'manifest.json'))}">来源与起点</a></p><pre>${esc(JSON.stringify({protocol:r.protocol,decisions:r.decisions,attempts:r.attempts},null,2))}</pre>${r.attempts.filter(t=>t.check).map(t=>`<p>${t.candidate.id} · ${esc(t.engine.status)} · ${t.check.metrics.cleanNets}/${t.check.metrics.nets} · ${t.check.metrics.vias} vias</p><img src="${t.check.figure}" alt="候选 ${t.candidate.id} 布局">`).join('')}</details>`).join('');
const maxSeconds=Math.max(...records.map(r=>Math.max(r.summary.maxDshToolSeconds,r.summary.maxLayoutToolSeconds)));
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cypress + dsh · ${esc(plan.board)} harness</title><style>body{font:15px/1.6 Segoe UI,Microsoft YaHei,sans-serif;background:#eff3f6;color:#182934;margin:0}main{max-width:1150px;margin:28px auto;padding:28px;background:white;border-radius:10px}h1{font-size:26px}h2{font-size:20px}table{border-collapse:collapse;width:100%}th,td{padding:9px;border-bottom:1px solid #ddd;text-align:left}th{background:#eaf1f5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#f4f6f8;padding:14px}details{margin:15px 0;border:1px solid #ccd8df;padding:14px}img{width:100%}a{color:#176bb0}.note{background:#eaf3fa;padding:14px}</style><main><h1>Cypress + dsh：${esc(plan.board.toUpperCase())} 有限人工信息三次重复对照</h1><p class="note">所有布局求解调用 NVIDIA Cypress CUDA，随后仅接公共几何合法化。没有 WebGPU/LNS/polish 布局优化。只有收敛且通过独立几何检查的结果可选中。</p><p>三对相同随机起点与 seed 1000 / 8919 / 16838，两个条件使用相同 prompt、工具、CUDA 配置与路由。teacher 只增加 ${esc(plan.teacherRefs.join(' / '))} 共 ${plan.teacherRefs.length} 个主 IC 人工姿态，其余器件由 dsh 从输入推导。各会话最多两次 place、${plan.minutesPerAgent} 分钟；顺序执行。此样本不能证明统计显著性或整板人工水平。</p><h2>结果</h2><table><tr><th>重复</th><th>信息条件</th><th>资格</th><th>布通</th><th>过孔</th><th>HPWL mm</th><th>几何违规</th><th>place</th><th>分钟</th></tr>${rows}<tr><td>参考</td><td>人工</td><td>离线，同配置</td><td>${human.metrics.cleanNets}/${human.metrics.nets}</td><td>${human.metrics.vias}</td><td>${human.metrics.hpwlMm}</td><td>${human.metrics.violations}</td><td>—</td><td>—</td></tr></table><p>同种子完整合格配对 ${pairs.filter(p=>p.comparable).length}/3。control 合格 ${distributions.control.eligible}/3；teacher 合格 ${distributions.teacher.eligible}/3。不足三次合格结果的条件不汇报胜出中位数。无合格结果行显示最后一次可读 CUDA 诊断，不参与胜负。</p><h2>独立核验</h2><p>协议审计 ${protocolPassed}；独立重新布线与逐网状态 ${audit.reroutePassed}；三次教师关键信息实际执行 ${audit.allTeacherHintsExecuted}。最长模型/布局工具 ${maxSeconds.toFixed(3)} 秒。每个保存候选重新核验布通、过孔、HPWL、几何、评估配置与完整逐网状态。固定目标、局部作用范围、最终导出和候选排序同时检查。</p><p>CUDA 输入保留增量旋转、背面镜像、重复 node/net 焊盘与供电/地焊盘；导出误差限 0.011mm，最终焊盘往返限 0.025mm。路由为已有 calibrated-full PathFinder 整网代理，${human.metrics.configuration.cellMm}mm / ${human.metrics.configuration.rounds} 轮，并使用实际板 net-class 规则；HPWL 为信号网线长。CUDA 供电/地目标与信号评估网数分别记载。人工矩形代理违规、固定-固定豁免与网格效应不能用来推断制造 DRC。</p><p><a href="protocol.json">实验协议</a> · <a href="audit.json">完整审计</a> · <a href="human-layout-private.json">离线人工参考</a></p><h2>人工参考布局</h2><img src="${human.figure}" alt="人工布局的独立核验视图"><h2>轨迹与 Cypress 候选</h2>${details}</main></html>`;
fs.writeFileSync(path.join(out,'report.html'),html);
fs.cpSync(path.resolve('harness'),path.join(out,'source-harness'),{recursive:true});
writeJson(path.join(out,'verification.json'),{complete:true,protocolPassed,reroutePassed:audit.reroutePassed,allTeacherHintsExecuted:audit.allTeacherHintsExecuted,reroutedLayouts:reroutes.size,checkedCandidates:checks.length,maxToolSeconds:maxSeconds,pairs,distributions,report:'report.html'});
console.log(JSON.stringify({report:path.join(out,'report.html'),protocolPassed,reroutePassed:audit.reroutePassed,pairs,distributions},null,2));
