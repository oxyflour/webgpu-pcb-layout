import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './io.mjs';
import { normalizeProblem, parseKicadBoard, designToProblem, routeBoard, evaluationRouting, repositoryMetrics, worldPin } from './runtime.mjs';
export function loadBoard(state) {
  const adapted = designToProblem(parseKicadBoard(fs.readFileSync(state.boardFile,'utf8'),state.board), { preplace:true, sides:'original' });
  // Mechanical and through-hole constraints are part of the declared task.
  adapted.input.components.forEach((c,i) => { if (c.twoSided && !c.fixed) c.fixed = {...adapted.originalLayout[i]}; });
  delete adapted.originalLayout;
  return { adapted, problem:normalizeProblem(adapted.input) };
}
export function geometryMetrics(problem,layout){
  const quality=repositoryMetrics(problem,layout),geometry=quality.geometry;
  return {hpwlMm:+quality.metrics.hpwl_mm.toFixed(3),violations:geometry.movableClearancePairs+geometry.movableOutside+geometry.movableMaskViolations+geometry.fixed_changed+geometry.side_changed,geometry};
}
export function evaluate(adapted, problem, layout) {
  const base=geometryMetrics(problem,layout), ev = evaluationRouting(adapted.routing,{full:true});
  const routed = routeBoard(adapted.routing,layout,adapted.sides,{...ev,diagnostics:true});
  const configuration = { protocol:'cypress-calibrated-v2',cellMm:ev.cell,rounds:ev.maxRounds,layers:adapted.routing.layers,clearanceMm:.1,routingRules:'calibrated-full' };
  const metrics = { cleanNets:routed.clean,nets:routed.nets,vias:routed.vias,...base,configuration };
  const nets = problem.nets.map((net,i) => {
    const pts = net.pins.map(pi=>worldPin(problem,layout,pi)), members = [...new Set(net.pins.map(pi=>problem.pins[pi].componentIndex))];
    return {net:net.id,status:['empty','clean','conflict','unconnected'][routed.status[i]],vias:routed.netStats[i].vias,
      hpwlMm:+(Math.max(...pts.map(p=>p[0]))-Math.min(...pts.map(p=>p[0]))+Math.max(...pts.map(p=>p[1]))-Math.min(...pts.map(p=>p[1]))).toFixed(3),
      refs:members.map(i=>problem.components[i].id),mutableRefs:members.filter(i=>!problem.components[i].fixed).map(i=>problem.components[i].id)};
  });
  const bounded=n=>({...n,refCount:n.refs.length,mutableRefCount:n.mutableRefs.length,refs:n.refs.slice(0,16),mutableRefs:n.mutableRefs.slice(0,16)});
  return {metrics,observations:{netStatus:Array.from(routed.status)},diagnostics:{failedNets:nets.filter(n=>n.status!=='clean').sort((a,b)=>a.refs.length-b.refs.length).slice(0,6).map(bounded),highViaNets:[...nets].sort((a,b)=>b.vias-a.vias).slice(0,6).map(bounded)}};
}
export const placement = (problem,layout) => layout.map((p,i)=>({ref:problem.components[i].id,x:p.x,y:p.y,rotation:p.rotation*90,side:p.side?'bottom':'top'}));

// The adapter deliberately separates power from routed signal nets. Reattach
// every physical power/ground pad to the CUDA objective without changing the
// signal-routing task or its denominator.
export function withElectricalPower(adapted) {
  const input=structuredClone(adapted.input);
  for(const rail of adapted.power??[]) {
    if(rail.pads.length<2)continue;
    if(input.nets.some(n=>n.id===rail.name))throw Error('Duplicate power/signal net');
    const pins=rail.pads.map(pad=>{
      const component=input.components[pad.comp],pinId='p'+pad.padIndex;
      if(component.pins.some(p=>p.id===pinId))throw Error('Power pad already in signal input');
      component.pins.push({id:pinId,x:pad.x,y:pad.y});
      return {componentId:component.id,pinId};
    });
    input.nets.push({id:rail.name,pins});
  }
  return {...adapted,input};
}
