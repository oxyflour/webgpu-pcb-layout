import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {args,readJson,writeJson,sha} from './io.mjs';
import {callTool,stateOf} from './session.mjs';
import {runtimeRoot} from './runtime.mjs';
const a=args(),out=path.resolve(a.out),resume=path.resolve(a.resume),minutes=Number(a.minutes??8),quota=Number(a.runs??2);
const mode=a.mode??'harness';if(!['harness','cypress'].includes(mode))throw Error('Unknown comparison mode');
if(!Number.isFinite(minutes)||minutes<=0||minutes>30||!Number.isInteger(quota)||quota<1||quota>4)throw Error('Invalid experiment budget');
if(fs.existsSync(out))throw Error('Output exists');fs.mkdirSync(out,{recursive:true});
fs.cpSync(import.meta.dirname,path.join(out,'source-harness'),{recursive:true});
const session=path.join(out,'workspace');fs.cpSync(resume,session,{recursive:true});fs.writeFileSync(path.join(session,'tools.jsonl'),'');
const ws=path.join(os.homedir(),'agent-ws','cypress-'+crypto.randomUUID());fs.mkdirSync(ws,{recursive:true});
const token=crypto.randomUUID(),start=Date.now();let busy=false,places=0,reason=null,child,exited=false;
const stop=why=>{if(reason||exited)return;reason=why;try{execFileSync('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'});}catch{}};
const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.method!=='POST'||req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end('{}');return;}
  const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  let ownsBusy=false;
  try{let body='';for await(const b of req){body+=b;if(body.length>262144)throw Error('Request too large');}
    const {command,input}=JSON.parse(body);if(busy)throw Error('Another tool is running');
    if(mode==='cypress'){
      if(!['status','place','score','submit'].includes(command))throw Error('Cypress baseline only executes the fixed global-solve/score sequence');
      if(command==='place'&&(Object.keys(input??{}).some(k=>k!=='candidate')||input?.candidate!==stateOf(session).current))throw Error('Baseline place takes only the latest candidate; no targets, relax scope or orientation advice');
    }
    if(command==='place'&&places>=quota)throw Error('Place quota exhausted; read status and submit eligible best');
    if(command==='place')places++;
    busy=ownsBusy=true;
    const result=await callTool(session,command,input,{signal:controller.signal});
    if(result.file&&!result.error)fs.copyFileSync(path.join(session,result.file),path.join(ws,result.file));
    res.end(JSON.stringify(result));
  }catch(e){res.end(JSON.stringify({error:e.message}));}finally{if(ownsBusy)busy=false;}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port,base=fs.readFileSync(path.resolve(a.prompt??'harness/prompts/cypress-v1.txt'),'utf8'),context=readJson(path.resolve(a.context));
