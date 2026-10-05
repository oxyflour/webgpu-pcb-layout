import fs from 'node:fs';
import {readJson} from './io.mjs';
const USAGE='layout.cmd COMMAND --input FILE.json. Commands: board-info, status, inspect, preview, place, score, evaluate, submit. Write UTF-8 JSON first. inspect needs candidate and 1-8 refs. place accepts candidate, optional exact targets, optional relax:{refs:[...]}, optional preserveRotation:[...]. Every place invokes NVIDIA Cypress and the common geometry legalizer; then score routes that saved candidate in a separate bounded call.';
try{
  const argv=process.argv.slice(2);if(argv[0]==='help'||argv[0]==='--help'){console.log(JSON.stringify({usage:USAGE}));process.exit(0);}
  const command=argv[0]?.replaceAll('-','_');if(!['board_info','status','inspect','preview','place','score','evaluate','submit'].includes(command))throw Error(USAGE);
  if(argv.length!==1&&(argv.length!==3||argv[1]!=='--input'))throw Error(USAGE);
  if(!['board_info','status'].includes(command)&&argv.length!==3)throw Error('Use --input FILE.json');
  const input=argv[2]?readJson(argv[2]):{};
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Input must be an object');
  if(!process.env.PCB_TOOL_URL)throw Error('This CLI requires the runner gateway');
  const r=await fetch(process.env.PCB_TOOL_URL,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.PCB_TOOL_TOKEN},body:JSON.stringify({command,input}),signal:AbortSignal.timeout(172000)}).then(r=>r.json());
  console.log(JSON.stringify(r));if(r.error)process.exitCode=1;
}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}
