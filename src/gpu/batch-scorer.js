import { createBuffer } from './device.js';
import { resolvePriorityOptions, priorityNetWeights } from '../cpu/priority-batch-scorer.js';
import { placementMasks } from '../geometry/mask.js';

const WG = 256;
// Nets up to this many pins are handled by one lane each (exact L-star dedupe in
// private memory); larger nets are processed cooperatively by the whole workgroup.
const SMALL_NET = 32;

const COMMON = /* wgsl */`
// side: 0 = top, 1 = bottom (pins mirrored in local x).
struct Placement { pos: vec2<f32>, rot: u32, side: u32 };
// counts: candidates, components, nets, smallNets
// counts2: largeNets, gridWidth, gridHeight, -
// f0: canvasW, canvasH, wHpwl, wOverlap
// f1: wBounds, wCongestion, capacity, 1/demandScale
struct Params { counts: vec4<u32>, counts2: vec4<u32>, f0: vec4<f32>, f1: vec4<f32> };
fn rotateQuarter(v: vec2<f32>, r: u32) -> vec2<f32> {
  switch (r & 3u) {
    case 0u: { return v; }
    case 1u: { return vec2<f32>(-v.y, v.x); }
    case 2u: { return -v; }
    default: { return vec2<f32>(v.y, -v.x); }
  }
}
fn rotatedSize(s: vec2<f32>, r: u32) -> vec2<f32> { return select(s, s.yx, (r & 1u) == 1u); }
`;
// pins[i] = (localX, localY, bitcast<f32>(componentIndex), 0)
const PIN_WORLD = /* wgsl */`
fn pinWorld(base: u32, pi: u32) -> vec2<f32> {
  let pin = pins[pi];
  let pl = placements[base + bitcast<u32>(pin.z)];
  let local = select(pin.xy, vec2<f32>(-pin.x, pin.y), pl.side == 1u);
  return pl.pos + rotateQuarter(local, pl.rot);
}
`;

/** Raw and priority-weighted HPWL; one workgroup per candidate, one lane per net. */
const HPWL_WGSL = COMMON + PIN_WORLD + /* wgsl */`
@group(0) @binding(0) var<storage, read> placements: array<Placement>;
@group(0) @binding(1) var<storage, read> pins: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> netOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> netPins: array<u32>;
@group(0) @binding(4) var<storage, read> netWeight: array<f32>;
@group(0) @binding(5) var<storage, read_write> outHpwl: array<vec2<f32>>;
@group(0) @binding(6) var<uniform> params: Params;
var<workgroup> partial: array<vec2<f32>, ${WG}>;

@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let candidate = wid.x;
  let lid = lid3.x;
  if (candidate >= params.counts.x) { return; }
  let base = candidate * params.counts.y;
  var acc = vec2<f32>(0.0, 0.0);
  for (var n = lid; n < params.counts.z; n += ${WG}u) {
    var minP = vec2<f32>(1e30, 1e30);
    var maxP = vec2<f32>(-1e30, -1e30);
    for (var k = netOffsets[n]; k < netOffsets[n + 1u]; k++) {
      let p = pinWorld(base, netPins[k]);
      minP = min(minP, p); maxP = max(maxP, p);
    }
    let hp = (maxP.x - minP.x) + (maxP.y - minP.y);
    acc += vec2<f32>(hp, netWeight[n] * hp);
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var stride = ${WG / 2}u; stride > 0u; stride >>= 1u) {
    if (lid < stride) { partial[lid] += partial[lid + stride]; }
    workgroupBarrier();
  }
  if (lid == 0u) { outHpwl[candidate] = partial[0]; }
}
`;

