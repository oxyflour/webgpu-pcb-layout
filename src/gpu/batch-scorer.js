import { createBuffer, readBuffer } from './device.js';

const WG = 256;

const HPWL_WGSL = /* wgsl */`
struct Placement { pos: vec2<f32>, rot: u32, pad: u32 };
struct Params { counts: vec4<u32>, canvasWeights: vec4<f32>, misc: vec4<f32>, coarse: vec4<u32> };
@group(0) @binding(0) var<storage, read> placements: array<Placement>;
@group(0) @binding(1) var<storage, read> pinComponent: array<u32>;
@group(0) @binding(2) var<storage, read> pinLocal: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> netOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> netPins: array<u32>;
@group(0) @binding(5) var<storage, read_write> outSum: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;
var<workgroup> partial: array<f32, ${WG}>;

fn rotateQuarter(v: vec2<f32>, r: u32) -> vec2<f32> {
  switch (r & 3u) {
    case 0u: { return v; }
    case 1u: { return vec2<f32>(-v.y, v.x); }
    case 2u: { return -v; }
    default: { return vec2<f32>(v.y, -v.x); }
  }
}

@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let candidate = wid.x;
  let lid = lid3.x;
  let candidateCount = params.counts.x;
  let componentCount = params.counts.y;
  let netCount = params.counts.z;
  if (candidate >= candidateCount) { return; }
  var acc = 0.0;
  var n = lid;
  loop {
    if (n >= netCount) { break; }
    let begin = netOffsets[n];
    let end = netOffsets[n + 1u];
    var minP = vec2<f32>(1e30, 1e30);
    var maxP = vec2<f32>(-1e30, -1e30);
    var k = begin;
    loop {
      if (k >= end) { break; }
      let pi = netPins[k];
      let ci = pinComponent[pi];
      let pl = placements[candidate * componentCount + ci];
      let p = pl.pos + rotateQuarter(pinLocal[pi], pl.rot);
      minP = min(minP, p); maxP = max(maxP, p);
      k = k + 1u;
    }
    acc = acc + (maxP.x - minP.x) + (maxP.y - minP.y);
    n = n + ${WG}u;
  }
  partial[lid] = acc;
  workgroupBarrier();
  var stride = ${WG / 2}u;
  loop {
    if (stride == 0u) { break; }
    if (lid < stride) { partial[lid] = partial[lid] + partial[lid + stride]; }
    workgroupBarrier();
    stride = stride >> 1u;
  }
  if (lid == 0u) { outSum[candidate] = partial[0]; }
}
`;

const OVERLAP_WGSL = /* wgsl */`
struct Placement { pos: vec2<f32>, rot: u32, pad: u32 };
struct Params { counts: vec4<u32>, canvasWeights: vec4<f32>, misc: vec4<f32>, coarse: vec4<u32> };
@group(0) @binding(0) var<storage, read> placements: array<Placement>;
@group(0) @binding(1) var<storage, read> componentSize: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> pairs: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> outSum: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
var<workgroup> partial: array<f32, ${WG}>;
fn rs(s: vec2<f32>, r: u32) -> vec2<f32> { return select(s, s.yx, (r & 1u) == 1u); }
@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let candidate = wid.x; let lid = lid3.x;
  let candidateCount = params.counts.x; let componentCount = params.counts.y; let pairCount = params.counts.w;
  if (candidate >= candidateCount) { return; }
  var acc = 0.0; var q = lid;
  loop {
    if (q >= pairCount) { break; }
    let pair = pairs[q];
    let a = placements[candidate * componentCount + pair.x];
    let b = placements[candidate * componentCount + pair.y];
    let as = rs(componentSize[pair.x], a.rot); let bs = rs(componentSize[pair.y], b.rot);
    let amin = a.pos - 0.5 * as; let amax = a.pos + 0.5 * as;
    let bmin = b.pos - 0.5 * bs; let bmax = b.pos + 0.5 * bs;
    let ox = max(0.0, min(amax.x, bmax.x) - max(amin.x, bmin.x));
    let oy = max(0.0, min(amax.y, bmax.y) - max(amin.y, bmin.y));
    acc = acc + ox * oy; q = q + ${WG}u;
  }
  partial[lid] = acc; workgroupBarrier();
  var stride = ${WG / 2}u;
  loop { if (stride == 0u) { break; } if (lid < stride) { partial[lid] += partial[lid + stride]; } workgroupBarrier(); stride >>= 1u; }
  if (lid == 0u) { outSum[candidate] = partial[0]; }
}
`;

