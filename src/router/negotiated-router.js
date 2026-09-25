import { GpuGridRouter } from '../gpu/grid-router.js';
import { makeGrid, rasterizeComponents, carveNetPins, guardCellsForPath, pathToPolyline } from './geometry.js';

function rng32(seed) { let x=seed>>>0||1; return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;}; }
function shuffle(a,rnd){for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

export class GpuNegotiatedRouter {
  constructor(device, problem, options={}) {
    this.device=device;this.problem=problem;this.grid=makeGrid(problem,options);
    this.wave=options.waveRouter ?? new GpuGridRouter(device);
    this.options={
      componentClearance:options.componentClearance ?? 0,
      wireClearanceCells:options.wireClearanceCells ?? 1,
      escapeCells:options.escapeCells ?? 16,
      maxRounds:options.maxRounds ?? 20,
      presentFactor:options.presentFactor ?? 4,
      historyFactor:options.historyFactor ?? 8,
      maxWaveIterations:options.maxWaveIterations ?? Math.min(this.grid.width*this.grid.height-1,8*(this.grid.width+this.grid.height)),
      seed:options.seed ?? 1,
      onRound:options.onRound ?? null,
      blockComponents:options.blockComponents ?? true
    };
  }

  async routeNet(layout,net,baseBlocked,usage,history) {
    const {blocked,pinCells}=carveNetPins(this.problem,layout,this.grid,baseBlocked,net,this.options.escapeCells);
    const cells=this.grid.width*this.grid.height;
    const cellCost=new Float32Array(cells);
    for(let i=0;i<cells;i++)cellCost[i]=1+this.options.presentFactor*usage[i]+this.options.historyFactor*history[i];
    const tree=new Set([pinCells[0]]), remaining=new Set(pinCells.slice(1)), branches=[];
    while(remaining.size) {
      const field=await this.wave.distanceField({width:this.grid.width,height:this.grid.height,sources:[...tree],blocked,cellCost,maxIterations:this.options.maxWaveIterations});
      let target=-1,best=Infinity;for(const t of remaining){const d=field.distances[t];if(d<best){best=d;target=t;}}
      if(target<0 || !Number.isFinite(best) || best>=field.infCost*.5) return {ok:false,branches,tree,guard:new Set()};
      const path=this.wave.backtrack({width:this.grid.width,height:this.grid.height,distances:field.distances,target,sources:tree,cellCost,infCost:field.infCost});
      if(!path)return{ok:false,branches,tree,guard:new Set()};
      branches.push(path);for(const c of path)tree.add(c);remaining.delete(target);
    }
    const guard=new Set();for(const path of branches)for(const c of guardCellsForPath(path,this.grid,this.options.wireClearanceCells))guard.add(c);
    return {ok:true,branches,tree,guard};
  }

  async route(layout) {
    const baseBlocked=this.options.blockComponents
      ? rasterizeComponents(this.problem,layout,this.grid,this.options.componentClearance)
      : new Uint32Array(this.grid.width*this.grid.height);
    const cells=this.grid.width*this.grid.height, history=new Float32Array(cells), rnd=rng32(this.options.seed);
    let best=null;
    for(let round=0;round<this.options.maxRounds;round++) {
      const usage=new Uint16Array(cells);const netRoutes=new Array(this.problem.nets.length);let failed=0;
      const order=[...this.problem.nets.keys()];
      if(round===0) order.sort((a,b)=>this.problem.nets[b].pins.length-this.problem.nets[a].pins.length); else shuffle(order,rnd);
      for(const ni of order) {
        const r=await this.routeNet(layout,this.problem.nets[ni],baseBlocked,usage,history);netRoutes[ni]=r;
        if(!r.ok){failed++;continue;} for(const c of r.guard)usage[c]++;
      }
      let conflicts=0;for(let i=0;i<cells;i++)if(usage[i]>1){const over=usage[i]-1;conflicts+=over;history[i]+=over;}
      const metric=failed*1e9+conflicts;
      if(!best||metric<best.metric)best={metric,failed,conflicts,round,netRoutes,usage};
      if(this.options.onRound) await this.options.onRound({round,failed,conflicts,metric,routes:this.#format(netRoutes)});
      if(failed===0&&conflicts===0) {
        return {status:'routed',grid:this.grid,rounds:round+1,routes:this.#format(netRoutes),conflicts:0};
      }
    }
    return {status:'unrouted',grid:this.grid,rounds:this.options.maxRounds,failedNets:best.failed,conflicts:best.conflicts,routes:this.#format(best.netRoutes)};
  }

  #format(netRoutes) {
    return this.problem.nets.map((net,i)=>({
      netId:net.id,
      ok:!!netRoutes[i]?.ok,
      branches:(netRoutes[i]?.branches??[]).map(path=>({cells:path,polyline:pathToPolyline(this.problem,this.grid,path)}))
    }));
  }
}