/** Masked (outline / hole / keepout) area under a body, from summed-area tables. */
const maskWgsl = (m) => m ? /* wgsl */`
@group(0) @binding(4) var<storage, read> sat: array<u32>;
const MASK_SIDE = array<u32, ${m.layers.length}>(${m.layers.map((l) => `${l.side}u`).join(', ')});
fn satSum(k: u32, c: vec4<u32>) -> u32 {
  let b = k * ${(m.gw + 1) * (m.gh + 1)}u;
  let w = ${m.gw + 1}u;
  return (sat[b + c.w * w + c.z] + sat[b + c.y * w + c.x]) - (sat[b + c.y * w + c.z] + sat[b + c.w * w + c.x]);
}
fn blockedArea(pos: vec2<f32>, half: vec2<f32>, bits: u32, side: u32, twoSided: bool) -> f32 {
  let g = vec2<f32>(${m.gw}.0, ${m.gh}.0);
  let lo = clamp(ceil((pos - half) / ${m.res.toExponential(9)} - vec2<f32>(0.5)), vec2<f32>(0.0), g);
  let hi = max(lo, clamp(ceil((pos + half) / ${m.res.toExponential(9)} - vec2<f32>(0.5)), vec2<f32>(0.0), g));
  let c = vec4<u32>(vec2<u32>(lo), vec2<u32>(hi));
  var count = 0u;
  for (var k = 0u; k < ${m.layers.length}u; k++) {
    if ((bits & (1u << k)) != 0u && (twoSided || MASK_SIDE[k] == side)) { count += satSum(k, c); }
  }
  return f32(count) * ${(m.res * m.res).toExponential(9)};
}` : '';

/** Pairwise overlap area and canvas/mask violation; lane i scans pairs (i, j>i). */
const geometryWgsl = (masks) => COMMON + maskWgsl(masks) + /* wgsl */`
@group(0) @binding(0) var<storage, read> placements: array<Placement>;
// (width, height, twoSided, bitcast(mask layer bits))
@group(0) @binding(1) var<storage, read> componentSize: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> outGeometry: array<vec2<f32>>;
@group(0) @binding(3) var<uniform> params: Params;
var<workgroup> partial: array<vec2<f32>, ${WG}>;

@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let candidate = wid.x;
  let lid = lid3.x;
  if (candidate >= params.counts.x) { return; }
  let n = params.counts.y;
  let base = candidate * n;
  let canvas = params.f0.xy;
  var overlap = 0.0;
  var bounds = 0.0;
  for (var i = lid; i < n; i += ${WG}u) {
    let a = placements[base + i];
    let ai = componentSize[i];
    let ah = 0.5 * rotatedSize(ai.xy, a.rot);
    let lo = max(vec2<f32>(0.0), ah - a.pos);
    let hi = max(vec2<f32>(0.0), a.pos + ah - canvas);
    bounds += dot(lo, lo) + dot(hi, hi);${masks ? `
    bounds += blockedArea(a.pos, ah, bitcast<u32>(ai.w), a.side, ai.z != 0.0);` : ''}
    let amin = a.pos - ah;
    let amax = a.pos + ah;
    for (var j = i + 1u; j < n; j++) {
      let b = placements[base + j];
      let bj = componentSize[j];
      if (a.side != b.side && ai.z == 0.0 && bj.z == 0.0) { continue; }
      let bh = 0.5 * rotatedSize(bj.xy, b.rot);
      let o = max(vec2<f32>(0.0), min(amax, b.pos + bh) - max(amin, b.pos - bh));
      overlap += o.x * o.y;
    }
  }
  partial[lid] = vec2<f32>(overlap, bounds);
  workgroupBarrier();
  for (var stride = ${WG / 2}u; stride > 0u; stride >>= 1u) {
    if (lid < stride) { partial[lid] += partial[lid + stride]; }
    workgroupBarrier();
  }
  if (lid == 0u) { outGeometry[candidate] = partial[0]; }
}
`;

/**
 * Coarse L-star congestion, matching the CPU scorers exactly: every net adds its
 * (fixed-point) weight once to each distinct cell touched by the star from its first
 * pin, then sum(max(0, demand - capacity)^2).
 */
// Demand/stamp grids live in workgroup memory when they fit, otherwise in a per-candidate
// region of a global scratch buffer (offset `sb`).
const GRID_WORKGROUP = (cells) => /* wgsl */`
var<workgroup> demand: array<atomic<u32>, ${cells}>;
var<workgroup> stamp: array<atomic<u32>, ${cells}>;
fn zeroCell(sb: u32, c: u32) { atomicStore(&demand[c], 0u); atomicStore(&stamp[c], 0u); }
fn addDemand(sb: u32, c: i32, w: u32) { atomicAdd(&demand[c], w); }
fn mark(sb: u32, c: i32, tag: u32, w: u32) { if (atomicExchange(&stamp[c], tag) != tag) { atomicAdd(&demand[c], w); } }
fn loadDemand(sb: u32, c: u32) -> u32 { return atomicLoad(&demand[c]); }
fn sync() { workgroupBarrier(); }
`;
const GRID_GLOBAL = (cells) => /* wgsl */`
@group(0) @binding(7) var<storage, read_write> scratch: array<atomic<u32>>;
fn zeroCell(sb: u32, c: u32) { atomicStore(&scratch[sb + c], 0u); atomicStore(&scratch[sb + ${cells}u + c], 0u); }
fn addDemand(sb: u32, c: i32, w: u32) { atomicAdd(&scratch[sb + u32(c)], w); }
fn mark(sb: u32, c: i32, tag: u32, w: u32) { if (atomicExchange(&scratch[sb + ${cells}u + u32(c)], tag) != tag) { atomicAdd(&scratch[sb + u32(c)], w); } }
fn loadDemand(sb: u32, c: u32) -> u32 { return atomicLoad(&scratch[sb + c]); }
fn sync() { storageBarrier(); workgroupBarrier(); }
`;