const BOUNDS_WGSL = /* wgsl */`
struct Placement { pos: vec2<f32>, rot: u32, pad: u32 };
struct Params { counts: vec4<u32>, canvasWeights: vec4<f32>, misc: vec4<f32>, coarse: vec4<u32> };
@group(0) @binding(0) var<storage, read> placements: array<Placement>;
@group(0) @binding(1) var<storage, read> componentSize: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> outSum: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
var<workgroup> partial: array<f32, ${WG}>;
fn rs(s: vec2<f32>, r: u32) -> vec2<f32> { return select(s, s.yx, (r & 1u) == 1u); }
@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let candidate = wid.x; let lid = lid3.x;
  let candidateCount = params.counts.x; let componentCount = params.counts.y;
  let W = params.canvasWeights.x; let H = params.canvasWeights.y;
  if (candidate >= candidateCount) { return; }
  var acc = 0.0; var i = lid;
  loop {
    if (i >= componentCount) { break; }
    let p = placements[candidate * componentCount + i]; let s = rs(componentSize[i], p.rot);
    let left = max(0.0, 0.5 * s.x - p.pos.x);
    let right = max(0.0, p.pos.x + 0.5 * s.x - W);
    let top = max(0.0, 0.5 * s.y - p.pos.y);
    let bottom = max(0.0, p.pos.y + 0.5 * s.y - H);
    acc += left*left + right*right + top*top + bottom*bottom; i += ${WG}u;
  }
  partial[lid] = acc; workgroupBarrier();
  var stride = ${WG / 2}u;
  loop { if (stride == 0u) { break; } if (lid < stride) { partial[lid] += partial[lid + stride]; } workgroupBarrier(); stride >>= 1u; }
  if (lid == 0u) { outSum[candidate] = partial[0]; }
}
`;


const CONGESTION_WGSL = /* wgsl */`
struct Placement { pos: vec2<f32>, rot: u32, pad: u32 };
struct Params { counts: vec4<u32>, canvasWeights: vec4<f32>, misc: vec4<f32>, coarse: vec4<u32> };
@group(0) @binding(0) var<storage, read> placements: array<Placement>;
@group(0) @binding(1) var<storage, read> pinComponent: array<u32>;
@group(0) @binding(2) var<storage, read> pinLocal: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> netOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> netPins: array<u32>;
@group(0) @binding(5) var<storage, read_write> outSum: array<f32>;
@group(0) @binding(6) var<uniform> params: Params;
var<workgroup> partial: array<f32, ${WG}>;
fn rotateQuarter(v: vec2<f32>, r: u32) -> vec2<f32> {
  switch (r & 3u) { case 0u:{return v;} case 1u:{return vec2<f32>(-v.y,v.x);} case 2u:{return -v;} default:{return vec2<f32>(v.y,-v.x);} }
}
fn pinCell(candidate:u32, pi:u32)->vec2<u32> {
  let ci=pinComponent[pi]; let pl=placements[candidate*params.counts.y+ci]; let p=pl.pos+rotateQuarter(pinLocal[pi],pl.rot);
  let gx=u32(clamp(i32(floor(p.x/params.canvasWeights.x*f32(params.coarse.x))),0,i32(params.coarse.x)-1));
  let gy=u32(clamp(i32(floor(p.y/params.canvasWeights.y*f32(params.coarse.y))),0,i32(params.coarse.y)-1));
  return vec2<u32>(gx,gy);
}
fn between(v:u32,a:u32,b:u32)->bool { return v>=min(a,b) && v<=max(a,b); }
@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid:vec3<u32>,@builtin(local_invocation_id) lid3:vec3<u32>) {
  let candidate=wid.x;let lid=lid3.x;if(candidate>=params.counts.x){return;}
  let gw=params.coarse.x;let gh=params.coarse.y;let cells=gw*gh;var acc=0.0;var c=lid;
  loop {
    if(c>=cells){break;} let cx=c%gw;let cy=c/gw;var demand=0u;var n=0u;
    loop {
      if(n>=params.counts.z){break;} let begin=netOffsets[n];let end=netOffsets[n+1u];var used=false;
      if(end>begin+1u){let a=pinCell(candidate,netPins[begin]);var k=begin+1u;loop{if(k>=end){break;}let t=pinCell(candidate,netPins[k]);
        if((cy==a.y && between(cx,a.x,t.x)) || (cx==t.x && between(cy,a.y,t.y))){used=true;break;} k+=1u;}}
      if(used){demand+=1u;} n+=1u;
    }
    let over=max(0,i32(demand)-i32(params.coarse.z));acc+=f32(over*over);c+=${WG}u;
  }
  partial[lid]=acc;workgroupBarrier();var stride=${WG/2}u;
  loop{if(stride==0u){break;}if(lid<stride){partial[lid]+=partial[lid+stride];}workgroupBarrier();stride>>=1u;}
  if(lid==0u){outSum[candidate]=partial[0];}
}
`;

