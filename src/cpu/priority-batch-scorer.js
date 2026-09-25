import { worldPin, rotatedSize, sharesSide } from '../problem.js';

function priorityWeight(policy, netId, options){
  const p=Number(policy?.[netId]?.priority ?? options.defaultPriority);
  const base=options.minNetWeight + Math.max(0,p)/options.priorityScale;
  return policy?.[netId]?.topLocked ? base*options.topLockedBoost : base;
}

function weightedCongestion(problem, layout, policy, options){
  const gridW=options.gridWidth, gridH=options.gridHeight;
  const demand=new Float64Array(gridW*gridH);
  const cell=(x,y)=>[
    Math.max(0,Math.min(gridW-1,Math.floor(x/problem.canvas.width*gridW))),
    Math.max(0,Math.min(gridH-1,Math.floor(y/problem.canvas.height*gridH)))
  ];
  for(const net of problem.nets){
    const w=priorityWeight(policy,net.id,options);
    const [ax,ay]=cell(...worldPin(problem,layout,net.pins[0]));
    const touched=new Set();
    for(let k=1;k<net.pins.length;k++){
      const [tx,ty]=cell(...worldPin(problem,layout,net.pins[k]));
      const x0=Math.min(ax,tx),x1=Math.max(ax,tx),y0=Math.min(ay,ty),y1=Math.max(ay,ty);
      for(let x=x0;x<=x1;x++)touched.add(ay*gridW+x);
      for(let y=y0;y<=y1;y++)touched.add(y*gridW+tx);
    }
    for(const i of touched)demand[i]+=w;
  }
  let penalty=0;
  for(const d of demand){const over=Math.max(0,d-options.capacity);penalty+=over*over;}
  return penalty;
}

/** Resolve the priority-scorer option defaults shared by the CPU and GPU backends. */
export function resolvePriorityOptions(options={}){
  return {
    policy: options.policy ?? {},
    weights: {hpwl:1,overlap:4500,bounds:4500,congestion:4,...options.weights},
    defaultPriority: options.defaultPriority ?? 50,
    minNetWeight: options.minNetWeight ?? 0.20,
    priorityScale: options.priorityScale ?? 55,
    topLockedBoost: options.topLockedBoost ?? 2.2,
    gridWidth: options.coarse?.gridWidth ?? 40,
    gridHeight: options.coarse?.gridHeight ?? 30,
    capacity: options.coarse?.capacity ?? 2.2,
  };
}

/** Per-net HPWL/congestion weights for a priority policy. */
export function priorityNetWeights(problem, options={}){
  const o=resolvePriorityOptions(options);
  return Float64Array.from(problem.nets, net=>priorityWeight(o.policy,net.id,o));
}

/** CPU reference scorer whose placement objective is aware of surface-network priority. */
export class PriorityCpuBatchScorer {
  constructor(problem, options={}){
    this.problem=problem;
    const o=resolvePriorityOptions(options);
    this.policy=o.policy;
    this.weights=o.weights;
    this.options=o;
  }
  async scoreLayouts(layouts){ return layouts.map(l=>this.scoreLayout(l)); }
  scoreLayout(layout){
    const p=this.problem,o=this.options,w=this.weights;
    let weightedHpwl=0, rawHpwl=0;
    for(const net of p.nets){
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for(const pi of net.pins){const [x,y]=worldPin(p,layout,pi);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
      const hp=(maxX-minX)+(maxY-minY);rawHpwl+=hp;weightedHpwl+=priorityWeight(this.policy,net.id,o)*hp;
    }
    let overlap=0,bounds=0;
    for(let i=0;i<p.components.length;i++){
      const a=p.components[i],pa=layout[i],[aw,ah]=rotatedSize(a,pa.rotation);
      const left=Math.max(0,aw/2-pa.x),right=Math.max(0,pa.x+aw/2-p.canvas.width),top=Math.max(0,ah/2-pa.y),bottom=Math.max(0,pa.y+ah/2-p.canvas.height);
      bounds+=left*left+right*right+top*top+bottom*bottom;
      for(let j=i+1;j<p.components.length;j++){
        if(!sharesSide(p,i,pa,j,layout[j]))continue;
        const b=p.components[j],pb=layout[j],[bw,bh]=rotatedSize(b,pb.rotation);
        const ox=Math.max(0,Math.min(pa.x+aw/2,pb.x+bw/2)-Math.max(pa.x-aw/2,pb.x-bw/2));
        const oy=Math.max(0,Math.min(pa.y+ah/2,pb.y+bh/2)-Math.max(pa.y-ah/2,pb.y-bh/2));
        overlap+=ox*oy;
      }
    }
    const congestion=weightedCongestion(p,layout,this.policy,o);
    return {total:w.hpwl*weightedHpwl+w.overlap*overlap+w.bounds*bounds+w.congestion*congestion,
      hpwl:rawHpwl,weightedHpwl,overlap,bounds,congestion};
  }
  destroy(){}
}