const congestionWgsl = (cells, globalGrid) => COMMON + PIN_WORLD + /* wgsl */`
@group(0) @binding(0) var<storage, read> placements: array<Placement>;
@group(0) @binding(1) var<storage, read> pins: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> netOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> netPins: array<u32>;
@group(0) @binding(4) var<storage, read> netWeightQ: array<u32>;
// Small nets first (counts.w of them), then large nets (counts2.x).
@group(0) @binding(5) var<storage, read> netOrder: array<u32>;
@group(0) @binding(6) var<storage, read_write> outCongestion: array<f32>;
@group(0) @binding(8) var<uniform> params: Params;
${globalGrid ? GRID_GLOBAL(cells) : GRID_WORKGROUP(cells)}
var<workgroup> partial: array<f32, ${WG}>;

fn pinCell(base: u32, pi: u32) -> vec2<i32> {
  let p = pinWorld(base, pi);
  let g = vec2<i32>(i32(params.counts2.y), i32(params.counts2.z));
  let c = vec2<i32>(floor(p / params.f0.xy * vec2<f32>(g)));
  return clamp(c, vec2<i32>(0), g - vec2<i32>(1));
}

@compute @workgroup_size(${WG})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let candidate = wid.x;
  let lid = lid3.x;
  if (candidate >= params.counts.x) { return; }
  let base = candidate * params.counts.y;
  let gw = i32(params.counts2.y);
  let sb = candidate * ${2 * cells}u;
  for (var c = lid; c < ${cells}u; c += ${WG}u) { zeroCell(sb, c); }
  sync();

  // Small nets: one lane per net. The star's touched set is the anchor-row interval
  // plus, per column, the farthest vertical extent above and below the anchor row.
  for (var s = lid; s < params.counts.w; s += ${WG}u) {
    let net = netOrder[s];
    let begin = netOffsets[net];
    let m = netOffsets[net + 1u] - begin;
    let w = netWeightQ[net];
    var cell: array<vec2<i32>, ${SMALL_NET}>;
    let a = pinCell(base, netPins[begin]);
    var minX = a.x;
    var maxX = a.x;
    for (var k = 1u; k < m; k++) {
      let t = pinCell(base, netPins[begin + k]);
      cell[k] = t; minX = min(minX, t.x); maxX = max(maxX, t.x);
    }
    for (var x = minX; x <= maxX; x++) { addDemand(sb, a.y * gw + x, w); }
    for (var k = 1u; k < m; k++) {
      let t = cell[k];
      if (t.y == a.y) { continue; }
      let up = t.y < a.y;
      var covered = 0;
      for (var j = 1u; j < k; j++) {
        let u = cell[j];
        if (u.x == t.x && u.y != a.y && (u.y < a.y) == up) { covered = max(covered, abs(u.y - a.y)); }
      }
      let dir = select(1, -1, up);
      for (var d = covered + 1; d <= abs(t.y - a.y); d++) { addDemand(sb, (a.y + dir * d) * gw + t.x, w); }
    }
  }

  // Large nets: whole workgroup per net, deduplicated with a per-net cell stamp.
  for (var li = 0u; li < params.counts2.x; li++) {
    let net = netOrder[params.counts.w + li];
    let begin = netOffsets[net];
    let end = netOffsets[net + 1u];
    let w = netWeightQ[net];
    let tag = li + 1u;
    let a = pinCell(base, netPins[begin]);
    for (var k = begin + 1u + lid; k < end; k += ${WG}u) {
      let t = pinCell(base, netPins[k]);
      for (var x = min(a.x, t.x); x <= max(a.x, t.x); x++) { mark(sb, a.y * gw + x, tag, w); }
      for (var y = min(a.y, t.y); y <= max(a.y, t.y); y++) { mark(sb, y * gw + t.x, tag, w); }
    }
    sync();
  }
  sync();

  var acc = 0.0;
  for (var c = lid; c < ${cells}u; c += ${WG}u) {
    let over = max(0.0, f32(loadDemand(sb, c)) * params.f1.w - params.f1.z);
    acc += over * over;
  }
  partial[lid] = acc;
  workgroupBarrier();
  for (var stride = ${WG / 2}u; stride > 0u; stride >>= 1u) {
    if (lid < stride) { partial[lid] += partial[lid + stride]; }
    workgroupBarrier();
  }
  if (lid == 0u) { outCongestion[candidate] = partial[0]; }
}
`;

