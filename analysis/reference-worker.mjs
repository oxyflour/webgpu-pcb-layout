// A fresh-process offline routing path, independent of the tool result cache.
import fs from 'node:fs';
import {runtimeRoot,upstream,parseKicadBoard,designToProblem,normalizeProblem,routeBoard,evaluationRouting,repositoryMetrics} from '../harness/runtime.mjs';
import {readJson} from '../harness/io.mjs';
process.once('message',async({state,candidate})=>{
  try{
    const adapted=designToProblem(parseKicadBoard(fs.readFileSync(state.boardFile,'utf8'),state.board),{preplace:true,sides:'original'});
    adapted.input.components.forEach((c,i)=>{if(c.twoSided&&!c.fixed)c.fixed={...adapted.originalLayout[i]};});
    const saved=readJson(candidate),layout=saved.layout,problem=normalizeProblem(adapted.input);
    const ev=evaluationRouting(adapted.routing,{full:true});
    const route=routeBoard(adapted.routing,layout,adapted.sides,{...ev,diagnostics:true});
    const quality=repositoryMetrics(problem,layout),g=quality.geometry;
    const metrics={cleanNets:route.clean,nets:route.nets,vias:route.vias,hpwlMm:+quality.metrics.hpwl_mm.toFixed(3),
      violations:g.movableClearancePairs+g.movableOutside+g.movableMaskViolations+g.fixed_changed+g.side_changed,geometry:g,
      configuration:{protocol:'cypress-calibrated-v2',cellMm:ev.cell,rounds:ev.maxRounds,layers:adapted.routing.layers,clearanceMm:.1,routingRules:'calibrated-full'}};
    const {layoutSvg}=await upstream('bench/vlm/render.mjs');
    process.send({metrics,netStatus:Array.from(route.status),svg:layoutSvg(problem,adapted,layout,{title:''})},()=>process.exit(0));
  }catch(e){process.send({error:e.message},()=>process.exit(1));}
});