const REDUCE_WGSL = /* wgsl */`
struct Params { counts: vec4<u32>, canvasWeights: vec4<f32>, misc: vec4<f32>, coarse: vec4<u32> };
struct ScoreOut { a: vec4<f32>, b: vec4<f32> };
@group(0) @binding(0) var<storage, read> hpwl: array<f32>;
@group(0) @binding(1) var<storage, read> overlap: array<f32>;
@group(0) @binding(2) var<storage, read> bounds: array<f32>;
@group(0) @binding(3) var<storage, read> congestion: array<f32>;
@group(0) @binding(4) var<storage, read_write> scores: array<ScoreOut>;
@group(0) @binding(5) var<uniform> params: Params;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x; if (i >= params.counts.x) { return; }
  let total = params.canvasWeights.z * hpwl[i] + params.canvasWeights.w * overlap[i] + params.misc.x * bounds[i] + params.misc.y * congestion[i];
  scores[i].a = vec4<f32>(total, hpwl[i], overlap[i], bounds[i]);
  scores[i].b = vec4<f32>(congestion[i], 0.0, 0.0, 0.0);
}
`;

function staticData(problem) {
  const componentSize = new Float32Array(problem.components.length * 2);
  problem.components.forEach((c, i) => { componentSize[2*i] = c.width; componentSize[2*i+1] = c.height; });
  const pinComponent = new Uint32Array(problem.pins.length);
  const pinLocal = new Float32Array(problem.pins.length * 2);
  problem.pins.forEach((p, i) => { pinComponent[i] = p.componentIndex; pinLocal[2*i] = p.x; pinLocal[2*i+1] = p.y; });
  let totalPins = 0; for (const n of problem.nets) totalPins += n.pins.length;
  const netOffsets = new Uint32Array(problem.nets.length + 1);
  const netPins = new Uint32Array(totalPins); let k = 0;
  problem.nets.forEach((n, i) => { netOffsets[i] = k; for (const p of n.pins) netPins[k++] = p; }); netOffsets[problem.nets.length] = k;
  const q = problem.components.length * (problem.components.length - 1) / 2;
  const pairs = new Uint32Array(q * 2); k = 0;
  for (let i=0;i<problem.components.length;i++) for (let j=i+1;j<problem.components.length;j++) { pairs[k++]=i; pairs[k++]=j; }
  return { componentSize, pinComponent, pinLocal, netOffsets, netPins, pairs, pairCount:q };
}

function nextPow2(v) { let n=1; while(n<v)n<<=1; return n; }

function packLayoutsInto(layouts, componentCount, hostBuffer) {
  const needed = layouts.length * componentCount * 16;
  if (hostBuffer.byteLength < needed) throw new Error('host placement buffer too small');
  const dv = new DataView(hostBuffer); let o = 0;
  for (const layout of layouts) {
    if (layout.length !== componentCount) throw new Error('layout component count mismatch');
    for (const p of layout) {
      dv.setFloat32(o, p.x, true); dv.setFloat32(o+4, p.y, true);
      dv.setUint32(o+8, p.rotation & 3, true); dv.setUint32(o+12, 0, true); o += 16;
    }
  }
  return new Uint8Array(hostBuffer, 0, needed);
}