const REDUCE_WGSL = COMMON + /* wgsl */`
struct ScoreOut { a: vec4<f32>, b: vec4<f32> };
@group(0) @binding(0) var<storage, read> hpwl: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> geometry: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> congestion: array<f32>;
@group(0) @binding(3) var<storage, read_write> scores: array<ScoreOut>;
@group(0) @binding(4) var<uniform> params: Params;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.counts.x) { return; }
  let h = hpwl[i];
  let g = geometry[i];
  let c = congestion[i];
  let total = params.f0.z * h.y + params.f0.w * g.x + params.f1.x * g.y + params.f1.y * c;
  scores[i].a = vec4<f32>(total, h.x, h.y, g.x);
  scores[i].b = vec4<f32>(g.y, c, 0.0, 0.0);
}
`;

function staticData(problem, netWeights) {
  const componentSize = new Float32Array(problem.components.length * 4);
  const masks = placementMasks(problem), sizeBits = new Uint32Array(componentSize.buffer);
  problem.components.forEach((c, i) => { componentSize.set([c.width, c.height, c.twoSided ? 1 : 0], 4 * i); sizeBits[4 * i + 3] = masks ? masks.componentLayers[i] : 0; });
  const pins = new Float32Array(problem.pins.length * 4), pinBits = new Uint32Array(pins.buffer);
  problem.pins.forEach((p, i) => { pins[4 * i] = p.x; pins[4 * i + 1] = p.y; pinBits[4 * i + 2] = p.componentIndex; });
  let totalPins = 0; for (const n of problem.nets) totalPins += n.pins.length;
  const netOffsets = new Uint32Array(problem.nets.length + 1);
  const netPins = new Uint32Array(totalPins); let k = 0;
  problem.nets.forEach((n, i) => { netOffsets[i] = k; for (const p of n.pins) netPins[k++] = p; });
  netOffsets[problem.nets.length] = k;

  // Fixed-point congestion weights: the largest possible cell demand must fit in u32.
  const weightSum = netWeights.reduce((s, w) => s + w, 0);
  const demandScale = Math.min(65536, 2 ** Math.floor(Math.log2(4e9 / Math.max(1, weightSum))));
  const netWeightQ = Uint32Array.from(netWeights, (w) => Math.round(w * demandScale));
  const small = [], large = [];
  problem.nets.forEach((n, i) => { if (n.pins.length >= 2) (n.pins.length <= SMALL_NET ? small : large).push(i); });
  return {
    componentSize, pins, netOffsets, netPins, masks,
    sat: masks ? concatU32(masks.sats) : null,
    netWeight: Float32Array.from(netWeights), netWeightQ, demandScale,
    netOrder: Uint32Array.from([...small, ...large]), smallCount: small.length, largeCount: large.length,
  };
}