const prompt=base+`\nTASK: board ${stateOf(session).board}; at most ${quota} NEW place calls; ${minutes} minutes total. Start from candidate c000. Selection requires converged and independently legal Cypress output.\nEXPLICIT CONTEXT (exposure=${context.exposure}, provenance=${context.provenance}):\n${context.text}\n`;
fs.writeFileSync(path.join(out,'prompt.txt'),prompt);writeJson(path.join(out,'context.json'),context);fs.writeFileSync(path.join(ws,'TASK.txt'),prompt);
fs.writeFileSync(path.join(ws,'layout.cmd'),`@echo off\r\nset "PCB_TOOL_URL=${url}"\r\nset "PCB_TOOL_TOKEN=${token}"\r\nnode "${path.join(import.meta.dirname,'cli.mjs')}" %*\r\n`);
const patch=path.join(out,'dsh-patch.yml');
fs.writeFileSync(patch,`- id: agent\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n${['tool-web','tool-subagent','tool-subagent-fork','tool-subagent-control','tool-subagent-list-agents','tool-workflow','tool-skill','tool-jobs','tool-user-questions'].map(id=>`- id: ${id}\n  disabled: true`).join('\n')}\n- id: pwsh-sandbox\n  config:\n    timeoutMs: 175000\n    maxTimeoutMs: 175000\n- id: tool-pwsh\n  config:\n    enableRunInBackground: false\n    promoteOnTimeout: false\n`);
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const sourceFiles=files(import.meta.dirname).concat(['src','bench'].flatMap(d=>files(path.join(runtimeRoot,d))));
const fingerprint=()=>sha(sourceFiles.sort().map(f=>f+':'+sha(fs.readFileSync(f))).join('\n'));
const before=fingerprint(),initial=stateOf(session),boardHash=sha(fs.readFileSync(initial.boardFile));
writeJson(path.join(out,'manifest.json'),{model:'deepseek-flash',transport:'dsh',mode,engine:'NVIDIA Cypress',runtime:runtimeRoot,resume,sourceHash:before,boardHash,seed:initial.seed,startStateHash:sha(fs.readFileSync(path.join(session,'session.json'))),startCandidateHash:sha(fs.readFileSync(path.join(session,'c000.json'))),promptHash:sha(prompt),contextHash:sha(JSON.stringify(context)),minutes,quota,agentWorkspace:ws,exposure:context.exposure});
const dsh=process.env.DSH_EXE??path.join(os.homedir(),'AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd');
child=spawn('cmd.exe',['/d','/s','/c',`""${dsh}" --patch "${patch}" --profile headless --json -"`],{cwd:ws,env:{...process.env,DSH_PERMISSION_MODE:'workspace-write'},windowsVerbatimArguments:true,windowsHide:true});
let buffer='',stderr='',maxToolSeconds=0;const active=new Map();
child.stdout.on('data',bytes=>{buffer+=bytes.toString();let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;let e;try{e=JSON.parse(line);}catch{e={type:'raw',text:line};}e.t=Date.now()-start;fs.appendFileSync(path.join(out,'events.jsonl'),JSON.stringify(e)+'\n');
  if(e.type==='tool_call'){active.set(e.callId,Date.now());console.log(`[${(e.t/1000).toFixed(1)}s] ${e.tool}: ${JSON.stringify(e.input).slice(0,140)}`);if(/webgpu-layout|webgpu_pcb_placer|cypress-layout|kicad_pcb|session\.json|tools\.jsonl|cli\.mjs/i.test(JSON.stringify(e.input)))stop('forbidden read audit');}
  if(e.type==='tool_result'){const t=active.get(e.callId);if(t)maxToolSeconds=Math.max(maxToolSeconds,(Date.now()-t)/1000);active.delete(e.callId);}
  if(['text','final'].includes(e.type))console.log(`[${(e.t/1000).toFixed(1)}s] ${e.type}: ${String(e.text).slice(0,180)}`);
}});
child.stderr.on('data',b=>{stderr+=b.toString();});child.stdin.end(prompt);
const timer=setInterval(()=>{if(Date.now()-start>minutes*60000)stop('session deadline');if([...active.values()].some(t=>Date.now()-t>177000))stop('tool deadline');},250);
const exitCode=await new Promise(resolve=>{child.on('error',e=>{exited=true;stderr+=e.message;resolve(-1);});child.on('close',code=>{exited=true;resolve(code);});});
clearInterval(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));while(busy)await new Promise(r=>setTimeout(r,20));
const finalState=stateOf(session);if(finalState.best)await callTool(session,'submit',{candidate:finalState.best});
fs.writeFileSync(path.join(out,'stderr.txt'),stderr);fs.cpSync(ws,path.join(out,'agent-workspace'),{recursive:true});fs.unlinkSync(path.join(out,'agent-workspace/layout.cmd'));
const tools=fs.readFileSync(path.join(session,'tools.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse),results=tools.filter(t=>t.type==='result');
const summary={engine:'NVIDIA Cypress',stopReason:reason??'agent finished',exitCode,seconds:(Date.now()-start)/1000,places,maxDshToolSeconds:maxToolSeconds,maxLayoutToolSeconds:Math.max(0,...results.map(t=>t.seconds)),best:finalState.candidates[finalState.best]??null,candidates:Object.values(finalState.candidates),errors:results.filter(r=>r.error).map(r=>({command:r.command,error:r.error})),sourceHashBefore:before,sourceHashAfter:fingerprint(),boardHashBefore:boardHash,boardHashAfter:sha(fs.readFileSync(initial.boardFile))};
writeJson(path.join(out,'summary.json'),summary);console.log(JSON.stringify({stop:summary.stopReason,seconds:summary.seconds,best:summary.best,errors:summary.errors}));