export class GpuBatchScorer {
  constructor(device, problem, options = {}) {
    this.device = device; this.problem = problem;
    this.weights = { hpwl: 1, overlap: 1000, bounds: 1000, congestion: 1, ...options.weights };
    this.coarse = { gridWidth: 32, gridHeight: 32, capacity: 1, ...options.coarseCongestion };
    this.static = staticData(problem);
    const U = GPUBufferUsage;
    const d = this.static;
    this.buffers = {
      componentSize: createBuffer(device, d.componentSize.byteLength, U.STORAGE, d.componentSize),
      pinComponent: createBuffer(device, d.pinComponent.byteLength, U.STORAGE, d.pinComponent),
      pinLocal: createBuffer(device, d.pinLocal.byteLength, U.STORAGE, d.pinLocal),
      netOffsets: createBuffer(device, d.netOffsets.byteLength, U.STORAGE, d.netOffsets),
      netPins: createBuffer(device, d.netPins.byteLength, U.STORAGE, d.netPins),
      pairs: createBuffer(device, Math.max(8, d.pairs.byteLength), U.STORAGE, d.pairs.byteLength ? d.pairs : new Uint32Array(2))
    };
    this.pipelines = {
      hpwl: device.createComputePipeline({ layout:'auto', compute:{ module:device.createShaderModule({code:HPWL_WGSL}), entryPoint:'main' } }),
      overlap: device.createComputePipeline({ layout:'auto', compute:{ module:device.createShaderModule({code:OVERLAP_WGSL}), entryPoint:'main' } }),
      bounds: device.createComputePipeline({ layout:'auto', compute:{ module:device.createShaderModule({code:BOUNDS_WGSL}), entryPoint:'main' } }),
      congestion: device.createComputePipeline({ layout:'auto', compute:{ module:device.createShaderModule({code:CONGESTION_WGSL}), entryPoint:'main' } }),
      reduce: device.createComputePipeline({ layout:'auto', compute:{ module:device.createShaderModule({code:REDUCE_WGSL}), entryPoint:'main' } })
    };
    this.dynamic = null;
    this.capacity = 0;
    this.hostPlacementBuffer = new ArrayBuffer(0);
    this.paramsData = new ArrayBuffer(64);
  }

