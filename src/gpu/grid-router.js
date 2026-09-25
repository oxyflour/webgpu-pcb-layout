import { createBuffer, readBuffer } from './device.js';

const RELAX_WGSL = /* wgsl */`
struct Params { dims: vec4<u32>, extra: vec4<f32> };
@group(0) @binding(0) var<storage, read> prevDist: array<f32>;
@group(0) @binding(1) var<storage, read_write> nextDist: array<f32>;
@group(0) @binding(2) var<storage, read> blocked: array<u32>;
@group(0) @binding(3) var<storage, read> cellCost: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
fn at(x:u32,y:u32)->u32 { return y*params.dims.x+x; }
@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let W=params.dims.x; let H=params.dims.y; let x=gid.x; let y=gid.y;
  if (x>=W || y>=H) { return; }
  let i=at(x,y); let INF=params.extra.x;
  if (blocked[i] != 0u) { nextDist[i]=INF; return; }
  var best=prevDist[i]; let c=max(cellCost[i], 0.0001);
  if (x>0u) { best=min(best, prevDist[at(x-1u,y)] + c); }
  if (x+1u<W) { best=min(best, prevDist[at(x+1u,y)] + c); }
  if (y>0u) { best=min(best, prevDist[at(x,y-1u)] + c); }
  if (y+1u<H) { best=min(best, prevDist[at(x,y+1u)] + c); }
  nextDist[i]=best;
}
`;

export class GpuGridRouter {
  constructor(device) {
    this.device=device;
    const module=device.createShaderModule({code:RELAX_WGSL});
    this.pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
  }

  async distanceField({width,height,sources,blocked,cellCost,maxIterations,infCost=1e20}) {
    const cells=width*height;
    if (blocked.length!==cells || cellCost.length!==cells) throw new Error('blocked/cellCost size mismatch');
    const d0=new Float32Array(cells); d0.fill(infCost); for (const s of sources) d0[s]=0;
    const device=this.device,U=GPUBufferUsage;
    let a=createBuffer(device,d0.byteLength,U.STORAGE|U.COPY_SRC,d0);
    let b=createBuffer(device,d0.byteLength,U.STORAGE|U.COPY_SRC);
    const blockBuf=createBuffer(device,blocked.byteLength,U.STORAGE,blocked);
    const costBuf=createBuffer(device,cellCost.byteLength,U.STORAGE,cellCost);
    const pbufData=new ArrayBuffer(32),dv=new DataView(pbufData);
    dv.setUint32(0,width,true);dv.setUint32(4,height,true);dv.setUint32(8,cells,true);dv.setFloat32(16,infCost,true);
    const pbuf=createBuffer(device,32,U.UNIFORM,new Uint8Array(pbufData));
    const bgAB=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:a}},{binding:1,resource:{buffer:b}},{binding:2,resource:{buffer:blockBuf}},{binding:3,resource:{buffer:costBuf}},{binding:4,resource:{buffer:pbuf}}
    ]});
    const bgBA=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:b}},{binding:1,resource:{buffer:a}},{binding:2,resource:{buffer:blockBuf}},{binding:3,resource:{buffer:costBuf}},{binding:4,resource:{buffer:pbuf}}
    ]});
    const iters=maxIterations ?? Math.min(cells-1, 4*(width+height));
    const enc=device.createCommandEncoder(); const pass=enc.beginComputePass(); pass.setPipeline(this.pipeline);
    for(let it=0;it<iters;it++) { pass.setBindGroup(0,(it&1)?bgBA:bgAB); pass.dispatchWorkgroups(Math.ceil(width/16),Math.ceil(height/16)); }
    pass.end(); device.queue.submit([enc.finish()]);
    const finalBuf=(iters&1)?b:a;
    const distances=new Float32Array(await readBuffer(device,finalBuf,d0.byteLength));
    a.destroy();b.destroy();blockBuf.destroy();costBuf.destroy();pbuf.destroy();
    return {distances,iterations:iters,infCost};
  }

  backtrack({width,height,distances,target,sources,cellCost,infCost=1e20}) {
    if (!(distances[target] < infCost*0.5)) return null;
    const sourceSet = sources instanceof Set ? sources : new Set(sources);
    const path=[target]; let cur=target; const max=width*height+1;
    for(let step=0;step<max && !sourceSet.has(cur);step++) {
      const x=cur%width,y=Math.floor(cur/width); let best=cur,bestD=distances[cur];
      const cand=[]; if(x>0)cand.push(cur-1);if(x+1<width)cand.push(cur+1);if(y>0)cand.push(cur-width);if(y+1<height)cand.push(cur+width);
      for(const n of cand) if(distances[n] < bestD-1e-5) { best=n; bestD=distances[n]; }
      if(best===cur) return null;
      cur=best;path.push(cur);
    }
    if(!sourceSet.has(cur)) return null;
    path.reverse(); return path;
  }

  async shortestPath(args) {
    const field=await this.distanceField(args);
    const path=this.backtrack({...args,...field,target:args.target});
    return {path,distance:path?field.distances[args.target]:Infinity,iterations:field.iterations,distances:field.distances};
  }
}