function concatU32(arrays) {
  const out = new Uint32Array(arrays.reduce((s, a) => s + a.length, 0));
  let o = 0; for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

function nextPow2(v) { let n = 1; while (n < v) n <<= 1; return n; }

/**
 * WebGPU batch placement scorer: one workgroup per candidate layout.
 *
 * Default mode reproduces scoreLayoutCpu() (unit net weights, `coarseCongestion`
 * grid). Priority mode (`priority: true`, a `policy`, or explicit `netWeights`)
 * reproduces PriorityCpuBatchScorer and accepts the same options.
 */
export class GpuBatchScorer {
  constructor(device, problem, options = {}) {
    this.device = device; this.problem = problem;
    const priority = options.priority ?? (options.policy !== undefined || options.netWeights !== undefined);
    let netWeights;
    if (priority) {
      const o = resolvePriorityOptions(options);
      this.weights = o.weights;
      this.coarse = { gridWidth: o.gridWidth, gridHeight: o.gridHeight, capacity: o.capacity };
      netWeights = options.netWeights ? Float64Array.from(options.netWeights) : priorityNetWeights(problem, options);
    } else {
      this.weights = { hpwl: 1, overlap: 1000, bounds: 1000, congestion: 1, ...options.weights };
      this.coarse = { gridWidth: 32, gridHeight: 32, capacity: 1, ...(options.coarseCongestion ?? options.coarse) };
      netWeights = new Float64Array(problem.nets.length).fill(1);
    }
    if (netWeights.length !== problem.nets.length) throw new Error('netWeights length must equal the number of nets');
    this.netWeights = netWeights;

    const cells = this.cells = this.coarse.gridWidth * this.coarse.gridHeight;
    // Grids too large for workgroup memory fall back to a global scratch buffer.
    this.globalGrid = options.globalCongestionGrid ?? (cells * 8 + WG * 4 > device.limits.maxComputeWorkgroupStorageSize);

    const d = this.static = staticData(problem, netWeights);
    const U = GPUBufferUsage;
    const buf = (data) => createBuffer(device, Math.max(4, data.byteLength), U.STORAGE, data.byteLength ? data : new Uint32Array(1));
    this.buffers = {
      componentSize: buf(d.componentSize), pins: buf(d.pins),
      netOffsets: buf(d.netOffsets), netPins: buf(d.netPins), netWeight: buf(d.netWeight), netWeightQ: buf(d.netWeightQ),
      netOrder: buf(d.netOrder),
      sat: d.sat ? buf(d.sat) : null,
      params: createBuffer(device, 64, U.UNIFORM | U.COPY_DST),
    };
    const pipeline = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    this.pipelines = {
      hpwl: pipeline(HPWL_WGSL), geometry: pipeline(geometryWgsl(d.masks)),
      congestion: pipeline(congestionWgsl(cells, this.globalGrid)), reduce: pipeline(REDUCE_WGSL),
    };

    const n = problem.components.length;
    const maxBinding = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    const perCandidate = Math.max(Math.max(1, n) * 16, this.globalGrid ? cells * 8 : 0);
    this.maxChunk = Math.max(1, Math.min(65535, Math.floor(maxBinding / perCandidate)));
    this.dynamic = null; this.capacity = 0; this.bindGroups = null;
    this.hostPlacements = new ArrayBuffer(0);
    this.queue = Promise.resolve();
  }

  #ensureCapacity(count) {
    if (count <= this.capacity && this.dynamic) return;
    const device = this.device, U = GPUBufferUsage;
    if (this.dynamic) for (const b of Object.values(this.dynamic)) b.destroy();
    const c = this.capacity = Math.min(this.maxChunk, nextPow2(count));
    const n = Math.max(1, this.problem.components.length);
    this.hostPlacements = new ArrayBuffer(c * n * 16);
    const d = this.dynamic = {
      placements: createBuffer(device, c * n * 16, U.STORAGE | U.COPY_DST),
      hpwl: createBuffer(device, c * 8, U.STORAGE),
      geometry: createBuffer(device, c * 8, U.STORAGE),
      congestion: createBuffer(device, c * 4, U.STORAGE),
      scores: createBuffer(device, c * 32, U.STORAGE | U.COPY_SRC),
      readback: createBuffer(device, c * 32, U.COPY_DST | U.MAP_READ),
    };
    if (this.globalGrid) d.scratch = createBuffer(device, c * this.cells * 8, U.STORAGE);
    const s = this.buffers, p = this.pipelines;
    // Array index = binding slot; holes are skipped.
    const group = (pl, list) => device.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: list.flatMap((buffer, binding) => buffer ? [{ binding, resource: { buffer } }] : []) });
    this.bindGroups = {
      hpwl: group(p.hpwl, [d.placements, s.pins, s.netOffsets, s.netPins, s.netWeight, d.hpwl, s.params]),
      geometry: group(p.geometry, [d.placements, s.componentSize, d.geometry, s.params, s.sat]),
      congestion: group(p.congestion, [d.placements, s.pins, s.netOffsets, s.netPins, s.netWeightQ, s.netOrder, d.congestion, d.scratch ?? null, s.params]),
      reduce: group(p.reduce, [d.hpwl, d.geometry, d.congestion, d.scores, s.params]),
    };
  }

  /** Score candidate layouts given as arrays of {x, y, rotation}. */
  scoreLayouts(layouts) {
    const n = this.problem.components.length;
    for (const l of layouts) if (l.length !== n) throw new Error('layout component count mismatch');
    return this.#enqueue(layouts.length, (f32, u32, first, count) => {
      for (let k = 0; k < count; k++) {
        const layout = layouts[first + k];
        for (let i = 0, o = k * n * 4; i < n; i++, o += 4) {
          const p = layout[i]; f32[o] = p.x; f32[o + 1] = p.y; u32[o + 2] = p.rotation & 3; u32[o + 3] = p.side ? 1 : 0;
        }
      }
    });
  }

  /**
   * Score `count` candidates stored as contiguous slabs: candidate k, component i is
   * at index k*n+i of x/y/r (the FastDeltaLnsOptimizer layout). r packs the quarter
   * turns in bits 0-1 and the bottom side in bit 2.
   */
  scoreSlabs(x, y, r, count) {
    const n = this.problem.components.length;
    return this.#enqueue(count, (f32, u32, first, chunk) => {
      const src = first * n;
      for (let q = 0, o = 0; q < chunk * n; q++, o += 4) {
        f32[o] = x[src + q]; f32[o + 1] = y[src + q]; u32[o + 2] = r[src + q] & 3; u32[o + 3] = (r[src + q] >> 2) & 1;
      }
    });
  }

  #enqueue(count, pack) {
    const job = this.queue.then(() => this.#score(count, pack));
    this.queue = job.catch(() => {});
    return job;
  }

  async #score(count, pack) {
    const out = new Array(count);
    for (let first = 0; first < count; first += this.maxChunk) {
      const chunk = Math.min(this.maxChunk, count - first);
      this.#ensureCapacity(chunk);
      pack(new Float32Array(this.hostPlacements), new Uint32Array(this.hostPlacements), first, chunk);
      const raw = await this.#dispatch(chunk);
      for (let i = 0; i < chunk; i++) {
        const o = 8 * i;
        out[first + i] = { total: raw[o], hpwl: raw[o + 1], weightedHpwl: raw[o + 2], overlap: raw[o + 3], bounds: raw[o + 4], congestion: raw[o + 5] };
      }
    }
    return out;
  }

  async #dispatch(count) {
    const device = this.device, d = this.dynamic, n = this.problem.components.length, st = this.static;
    device.queue.writeBuffer(d.placements, 0, this.hostPlacements, 0, count * n * 16);
    const params = new ArrayBuffer(64), u = new Uint32Array(params), f = new Float32Array(params);
    u[0] = count; u[1] = n; u[2] = this.problem.nets.length; u[3] = st.smallCount;
    u[4] = st.largeCount; u[5] = this.coarse.gridWidth; u[6] = this.coarse.gridHeight;
    f[8] = this.problem.canvas.width; f[9] = this.problem.canvas.height; f[10] = this.weights.hpwl; f[11] = this.weights.overlap;
    f[12] = this.weights.bounds; f[13] = this.weights.congestion; f[14] = this.coarse.capacity; f[15] = 1 / st.demandScale;
    device.queue.writeBuffer(this.buffers.params, 0, params);

    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    for (const k of ['hpwl', 'geometry', 'congestion']) {
      pass.setPipeline(this.pipelines[k]); pass.setBindGroup(0, this.bindGroups[k]); pass.dispatchWorkgroups(count);
    }
    pass.setPipeline(this.pipelines.reduce); pass.setBindGroup(0, this.bindGroups.reduce); pass.dispatchWorkgroups(Math.ceil(count / WG));
    pass.end();
    enc.copyBufferToBuffer(d.scores, 0, d.readback, 0, count * 32);
    device.queue.submit([enc.finish()]);
    await d.readback.mapAsync(GPUMapMode.READ, 0, count * 32);
    const raw = new Float32Array(d.readback.getMappedRange(0, count * 32).slice(0));
    d.readback.unmap();
    return raw;
  }

  destroy() {
    for (const b of Object.values(this.buffers)) b?.destroy();
    if (this.dynamic) for (const b of Object.values(this.dynamic)) b.destroy();
    this.dynamic = null; this.capacity = 0; this.bindGroups = null;
  }
}

/** GPU counterpart of PriorityCpuBatchScorer (same options, same score fields). */
export class PriorityGpuBatchScorer extends GpuBatchScorer {
  constructor(device, problem, options = {}) { super(device, problem, { ...options, priority: true }); }
}