  #ensureCapacity(count) {
    if (count <= this.capacity && this.dynamic) return;
    const device=this.device,U=GPUBufferUsage;
    if (this.dynamic) for (const b of Object.values(this.dynamic)) b.destroy();
    this.capacity = nextPow2(count);
    const c=this.capacity, componentCount=this.problem.components.length;
    this.hostPlacementBuffer = new ArrayBuffer(c * componentCount * 16);
    this.dynamic = {
      placements:createBuffer(device, c*componentCount*16, U.STORAGE|U.COPY_DST),
      hpwl:createBuffer(device, c*4, U.STORAGE),
      overlap:createBuffer(device, c*4, U.STORAGE),
      bounds:createBuffer(device, c*4, U.STORAGE),
      congestion:createBuffer(device, c*4, U.STORAGE),
      scores:createBuffer(device, c*32, U.STORAGE|U.COPY_SRC),
      readback:createBuffer(device, c*32, U.COPY_DST|U.MAP_READ),
      params:createBuffer(device, 64, U.UNIFORM|U.COPY_DST)
    };
  }

  async scoreLayouts(layouts) {
    if (!layouts.length) return [];
    if (layouts.length > 65535) throw new Error('scoreLayouts supports at most 65535 candidates per dispatch; chunk larger populations');
    const device = this.device;
    this.#ensureCapacity(layouts.length);
    const d=this.dynamic;
    const placementsData=packLayoutsInto(layouts,this.problem.components.length,this.hostPlacementBuffer);
    device.queue.writeBuffer(d.placements,0,placementsData.buffer,placementsData.byteOffset,placementsData.byteLength);

    const dv = new DataView(this.paramsData);
    dv.setUint32(0, layouts.length, true); dv.setUint32(4, this.problem.components.length, true);
    dv.setUint32(8, this.problem.nets.length, true); dv.setUint32(12, this.static.pairCount, true);
    dv.setFloat32(16, this.problem.canvas.width, true); dv.setFloat32(20, this.problem.canvas.height, true);
    dv.setFloat32(24, this.weights.hpwl, true); dv.setFloat32(28, this.weights.overlap, true);
    dv.setFloat32(32, this.weights.bounds, true); dv.setFloat32(36, this.weights.congestion, true);
    dv.setUint32(48, this.coarse.gridWidth, true); dv.setUint32(52, this.coarse.gridHeight, true); dv.setUint32(56, this.coarse.capacity, true);
    device.queue.writeBuffer(d.params,0,this.paramsData);

    const enc=device.createCommandEncoder();const pass=enc.beginComputePass();
    pass.setPipeline(this.pipelines.hpwl);
    pass.setBindGroup(0,device.createBindGroup({layout:this.pipelines.hpwl.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:d.placements}},{binding:1,resource:{buffer:this.buffers.pinComponent}},{binding:2,resource:{buffer:this.buffers.pinLocal}},
      {binding:3,resource:{buffer:this.buffers.netOffsets}},{binding:4,resource:{buffer:this.buffers.netPins}},{binding:5,resource:{buffer:d.hpwl}},{binding:6,resource:{buffer:d.params}}
    ]}));pass.dispatchWorkgroups(layouts.length);
    pass.setPipeline(this.pipelines.overlap);
    pass.setBindGroup(0,device.createBindGroup({layout:this.pipelines.overlap.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:d.placements}},{binding:1,resource:{buffer:this.buffers.componentSize}},{binding:2,resource:{buffer:this.buffers.pairs}},
      {binding:3,resource:{buffer:d.overlap}},{binding:4,resource:{buffer:d.params}}
    ]}));pass.dispatchWorkgroups(layouts.length);
    pass.setPipeline(this.pipelines.bounds);
    pass.setBindGroup(0,device.createBindGroup({layout:this.pipelines.bounds.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:d.placements}},{binding:1,resource:{buffer:this.buffers.componentSize}},{binding:2,resource:{buffer:d.bounds}},{binding:3,resource:{buffer:d.params}}
    ]}));pass.dispatchWorkgroups(layouts.length);
    pass.setPipeline(this.pipelines.congestion);
    pass.setBindGroup(0,device.createBindGroup({layout:this.pipelines.congestion.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:d.placements}},{binding:1,resource:{buffer:this.buffers.pinComponent}},{binding:2,resource:{buffer:this.buffers.pinLocal}},
      {binding:3,resource:{buffer:this.buffers.netOffsets}},{binding:4,resource:{buffer:this.buffers.netPins}},{binding:5,resource:{buffer:d.congestion}},{binding:6,resource:{buffer:d.params}}
    ]}));pass.dispatchWorkgroups(layouts.length);
    pass.setPipeline(this.pipelines.reduce);
    pass.setBindGroup(0,device.createBindGroup({layout:this.pipelines.reduce.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:d.hpwl}},{binding:1,resource:{buffer:d.overlap}},{binding:2,resource:{buffer:d.bounds}},{binding:3,resource:{buffer:d.congestion}},
      {binding:4,resource:{buffer:d.scores}},{binding:5,resource:{buffer:d.params}}
    ]}));pass.dispatchWorkgroups(Math.ceil(layouts.length/256));pass.end();
    enc.copyBufferToBuffer(d.scores,0,d.readback,0,layouts.length*32);
    device.queue.submit([enc.finish()]);
    await d.readback.mapAsync(GPUMapMode.READ,0,layouts.length*32);
    const raw=new Float32Array(d.readback.getMappedRange(0,layouts.length*32).slice(0));
    d.readback.unmap();
    return Array.from({length:layouts.length},(_,i)=>({total:raw[8*i],hpwl:raw[8*i+1],overlap:raw[8*i+2],bounds:raw[8*i+3],congestion:raw[8*i+4]}));
  }

  destroy() { for (const b of Object.values(this.buffers)) b.destroy(); if(this.dynamic)for(const b of Object.values(this.dynamic))b.destroy(); this.dynamic=null; this.capacity=0; }
}
