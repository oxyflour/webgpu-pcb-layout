import fs from 'node:fs';
import path from 'node:path';
const out=path.resolve(process.argv[2]);
const experimentFile=path.join(out,'experiment.json');
const experiment=fs.existsSync(experimentFile)?JSON.parse(fs.readFileSync(experimentFile,'utf8')):{complete:false,records:[]};
const runs=fs.readdirSync(out).filter(n=>/^rep\d+-(control|teacher|cypress|harness)$/.test(n));
for(const run of runs){
  const dir=path.join(out,run),log=path.join(dir,'workspace/tools.jsonl'),summary=path.join(dir,'summary.json');
  const entries=fs.existsSync(log)?fs.readFileSync(log,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
  const places=entries.filter(e=>e.command==='place'&&e.type==='result').map(e=>({candidate:e.candidate,error:e.error,eligible:e.eligible,clean:e.metrics?.cleanNets,vias:e.metrics?.vias,hpwl:e.metrics?.hpwlMm,violations:e.metrics?.violations,seconds:e.seconds,solve:e.engine?.solveSeconds,targets:e.scope?.targetDrifts}));
  const last=entries.at(-1),s=fs.existsSync(summary)?JSON.parse(fs.readFileSync(summary,'utf8')):null;
  const scores=entries.filter(e=>e.command==='score'&&e.type==='result').map(e=>({candidate:e.candidate,error:e.error,eligible:e.eligible,clean:e.metrics?.cleanNets,vias:e.metrics?.vias,hpwl:e.metrics?.hpwlMm,seconds:e.seconds}));
  console.log(JSON.stringify({run,done:!!s,stop:s?.stopReason,best:s?.best?.id,bestMetrics:s?.best?.metrics,seconds:s?.seconds,last:last&&{at:last.at,command:last.command,type:last.type,seconds:last.seconds,error:last.error},places,scores}));
}
console.log(JSON.stringify({complete:experiment.complete,finished:experiment.records.length}));
