import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {args,writeJson} from './io.mjs';
const a=args();
if(!a.container||!a.out)throw Error('Supply --container ISOLATED_CONTAINER --out DIR');
const out=path.resolve(a.out);fs.mkdirSync(out,{recursive:true});
function run(argv){const r=spawnSync('docker',argv,{encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:5*1024*1024});if(r.status!==0||r.error)throw Error(r.stderr||r.error?.message);return r.stdout;}
run(['cp',path.join(import.meta.dirname,'patch-cypress.py'),a.container+':/tmp/cypress-harness-patch.py']);
const result=JSON.parse(run(['exec',a.container,'python3','/tmp/cypress-harness-patch.py']));
run(['cp',a.container+':/Cypress/install/dreamplace/NonLinearPlace.py',path.join(out,'NonLinearPlace.py')]);
run(['cp',a.container+':/Cypress/install/dreamplace/NonLinearPlace.py.crossing-original',path.join(out,'NonLinearPlace.py.original')]);
run(['cp',a.container+':/Cypress/install/dreamplace/BasicPlace.py',path.join(out,'BasicPlace.py')]);
run(['cp',a.container+':/Cypress/install/dreamplace/BasicPlace.py.rsmt-original',path.join(out,'BasicPlace.py.original')]);
writeJson(path.join(out,'patch.json'),{container:a.container,...result});
console.log(JSON.stringify({container:a.container,patches:result,out}));
