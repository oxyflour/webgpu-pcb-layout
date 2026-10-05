import path from 'node:path';
import { loadBoard,evaluate,geometryMetrics,placement,withElectricalPower } from './board.mjs';
import { physicalPads,localTopology,normalizeProblem,upstream } from './runtime.mjs';
import { solve } from './cypress.mjs';
import {heldGeometry} from './held-geometry.mjs';
const {applyTargets,geometry}=await upstream('bench/interactive/validation.mjs');
export async function runJob({command,input,state,source,seed,jobDir}) {
  const {adapted,problem}=loadBoard(state),layout=source.layout;
  if(command==='board_info'){
    const parts=problem.components.map((c,i)=>({ref:c.id,width:c.width,height:c.height,fixed:!!c.fixed,allowedSides:c.sides,signalPins:c.pins.length,...placement(problem,layout)[i]})),page=input.page??0,pages=Math.ceil(parts.length/48);
    if(!Number.isInteger(page)||page<0||page>=pages)throw Error('Invalid board-info page');
    return {board:state.board,totalParts:parts.length,page,pages,parts:parts.slice(page*48,(page+1)*48),mainICs:parts.filter(p=>/^U/.test(p.ref)).sort((a,b)=>b.signalPins-a.signalPins).slice(0,10),fixedAnchors:parts.filter(p=>p.fixed).sort((a,b)=>b.signalPins-a.signalPins).slice(0,16),sizeMm:{width:problem.canvas.width,height:problem.canvas.height},fixed:parts.filter(p=>p.fixed).length,engine:'NVIDIA Cypress',notes:'Bodies and pin offsets are mm, y down; rotation degrees clockwise. Parts are paginated. No hidden human movable poses are exposed.'};
  }
  if(command==='inspect') {
    if(!Array.isArray(input.refs)||!input.refs.length||input.refs.length>8||new Set(input.refs).size!==input.refs.length)throw Error('inspect needs 1-8 unique refs');
    const refs=input.refs;
    const parts=refs.map(ref=>{const i=problem.components.findIndex(c=>c.id===ref);if(i<0)throw Error('Unknown ref');return {...placement(problem,layout)[i],width:problem.components[i].width,height:problem.components[i].height,fixed:!!problem.components[i].fixed,allowedSides:problem.components[i].sides};});
    const selected=new Set(refs.map(r=>problem.components.findIndex(c=>c.id===r))),allPads=adapted.routing.pads.filter(p=>selected.has(p.comp)),padPage=input.padPage??0,padPages=Math.max(1,Math.ceil(allPads.length/96));
    const incident=problem.nets.filter(n=>n.pins.some(pi=>selected.has(problem.pins[pi].componentIndex))),small=incident.filter(n=>new Set(n.pins.map(pi=>problem.pins[pi].componentIndex)).size<=16),netPage=input.netPage??0,netPages=Math.max(1,Math.ceil(small.length/32));
    if(!Number.isInteger(padPage)||padPage<0||padPage>=padPages||!Number.isInteger(netPage)||netPage<0||netPage>=netPages)throw Error('Invalid inspect padPage/netPage');
    const physical=physicalPads(problem,{...adapted.routing,pads:allPads.slice(padPage*96,(padPage+1)*96)},adapted.ir,layout,refs);
    const topology=localTopology({...problem,nets:small.slice(netPage*32,(netPage+1)*32)},layout,refs);
    return {candidate:input.candidate,parts,topology:{...topology,page:netPage,pages:netPages,totalSmallNets:small.length,omittedLargeNets:incident.length-small.length},physical:{...physical,page:padPage,pages:padPages,totalPads:allPads.length}};
  }
  if(command==='preview') {
    const applied=applyTargets(problem,layout,input.targets);
    return {candidate:input.candidate,targetCompatibility:heldGeometry(problem,applied.layout,applied.indices),geometry:geometry(problem,applied.layout,{pads:adapted.routing.pads}),note:'Read only. targetCompatibility checks held targets against fixed anchors and each other; geometry also includes existing movable conflicts. place requires targetCompatibility.passed.'};
  }
  if(command==='evaluate')return evaluate(adapted,problem,layout);
  if(command==='score'){
    if(!source.engine)throw Error('Only a produced Cypress candidate can be scored');
    const result=evaluate(adapted,problem,layout);
    return {...result,scored:true,eligible:source.engine.engineConverged&&source.engine.legalFailed===0&&result.metrics.violations===0};
  }
  if(command!=='place')throw Error('Unknown worker command');
  let initial=layout.map(p=>({...p})),held=[];
  if(input.targets) {const applied=applyTargets(problem,initial,input.targets);initial=applied.layout;held=applied.indices;}
  const compatible=heldGeometry(problem,initial,held);
  if(!compatible.passed)throw Error('Held target conflicts with immutable execution geometry: '+JSON.stringify(compatible.conflicts));
  let relax=null;
  if(input.relax!=null){
    if(Object.keys(input.relax).some(k=>k!=='refs')||!Array.isArray(input.relax.refs)||!input.relax.refs.length||input.relax.refs.length>48||new Set(input.relax.refs).size!==input.relax.refs.length)throw Error('relax requires 1-48 unique refs');
    relax=new Set(input.relax.refs.map(ref=>{const i=problem.components.findIndex(c=>c.id===ref);if(i<0||problem.components[i].fixed||held.includes(i))throw Error('Unknown, fixed or held relax ref');return i;}));
  }
  if(input.preserveRotation!=null&&(!Array.isArray(input.preserveRotation)||new Set(input.preserveRotation).size!==input.preserveRotation.length||input.preserveRotation.some(r=>!problem.components.some(c=>c.id===r))))throw Error('Invalid preserveRotation refs');
  const electrical=withElectricalPower(adapted);
  const execution={...electrical,input:{...electrical.input,components:electrical.input.components.map((c,i)=>c.fixed||held.includes(i)||relax&&!relax.has(i)?{...c,fixed:c.fixed??{...initial[i]}}:c)}};
  if(execution.input.components.every(c=>c.fixed))throw Error('Cypress needs at least one movable component');
  const solved=solve(execution,initial,{seed,dir:jobDir,preserve:input.preserveRotation??[]});
  solved.engine.objective={signalNets:problem.nets.length,powerNets:execution.input.nets.length-problem.nets.length,physicalPins:normalizeProblem(execution.input).pins.length};
  const result={metrics:geometryMetrics(problem,solved.layout)};
  const changed=placement(problem,solved.layout).filter((p,i)=>JSON.stringify(p)!==JSON.stringify(placement(problem,layout)[i])).map(p=>p.ref);
  const allowed=new Set([...(input.targets??[]).map(t=>t.ref),...(input.relax?.refs??[])]);
  const leaks=relax?changed.filter(ref=>!allowed.has(ref)):[];
  const drifts=(input.targets??[]).filter(t=>Object.keys(t).some(k=>t[k]!==placement(problem,solved.layout).find(p=>p.ref===t.ref)[k])).map(t=>t.ref);
  if(leaks.length||drifts.length)throw Error('Cypress scope/held-target contract failed');
  return {...result,...solved,placement:placement(problem,solved.layout),scope:{changed,leaks,targetDrifts:drifts},scored:false,needsScore:true,eligible:false,note:'CUDA output and geometry are saved. Call score on this candidate to obtain full routing metrics and eligibility; score never changes poses.'};
}
if(process.send)process.once('message',async payload=>{try{process.send(await runJob(payload),()=>process.exit(0));}catch(e){process.send({error:e.message},()=>process.exit(1));}});
