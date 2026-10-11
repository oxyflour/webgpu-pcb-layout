class MinHeap {
  constructor(){this.a=[];}
  push(item){const a=this.a;a.push(item);let i=a.length-1;while(i){const p=(i-1)>>1;if(a[p][0]<=item[0])break;a[i]=a[p];i=p;}a[i]=item;}
  pop(){const a=this.a;if(!a.length)return null;const root=a[0],last=a.pop();if(a.length){let i=0;a[0]=last;while(true){let l=i*2+1,r=l+1,b=i;if(l<a.length&&a[l][0]<a[b][0])b=l;if(r<a.length&&a[r][0]<a[b][0])b=r;if(b===i)break;[a[i],a[b]]=[a[b],a[i]];i=b;}}return root;}
  get length(){return this.a.length;}
}

/** CPU Dijkstra fallback mirroring GpuGridRouter's API. */
export class CpuGridRouter {
  async distanceField({width,height,sources,blocked,cellCost,infCost=1e20}) {
    const cells=width*height,distances=new Float32Array(cells);distances.fill(infCost);
    const heap=new MinHeap();
    for(const s of sources){if(blocked[s])continue;distances[s]=0;heap.push([0,s]);}
    let visits=0;
    while(heap.length){
      const [d,i]=heap.pop();if(d!==distances[i])continue;visits++;
      const x=i%width,y=(i/width)|0;
      const neigh=[];if(x>0)neigh.push(i-1);if(x+1<width)neigh.push(i+1);if(y>0)neigh.push(i-width);if(y+1<height)neigh.push(i+width);
      for(const n of neigh){if(blocked[n])continue;const nd=d+Math.max(cellCost[n],1e-4);if(nd<distances[n]){distances[n]=nd;heap.push([nd,n]);}}
    }
    return {distances,iterations:visits,infCost};
  }
  backtrack({width,height,distances,target,sources,infCost=1e20}) {
    if (!(distances[target] < infCost*0.5)) return null;
    const sourceSet=sources instanceof Set?sources:new Set(sources),path=[target];let cur=target;
    for(let step=0;step<width*height+1&&!sourceSet.has(cur);step++){
      const x=cur%width,y=(cur/width)|0;let best=cur,bestD=distances[cur];
      const cand=[];if(x>0)cand.push(cur-1);if(x+1<width)cand.push(cur+1);if(y>0)cand.push(cur-width);if(y+1<height)cand.push(cur+width);
      for(const n of cand)if(distances[n]<bestD-1e-5){best=n;bestD=distances[n];}
      if(best===cur)return null;cur=best;path.push(cur);
    }
    if(!sourceSet.has(cur))return null;path.reverse();return path;
  }
  async shortestPath(args){const f=await this.distanceField(args);const path=this.backtrack({...args,...f,target:args.target});return{path,distance:path?f.distances[args.target]:Infinity,iterations:f.iterations,distances:f.distances};}
}
