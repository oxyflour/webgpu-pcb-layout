import { normalizeProblem } from '../problem.js';
import { CpuGridRouter } from '../cpu/grid-router.js';
import { GpuNegotiatedRouter } from './negotiated-router.js';

/**
 * Priority-aware multilayer allocator.
 *
 * The allocator greedily maximizes the priority retained on earlier layers.
 * For every candidate net it runs the package's negotiated router on the
 * complete tentative layer. A net is accepted only if that layer remains
 * zero-conflict routable; otherwise it is deferred to the next layer.
 *
 * This is deliberately a routing-feasibility allocator, not a color-only demo.
 */
export class PriorityMultilayerRouter {
  constructor(rawProblem, layout, options={}) {
    this.rawProblem=rawProblem;
    this.layout=layout;
    this.policy=options.policy ?? {};
    this.layers=options.layers ?? [
      {id:'TOP', blockComponents:true},
      {id:'L2', blockComponents:false},
      {id:'L3', blockComponents:false},
      {id:'BOTTOM', blockComponents:true}
    ];
    this.routerDefaults={
      gridWidth: options.gridWidth ?? 128,
      gridHeight: options.gridHeight ?? 96,
      componentClearance: options.componentClearance ?? 0.5,
      wireClearanceCells: options.wireClearanceCells ?? 0,
      escapeCells: options.escapeCells ?? 12,
      maxRounds: options.maxRounds ?? 12,
      presentFactor: options.presentFactor ?? 4,
      historyFactor: options.historyFactor ?? 10,
      seed: options.seed ?? 1
    };
    this.onDecision=options.onDecision ?? null;
  }

  priority(netId){return Number(this.policy[netId]?.priority ?? 50);}
  topLocked(netId){return !!this.policy[netId]?.topLocked;}
  allowedLayers(netId){return this.policy[netId]?.allowedLayers ?? null;}

  #subproblem(netIds){
    const keep=new Set(netIds);
    return normalizeProblem({
      canvas:this.rawProblem.canvas,
      components:this.rawProblem.components,
      nets:this.rawProblem.nets.filter(n=>keep.has(n.id))
    });
  }

  async #route(netIds, layer, seedOffset=0){
    if(!netIds.length) return {status:'routed',routes:[],conflicts:0,rounds:0};
    const problem=this.#subproblem(netIds);
    const opts={...this.routerDefaults,...layer.routerOptions,blockComponents:layer.blockComponents ?? true,seed:(this.routerDefaults.seed+seedOffset)>>>0};
    const router=new GpuNegotiatedRouter(null,problem,{...opts,waveRouter:new CpuGridRouter()});
    return await router.route(this.layout);
  }

  async route(){
    const all=this.rawProblem.nets.map(n=>n.id);
    const assignment=new Map();
    const layerResults=[];
    const decisions=[];

    // Hard surface obligations are installed first and validated together.
    const locked=all.filter(id=>this.topLocked(id));
    if(locked.length){
      const top=this.layers[0];
      const r=await this.#route(locked,top,0x1000);
      if(r.status!=='routed'){
        return {status:'locked-top-unroutable',locked,routesByLayer:[],assignment:Object.fromEntries(assignment),decisions};
      }
      for(const id of locked)assignment.set(id,top.id);
    }

    let remaining=all.filter(id=>!assignment.has(id));
    remaining.sort((a,b)=>this.priority(b)-this.priority(a)||a.localeCompare(b));

    for(let li=0;li<this.layers.length;li++){
      const layer=this.layers[li];
      let selected=li===0 ? locked.slice() : [];
      const deferred=[];
      const candidates=remaining.filter(id=>{
        const allow=this.allowedLayers(id);return !allow || allow.includes(layer.id);
      });
      const skipped=new Set(remaining.filter(id=>!candidates.includes(id)));
      for(const id of candidates){
        const tentative=[...selected,id];
        const trial=await this.#route(tentative,layer,li*10000+decisions.length+1);
        const accept=trial.status==='routed';
        if(accept){selected.push(id);assignment.set(id,layer.id);} else deferred.push(id);
        const row={layer:layer.id,netId:id,priority:this.priority(id),accepted:accept,selectedCount:selected.length,
          failedNets:trial.failedNets??0,conflicts:trial.conflicts??0};
        decisions.push(row);if(this.onDecision)await this.onDecision({...row,selected:selected.slice(),assignment:Object.fromEntries(assignment)});
      }
      // Nets disallowed on this layer remain deferred without a route trial.
      for(const id of skipped)deferred.push(id);
      // Final route is recomputed so exported paths correspond exactly to the final selected set.
      const finalRoute=await this.#route(selected,layer,li*10000+0x777);
      layerResults.push({layer:layer.id,netIds:selected.slice(),route:finalRoute,blockComponents:layer.blockComponents ?? true});
      remaining=remaining.filter(id=>!assignment.has(id));
      if(!remaining.length)break;
    }
    return {status:remaining.length?'partially-routed':'routed',unassigned:remaining,assignment:Object.fromEntries(assignment),routesByLayer:layerResults,decisions};
  }
}
