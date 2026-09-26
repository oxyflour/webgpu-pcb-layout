import { rotatedSize } from '../problem.js';
import { placementMasks, blockedArea } from '../geometry/mask.js';

function netPriorityWeight(policy, netId, options){
  const priority = Number(policy?.[netId]?.priority ?? options.defaultPriority);
  const base = options.minNetWeight + Math.max(0, priority) / options.priorityScale;
  return policy?.[netId]?.topLocked ? base * options.topLockedBoost : base;
}

/** Flat-slab orientation byte: bits 0-1 quarter turns, bit 2 bottom side. */
export function packOrientation(p){ return (p.rotation&3)|(p.side?4:0); }

/**
 * Flat, allocation-free placement objective used to pre-rank LNS proposals.
 * It deliberately uses a smaller approximate congestion grid; finalists are
 * always rescored by the exact scorer supplied to FastDeltaLnsOptimizer.
 */
export class CompiledPlacementModel {
  constructor(problem, options={}){
    this.problem = problem;
    this.n = problem.components.length;
    this.policy = options.policy ?? {};
    this.weights = {hpwl:1, overlap:4500, bounds:4500, congestion:4, ...options.weights};
    this.options = {
      defaultPriority: options.defaultPriority ?? 50,
      minNetWeight: options.minNetWeight ?? 0.20,
      priorityScale: options.priorityScale ?? 55,
      topLockedBoost: options.topLockedBoost ?? 2.2,
      gridWidth: options.coarse?.gridWidth ?? 20,
      gridHeight: options.coarse?.gridHeight ?? 15,
      capacity: options.coarse?.capacity ?? 2.0,
    };

    const n=this.n;
    this.compW = new Float64Array(n);
    this.compH = new Float64Array(n);
    this.fixed = new Uint8Array(n);
    this.rotatable = new Uint8Array(n);
    this.twoSided = new Uint8Array(n);
    for(let i=0;i<n;i++){
      const c=problem.components[i];
      this.compW[i]=c.width; this.compH[i]=c.height;
      this.fixed[i]=c.fixed?1:0; this.rotatable[i]=c.rotatable?1:0; this.twoSided[i]=c.twoSided?1:0;
    }
    const pn=problem.pins.length;
    this.pinComp = new Uint32Array(pn);
    this.pinX = new Float64Array(pn);
    this.pinY = new Float64Array(pn);
    for(let i=0;i<pn;i++){
      const p=problem.pins[i];
      this.pinComp[i]=p.componentIndex; this.pinX[i]=p.x; this.pinY[i]=p.y;
    }
    this.netOffsets = new Uint32Array(problem.nets.length+1);
    let totalPins=0;
    for(let i=0;i<problem.nets.length;i++){this.netOffsets[i]=totalPins;totalPins+=problem.nets[i].pins.length;}
    this.netOffsets[problem.nets.length]=totalPins;
    this.netPins = new Uint32Array(totalPins);
    this.netWeights = new Float64Array(problem.nets.length);
    let q=0;
    for(let ni=0;ni<problem.nets.length;ni++){
      const net=problem.nets[ni];
      this.netWeights[ni]=netPriorityWeight(this.policy, net.id, this.options);
      for(const pi of net.pins)this.netPins[q++]=pi;
    }
    this.demand = new Float64Array(this.options.gridWidth*this.options.gridHeight);
    this.masks = placementMasks(problem);
  }

  layoutToFlat(layout){
    const x=new Float64Array(this.n),y=new Float64Array(this.n),r=new Uint8Array(this.n);
    for(let i=0;i<this.n;i++){x[i]=layout[i].x;y[i]=layout[i].y;r[i]=packOrientation(layout[i]);}
    return {x,y,r};
  }

  flatToLayout(x,y,r,offset=0){
    const out=new Array(this.n);
    for(let i=0;i<this.n;i++)out[i]={x:x[offset+i],y:y[offset+i],rotation:r[offset+i]&3,side:(r[offset+i]>>2)&1};
    return out;
  }

