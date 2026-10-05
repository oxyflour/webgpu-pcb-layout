import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { readJson,writeJson } from './io.mjs';
export const stateOf=workspace=>readJson(path.join(workspace,'session.json'));
export function better(a,b){
  if(!a?.eligible)return false;
  if(!b?.eligible)return true;
  const x=a.metrics,y=b.metrics;
  return x.cleanNets!==y.cleanNets?x.cleanNets>y.cleanNets:x.hpwlMm+8*x.vias<y.hpwlMm+8*y.vias;
}
export function boundedWorker(payload,{timeoutMs=165000,signal}={}){
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>165000)throw Error('Invalid worker budget');
  return new Promise(resolve=>{
    const start=performance.now();if(signal?.aborted){resolve({error:'cancelled',seconds:0});return;}
    const child=fork(new URL('./worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,execArgv:[]});
    let reply,error,done=false;
    const finish=()=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({...reply,...(error?{error}:{}),...(!reply&&!error?{error:'worker exited without output'}:{}),seconds:+((performance.now()-start)/1000).toFixed(3)});};
    const abort=()=>{error='cancelled';child.kill();};
    const timer=setTimeout(()=>{error='tool_timeout';child.kill();},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});child.on('message',r=>{reply=r;});child.on('error',e=>{error=e.message;finish();});child.on('close',finish);child.stderr.on('data',()=>{});child.send(payload);
  });
}
export async function callTool(workspace,command,input={},options={}) {
  const started=performance.now(),state=stateOf(workspace),callId=crypto.randomUUID();
  const journal=e=>fs.appendFileSync(path.join(workspace,'tools.jsonl'),JSON.stringify({at:new Date().toISOString(),callId,command,...e})+'\n');
  journal({type:'call',input});
  const finish=r=>{const output={...r,seconds:+((performance.now()-started)/1000).toFixed(3)};journal({type:'result',...output});return output;};
  try{
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Input must be an object');
    const commands=['board_info','inspect','preview','place','evaluate','score','status','submit'];
    if(!commands.includes(command))throw Error('Unknown command');
    const allowed={board_info:['page'],inspect:['candidate','refs','padPage','netPage'],preview:['candidate','targets'],place:['candidate','targets','relax','preserveRotation'],evaluate:['candidate'],score:['candidate'],status:[],submit:['candidate']}[command];
    if(Object.keys(input).some(k=>!allowed.includes(k)))throw Error('Unknown input key');
    if(command==='status')return finish({engine:'NVIDIA Cypress',current:state.current,best:state.best,placeCalls:state.placeCalls,candidates:Object.values(state.candidates)});
    const id=input.candidate??(command==='submit'?state.best:state.current),source=state.candidates[id];
    if(!source||!/^c\d+$/.test(id)||source.file!==id+'.json')throw Error('Unknown candidate');
    const saved=readJson(path.join(workspace,source.file));
    if(command==='score'&&!saved.engine)throw Error('Only a produced Cypress candidate can be scored; random c000 is not eligible');
    if(command==='submit'){
      if(!source.eligible)throw Error('Submit requires a converged, independently legal Cypress candidate');
      fs.copyFileSync(path.join(workspace,source.file),path.join(workspace,'final-layout.json'));state.submitted=id;writeJson(path.join(workspace,'session.json'),state);return finish({submitted:id,metrics:source.metrics,engine:source.engine});
    }
    if(command==='place'){state.placeCalls++;writeJson(path.join(workspace,'session.json'),state);}
    const jobDir=path.join(workspace,'jobs',callId);fs.mkdirSync(jobDir,{recursive:true});
    const result=await boundedWorker({command,input:{...input,candidate:id},state,source:saved,seed:state.seed+104729*(state.placeCalls-1),jobDir},options);
    if(result.error)return finish({...result,controllerJob:path.relative(workspace,jobDir),note:'Logs remain with the controller and are not exposed inside the agent workspace. Do not search local folders for them; use status and another physical hypothesis within the remaining quota.'});
    if(command==='score'){
      writeJson(path.join(workspace,source.file),{...saved,...result,needsScore:false});
      const candidate={...source,metrics:result.metrics,scored:true,eligible:result.eligible};
      state.candidates[id]=candidate;
      state.best=null;for(const c of Object.values(state.candidates))if(better(c,state.candidates[state.best]))state.best=c.id;
      writeJson(path.join(workspace,'session.json'),state);
      return finish({...result,candidate:id,file:source.file,best:state.best,note:'Routing score and ranking updated; all poses, sides, engine evidence and constraints are unchanged.'});
    }
    if(command==='place'){
      const next='c'+String(state.placeCalls).padStart(3,'0'),file=next+'.json';
      writeJson(path.join(workspace,file),{board:state.board,...result});
      const candidate={id:next,file,metrics:result.metrics,scored:false,eligible:result.eligible,engine:result.engine};state.candidates[next]=candidate;state.current=next;
      if(better(candidate,state.candidates[state.best]))state.best=next;
      writeJson(path.join(workspace,'session.json'),state);
      const {layout,placement,observations,...detail}=result;return finish({...detail,candidate:next,file,best:state.best});
    }
    // Read-only evaluation/inspection never overwrite the candidate or state.
    return finish({...result,...(command==='evaluate'?{candidate:id}:{}),job:path.relative(workspace,jobDir)});
  }catch(e){return finish({error:e.message});}
}
