import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {args,readJson,writeJson,sha} from '../harness/io.mjs';
import {runtimeRoot} from '../harness/runtime.mjs';
const a=args(),out=path.resolve(a.out),run=path.join(out,a.run),ws=path.join(run,'workspace'),state=readJson(path.join(ws,'session.json'));
if(!fs.existsSync(path.join(run,'summary.json')))throw Error('Run must finish before caching independent checks');
const require=createRequire(path.join(runtimeRoot,'package.json')),{Resvg}=require('@resvg/resvg-js');
const dir=path.join(out,'reroute');fs.mkdirSync(dir,{recursive:true});
for(const c of Object.values(state.candidates).filter(c=>c.engine)){
  const file=path.join(ws,c.file),saved=readJson(file),hash=sha(JSON.stringify(saved.layout)),stem=path.join(dir,hash.slice(0,16));
  if(fs.existsSync(stem+'.json'))continue;
  const reply=await new Promise(resolve=>{
    const child=fork(new URL('./reference-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,execArgv:[]});let result,error;
    const timer=setTimeout(()=>{error='reference timeout';child.kill();},165000);
    child.on('message',r=>{result=r;});child.on('error',e=>{error=e.message;});child.on('close',()=>{clearTimeout(timer);resolve(result??{error:error??'reference exited without result'});});child.stderr.on('data',()=>{});child.send({state,candidate:file});
  });
  if(reply.error){console.log(JSON.stringify({candidate:c.id,error:reply.error}));continue;}
  const {svg,...record}=reply;writeJson(stem+'.json',record);
  if(svg){fs.writeFileSync(stem+'.svg',svg);fs.writeFileSync(stem+'.png',new Resvg(svg,{font:{loadSystemFonts:true}}).render().asPng());}
  const expected=c.scored===false?Object.fromEntries(Object.keys(c.metrics).map(k=>[k,record.metrics[k]])):record.metrics;
  console.log(JSON.stringify({run:a.run,candidate:c.id,hash,metricsMatch:JSON.stringify(expected)===JSON.stringify(c.metrics),netStatusMatch:!saved.observations?.netStatus||JSON.stringify(saved.observations.netStatus)===JSON.stringify(record.netStatus),clean:record.metrics.cleanNets,vias:record.metrics.vias,hpwl:record.metrics.hpwlMm}));
}
