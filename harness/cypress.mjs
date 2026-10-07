import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { normalizeProblem, legalizeLayout } from './runtime.mjs';
import { exportIncremental, importIncremental } from './bridge.mjs';
import { readJson, writeJson } from './io.mjs';
export const SOLVE_SECONDS = 120;
function docker(argv, {log,check=true,timeout=15000}={}) {
  const fd=log?fs.openSync(log,'w'):null;
  const r=spawnSync('docker',argv,{encoding:'utf8',timeout,windowsHide:true,maxBuffer:8*1024*1024,stdio:fd==null?'pipe':['ignore',fd,fd]});
  if(fd!=null)fs.closeSync(fd);
  if(check&&(r.error||r.status!==0))throw Error(`Docker failed (${r.status}): ${r.error?.message??r.stderr??log}`);
  return r;
}
export function solve(adapted,initial,{seed,dir,preserve=[],clearance=.35,container=process.env.CYPRESS_CONTAINER??'codex-cypress-official-20261004'}) {
  const began=performance.now();
  const job='/work/harness-'+crypto.randomUUID();
  const baked=exportIncremental(adapted,initial,dir,preserve);
  const config={gpu:1,gpu_id:0,num_threads:8,dtype:'float32',num_bins_x:128,num_bins_y:128,
    global_place_stages:[{num_bins_x:128,num_bins_y:128,iteration:1000,learning_rate:.01,wirelength:'logsumexp',optimizer:'adam',Llambda_density_weight_iteration:5,Lsub_iteration:2,learning_rate_decay:.995}],
    target_density:.65,density_weight:.001,gamma:1,random_seed:seed,scale_factor:1,ignore_net_degree:10000,enable_fillers:1,gp_noise_ratio:.025,
    global_place_flag:1,legalize_flag:0,detailed_place_flag:0,stop_overflow:.1,net_crossing_flag:0,net_crossing_weight:.001,enable_rotation:1,
    random_center_init_flag:0,macro_overlap_flag:false,plot_flag:0,get_congestion_map:0,sort_nets_by_degree:0,deterministic_flag:1,macro_halo_x:0,macro_halo_y:0};
  writeJson(path.join(dir,'config.json'),config);
  docker(['exec',container,'mkdir','-p',job]);
  docker(['cp',path.join(import.meta.dirname,'run-cypress.py'),`${container}:${job}/run.py`]);
  docker(['cp',dir+'/.',`${container}:${job}`]);
  const started=performance.now();
  const processResult=docker(['exec','-w','/Cypress/install',container,'timeout','--signal=TERM','--kill-after=3s',SOLVE_SECONDS+'s','python3',job+'/run.py',job],{log:path.join(dir,'cypress.log'),check:false,timeout:128000});
  const processSeconds=(performance.now()-started)/1000;
  if(processResult.error||processResult.status!==0){
    docker(['cp',`${container}:/Cypress/install/DREAMPlace.log`,path.join(dir,'engine.log')],{check:false});
    const status={status:processResult.status===124||processResult.status===137||processResult.error?.code==='ETIMEDOUT'?'timeout':'error',engine:'NVIDIA Cypress',budgetSeconds:SOLVE_SECONDS,exitCode:processResult.status,processSeconds};
    writeJson(path.join(dir,'status.json'),status);throw Error(`Cypress ${status.status}; see job logs`);
  }
  for(const file of ['output.json','engine-metrics.json','engine.log'])docker(['cp',`${container}:${job}/${file}`,path.join(dir,file)]);
  const output=readJson(path.join(dir,'output.json')), imported=importIncremental(adapted,baked,output);
  writeJson(path.join(dir,'raw-layout.json'),imported.layout);
  const p=normalizeProblem(adapted.input),legal=legalizeLayout(p,imported.layout,{clearance,deadline:performance.now()+8000});
  const status={engine:'NVIDIA Cypress',pipeline:'cypress+shared-legalize',preset:'hpwl-density-rotation; crossing disabled, all electrical input retained',engineConverged:output.engine_converged,finalOverflow:output.final_overflow,iterations:output.iterations,
    status:output.engine_converged?'complete':'unconverged',solveSeconds:output.solve_s,processSeconds,totalSeconds:(performance.now()-began)/1000,budgetSeconds:SOLVE_SECONDS,
    engineSourceHash:output.engine_source_sha256,basicSourceHash:output.basic_source_sha256,rsmtDiagnosticExcludesDegreeGe:output.rsmt_diagnostic_excludes_degree_ge,inputPinErrorMm:baked.inputPinErrorMm,wrapperPinErrorMm:output.pin_roundtrip_max_error_mm,finalPinErrorMm:imported.finalPinErrorMm,legalFailed:legal.failed,legalMoved:legal.moved,seed,job};
  writeJson(path.join(dir,'status.json'),status);
  return {layout:legal.layout,engine:status};
}