  #pinWorld(pi, x, y, r, off){
    const ci=this.pinComp[pi], rot=r[off+ci]&3, px=(r[off+ci]&4)?-this.pinX[pi]:this.pinX[pi], py=this.pinY[pi];
    let rx,ry;
    if(rot===0){rx=px;ry=py;} else if(rot===1){rx=-py;ry=px;} else if(rot===2){rx=-px;ry=-py;} else {rx=py;ry=-px;}
    return [x[off+ci]+rx,y[off+ci]+ry];
  }

  scoreFlat(x,y,r,off=0){
    const p=this.problem,w=this.weights,o=this.options;
    let weightedHpwl=0,rawHpwl=0;
    for(let ni=0;ni<p.nets.length;ni++){
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      const a=this.netOffsets[ni],b=this.netOffsets[ni+1];
      for(let k=a;k<b;k++){
        const [px,py]=this.#pinWorld(this.netPins[k],x,y,r,off);
        if(px<minX)minX=px;if(px>maxX)maxX=px;if(py<minY)minY=py;if(py>maxY)maxY=py;
      }
      const hp=(maxX-minX)+(maxY-minY);rawHpwl+=hp;weightedHpwl+=this.netWeights[ni]*hp;
    }

    let overlap=0,bounds=0;
    for(let i=0;i<this.n;i++){
      const ri=r[off+i]&3, aw=(ri&1)?this.compH[i]:this.compW[i], ah=(ri&1)?this.compW[i]:this.compH[i];
      const xi=x[off+i], yi=y[off+i];
      const left=Math.max(0,aw/2-xi),right=Math.max(0,xi+aw/2-p.canvas.width),top=Math.max(0,ah/2-yi),bottom=Math.max(0,yi+ah/2-p.canvas.height);
      bounds+=left*left+right*right+top*top+bottom*bottom;
      if(this.masks)bounds+=blockedArea(this.masks,p,i,{x:xi,y:yi,rotation:ri,side:(r[off+i]>>2)&1});
      if(w.backside&&(r[off+i]&4)&&!this.twoSided[i])bounds+=w.backside/w.bounds*this.compW[i]*this.compH[i];
      for(let j=i+1;j<this.n;j++){
        if(((r[off+i]^r[off+j])&4) && !this.twoSided[i] && !this.twoSided[j])continue;
        const rj=r[off+j]&3,bw=(rj&1)?this.compH[j]:this.compW[j],bh=(rj&1)?this.compW[j]:this.compH[j];
        const ox=Math.max(0,Math.min(xi+aw/2,x[off+j]+bw/2)-Math.max(xi-aw/2,x[off+j]-bw/2));
        const oy=Math.max(0,Math.min(yi+ah/2,y[off+j]+bh/2)-Math.max(yi-ah/2,y[off+j]-bh/2));
        overlap+=ox*oy;
      }
    }

    const demand=this.demand; demand.fill(0);
    const gw=o.gridWidth,gh=o.gridHeight,cw=p.canvas.width/gw,ch=p.canvas.height/gh;
    const toCellX=v=>Math.max(0,Math.min(gw-1,Math.floor(v/cw)));
    const toCellY=v=>Math.max(0,Math.min(gh-1,Math.floor(v/ch)));
    for(let ni=0;ni<p.nets.length;ni++){
      const a=this.netOffsets[ni],b=this.netOffsets[ni+1]; if(b-a<2)continue;
      const [sx,sy]=this.#pinWorld(this.netPins[a],x,y,r,off); const ax=toCellX(sx),ay=toCellY(sy),nw=this.netWeights[ni];
      for(let k=a+1;k<b;k++){
        const [txw,tyw]=this.#pinWorld(this.netPins[k],x,y,r,off); const tx=toCellX(txw),ty=toCellY(tyw);
        const x0=Math.min(ax,tx),x1=Math.max(ax,tx); for(let gx=x0;gx<=x1;gx++)demand[ay*gw+gx]+=nw;
        const y0=Math.min(ay,ty),y1=Math.max(ay,ty); for(let gy=y0;gy<=y1;gy++)demand[gy*gw+tx]+=nw;
      }
    }
    let congestion=0;for(let i=0;i<demand.length;i++){const z=demand[i]-o.capacity;if(z>0)congestion+=z*z;}
    return {total:w.hpwl*weightedHpwl+w.overlap*overlap+w.bounds*bounds+w.congestion*congestion,
      hpwl:rawHpwl,weightedHpwl,overlap,bounds,congestion};
  }
}
