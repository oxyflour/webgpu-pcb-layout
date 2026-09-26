import { createBuffer } from './device.js';
import { worldPin, rotatedSize } from '../problem.js';
import { resolveGlobalPlacerOptions, pinAnchorOutsideFixed, densityGridSpec, DENSITY_FIXED_POINT } from '../optimizer/global-placement.js';

const WG = 128;
const NET_WG = 64;
const GRID_WG = 16;
// Iterations encoded per command buffer; keeps individual submissions short.
const ITERATIONS_PER_SUBMIT = 25;

const lit = (v) => {
  if (!Number.isFinite(v)) throw new Error(`non-finite placer constant: ${v}`);
  return Number(v).toExponential(9);
};

/**
 * Shader constants and flat problem tables. Integer data lives in one u32 buffer
 * (`topo`) and float data in one f32 buffer (`stat`); section offsets are baked into
 * the WGSL so each kernel stays within the default 8 storage buffers per stage.
 */
function buildTables(problem, o, grid) {
  const n = problem.components.length, pins = problem.pins, nets = problem.nets;
  const movable = [], fixed = [];
  problem.components.forEach((c, i) => (c.fixed ? fixed : movable).push(i));
  const fixedLayout = problem.components.map((c) => c.fixed ? { ...c.fixed } : { x: 0, y: 0, rotation: 0, side: 0 });

  const netWeight = nets.map((net) => {
    const raw = typeof o.netWeight === 'function' ? o.netWeight(net) : (o.netWeight?.[net.id] ?? 1);
    return Math.max(0, Number(raw) || 0);
  });
  // Pin -> (net, position within net); only pins on nets the placer uses.
  const pinNet = new Int32Array(pins.length).fill(-1), pinSlot = new Uint32Array(pins.length);
  nets.forEach((net, ni) => { if (net.pins.length >= 2 && netWeight[ni] > 0) net.pins.forEach((p, k) => { pinNet[p] = ni; pinSlot[p] = k; }); });
  const compStart = new Uint32Array(n + 1), refs = [];
  for (let i = 0; i < n; i++) {
    compStart[i] = refs.length / 2;
    for (const p of problem.components[i].pins) if (pinNet[p] >= 0) refs.push(p, pinNet[p]);
  }
  compStart[n] = refs.length / 2;
  const netOff = new Uint32Array(nets.length + 1), netPins = [];
  nets.forEach((net, ni) => { netOff[ni] = netPins.length; netPins.push(...net.pins); });
  netOff[nets.length] = netPins.length;
  // pinFlags: bit0 = pin sits on a fixed component (constant effective position),
  //           bit1 = fixed pin with a normal (anchors outside the macro).
  const pinComp = new Uint32Array(pins.length), pinFlags = new Uint32Array(pins.length), pinFirst = new Uint32Array(pins.length);
  pins.forEach((p, i) => {
    pinComp[i] = p.componentIndex; pinFirst[i] = pinSlot[i] === 0 ? 1 : 0;
    const isFixed = !!problem.components[p.componentIndex].fixed;
    pinFlags[i] = (isFixed ? 1 : 0) | (isFixed && p.normal ? 2 : 0);
  });

  const sections = {};
  const u32 = [];
  const put = (name, arr) => { sections[name] = u32.length; for (const v of arr) u32.push(v); };
  put('compStart', compStart); put('refs', refs); put('netOff', netOff); put('netPins', netPins);
  put('pinComp', pinComp); put('pinFlags', pinFlags); put('pinFirst', pinFirst);
  put('movable', movable); put('fixed', fixed);
  put('twoSided', problem.components.map((c) => c.twoSided ? 1 : 0));
  if (!u32.length) u32.push(0);

  const f32 = [];
  const fput = (name, arr) => { sections[name] = f32.length; for (const v of arr) f32.push(v); };
  fput('size', problem.components.flatMap((c) => [c.width, c.height]));
  fput('pinLocal', pins.flatMap((p) => [p.x, p.y]));
  // Constant effective positions of pins on fixed components.
  fput('pinConst', pins.flatMap((p, i) => {
    if (!(pinFlags[i] & 1)) return [0, 0];
    return pinFlags[i] & 2 ? pinAnchorOutsideFixed(problem, fixedLayout, i, o.egressGap) : worldPin(problem, fixedLayout, i);
  }));
  fput('netWeight', netWeight);
  fput('inflate', grid ? grid.inflate : [0]);

  return {
    n, nets: nets.length, movable, fixed, sections,
    topo: Uint32Array.from(u32), stat: Float32Array.from(f32),
  };
}

function shaderHeader(t, o, canvas) {
  const S = t.sections;
  return /* wgsl */`
struct Iter { density: f32, overlap: f32, wire: f32, step: f32, grid: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var<storage, read> posIn: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> topo: array<u32>;
@group(0) @binding(2) var<storage, read> stat: array<f32>;
@group(0) @binding(3) var<uniform> iter: Iter;
const N = ${t.n}u;
const NETS = ${t.nets}u;
const MOVABLE = ${t.movable.length}u;
const FIXED = ${t.fixed.length}u;
const CANVAS = vec2<f32>(${lit(canvas.width)}, ${lit(canvas.height)});
fn rotateQuarter(v: vec2<f32>, r: u32) -> vec2<f32> {
  switch (r & 3u) {
    case 0u: { return v; }
    case 1u: { return vec2<f32>(-v.y, v.x); }
    case 2u: { return -v; }
    default: { return vec2<f32>(v.y, -v.x); }
  }
}
fn compSize(i: u32, r: u32) -> vec2<f32> {
  let s = vec2<f32>(stat[${S.size}u + 2u * i], stat[${S.size}u + 2u * i + 1u]);
  return select(s, s.yx, (r & 1u) == 1u);
}
fn netOff(ni: u32) -> u32 { return topo[${S.netOff}u + ni]; }
fn netPin(k: u32) -> u32 { return topo[${S.netPins}u + k]; }
fn netWeight(ni: u32) -> f32 { return stat[${S.netWeight}u + ni]; }
fn pinFlags(p: u32) -> u32 { return topo[${S.pinFlags}u + p]; }
/** Effective pin position used by the net forces (fixed pins are precomputed anchors). */
fn pinPos(base: u32, p: u32) -> vec2<f32> {
  if ((pinFlags(p) & 1u) != 0u) { return vec2<f32>(stat[${S.pinConst}u + 2u * p], stat[${S.pinConst}u + 2u * p + 1u]); }
  let pl = posIn[base + topo[${S.pinComp}u + p]];
  var local = vec2<f32>(stat[${S.pinLocal}u + 2u * p], stat[${S.pinLocal}u + 2u * p + 1u]);
  if (bitcast<u32>(pl.w) == 1u) { local.x = -local.x; }
  return pl.xy + rotateQuarter(local, bitcast<u32>(pl.z));
}
/** Whether components i and j (with packed sides si, sj) compete for board area. */
fn sharesSide(i: u32, si: u32, j: u32, sj: u32) -> bool {
  return si == sj || topo[${S.twoSided}u + i] != 0u || topo[${S.twoSided}u + j] != 0u;
}
`;
}

/** Grid density pass 1: scatter inflated component coverage into per-side bins. */
function scatterWgsl(t, o, canvas, g) {
  const S = t.sections, B = g.gw * g.gh;
  return shaderHeader(t, o, canvas) + /* wgsl */`
@group(0) @binding(4) var<storage, read_write> density: array<atomic<u32>>;
@compute @workgroup_size(${NET_WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let start = gid.y;
  if (i >= N) { return; }
  let p = posIn[start * N + i];
  let half = 0.5 * compSize(i, bitcast<u32>(p.z)) * stat[${S.inflate}u + i];
  let lo = p.xy - half;
  let hi = p.xy + half;
  let bin = vec2<f32>(${lit(g.binW)}, ${lit(g.binH)});
  let b0 = max(vec2<i32>(floor(lo / bin)), vec2<i32>(0));
  let b1 = min(vec2<i32>(floor(hi / bin)), vec2<i32>(${g.gw - 1}, ${g.gh - 1}));
  let twoSided = topo[${S.twoSided}u + i] != 0u;
  let side = bitcast<u32>(p.w);
  for (var by = b0.y; by <= b1.y; by++) {
    for (var bx = b0.x; bx <= b1.x; bx++) {
      let cell0 = vec2<f32>(f32(bx), f32(by)) * bin;
      let ov = min(hi, cell0 + bin) - max(lo, cell0);
      if (ov.x <= 0.0 || ov.y <= 0.0) { continue; }
      let q = u32(round(ov.x * ov.y / (bin.x * bin.y) * ${DENSITY_FIXED_POINT}.0));
      let cell = u32(by) * ${g.gw}u + u32(bx);
      if (twoSided || side == 0u) { atomicAdd(&density[(start * 2u) * ${B}u + cell], q); }
      if (twoSided || side == 1u) { atomicAdd(&density[(start * 2u + 1u) * ${B}u + cell], q); }
    }
  }
}
`;
}

const kernelConst = (g) => g.kernels.map((k, s) => `const K${s} = array<f32, ${k.weights.length}>(${k.weights.map(lit).join(', ')});`).join('\n');

/** Grid density pass 2: horizontal blur of (coverage - target) at every scale. */
function blurXWgsl(g, target) {
  const B = g.gw * g.gh, S = g.kernels.length;
  const scales = g.kernels.map((k, s) => `  {
    var acc = 0.0;
    for (var k = -${k.radius}; k <= ${k.radius}; k++) {
      let xx = x + k;
      if (xx >= 0 && xx < ${g.gw}) { acc += K${s}[k + ${k.radius}] * (f32(density[row + u32(xx)]) / ${DENSITY_FIXED_POINT}.0${g.blocked ? ' + blocked[blockedRow + u32(xx)]' : ''} - ${lit(target)}); }
    }
    tmp[(g * ${S}u + ${s}u) * ${B}u + y * ${g.gw}u + u32(x)] = acc;
  }`).join('\n');
  return /* wgsl */`
@group(0) @binding(0) var<storage, read> density: array<u32>;
@group(0) @binding(1) var<storage, read_write> tmp: array<f32>;${g.blocked ? `
// Masked coverage per board side (same for every start).
@group(0) @binding(2) var<storage, read> blocked: array<f32>;` : ''}
${kernelConst(g)}
@compute @workgroup_size(${GRID_WG}, ${GRID_WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = gid.y;
  let g = gid.z;
  if (x >= ${g.gw} || y >= ${g.gh}u) { return; }
  let row = g * ${B}u + y * ${g.gw}u;
  let blockedRow = (g & 1u) * ${B}u + y * ${g.gw}u;
${scales}
}
`;
}

/** Grid density pass 3: vertical blur, sum over scales -> potential; clears coverage. */
function blurYWgsl(g) {
  const B = g.gw * g.gh, S = g.kernels.length;
  const scales = g.kernels.map((k, s) => `  for (var k = -${k.radius}; k <= ${k.radius}; k++) {
    let yy = y + k;
    if (yy >= 0 && yy < ${g.gh}) { acc += K${s}[k + ${k.radius}] * tmp[(g * ${S}u + ${s}u) * ${B}u + u32(yy) * ${g.gw}u + x]; }
  }`).join('\n');
  return /* wgsl */`
@group(0) @binding(0) var<storage, read> tmp: array<f32>;
@group(0) @binding(1) var<storage, read_write> phi: array<f32>;
@group(0) @binding(2) var<storage, read_write> density: array<u32>;
${kernelConst(g)}
@compute @workgroup_size(${GRID_WG}, ${GRID_WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = i32(gid.y);
  let g = gid.z;
  if (x >= ${g.gw}u || y >= ${g.gh}) { return; }
  var acc = 0.0;
${scales}
  let cell = g * ${B}u + u32(y) * ${g.gw}u + x;
  phi[cell] = acc;
  density[cell] = 0u;
}
`;
}

/** Pass 1: centroid of every multi-pin net, per start. */
function centroidWgsl(t, o, canvas) {
  return shaderHeader(t, o, canvas) + /* wgsl */`
@group(0) @binding(4) var<storage, read_write> centroid: array<vec2<f32>>;
@compute @workgroup_size(${NET_WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ni = gid.x;
  let start = gid.y;
  if (ni >= NETS) { return; }
  let begin = netOff(ni);
  let end = netOff(ni + 1u);
  if (end - begin <= 2u || netWeight(ni) <= 0.0) { return; }
  var c = vec2<f32>(0.0);
  for (var k = begin; k < end; k++) { c += pinPos(start * N, netPin(k)); }
  centroid[start * NETS + ni] = c / f32(end - begin);
}
`;
}

/** Pass 2: per-component force accumulation and velocity integration. */
function forceWgsl(t, o, canvas, g) {
  const S = t.sections;
  const gridFns = g ? /* wgsl */`
@group(0) @binding(7) var<storage, read> phi: array<f32>;
fn phiAt(side: u32, ix: i32, iy: i32) -> f32 { return phi[side * ${g.gw * g.gh}u + u32(iy) * ${g.gw}u + u32(ix)]; }
fn phiGrad(side: u32, ix: i32, iy: i32) -> vec2<f32> {
  var gx: f32;
  var gy: f32;
  if (ix == 0) { gx = phiAt(side, 1, iy) - phiAt(side, 0, iy); }
  else if (ix == ${g.gw - 1}) { gx = phiAt(side, ${g.gw - 1}, iy) - phiAt(side, ${g.gw - 2}, iy); }
  else { gx = 0.5 * (phiAt(side, ix + 1, iy) - phiAt(side, ix - 1, iy)); }
  if (iy == 0) { gy = phiAt(side, ix, 1) - phiAt(side, ix, 0); }
  else if (iy == ${g.gh - 1}) { gy = phiAt(side, ix, ${g.gh - 1}) - phiAt(side, ix, ${g.gh - 2}); }
  else { gy = 0.5 * (phiAt(side, ix, iy + 1) - phiAt(side, ix, iy - 1)); }
  return vec2<f32>(gx, gy);
}
/** Bilinear potential gradient (per bin) of grid \`side\` (start * 2 + board side) at xy mm. */
fn densityGradient(side: u32, xy: vec2<f32>) -> vec2<f32> {
  let f = xy / vec2<f32>(${lit(g.binW)}, ${lit(g.binH)}) - vec2<f32>(0.5);
  let i0 = clamp(vec2<i32>(floor(f)), vec2<i32>(0), vec2<i32>(${g.gw - 1}, ${g.gh - 1}));
  let i1 = min(i0 + vec2<i32>(1), vec2<i32>(${g.gw - 1}, ${g.gh - 1}));
  let tt = clamp(f - vec2<f32>(i0), vec2<f32>(0.0), vec2<f32>(1.0));
  let a = mix(phiGrad(side, i0.x, i0.y), phiGrad(side, i1.x, i0.y), tt.x);
  let b = mix(phiGrad(side, i0.x, i1.y), phiGrad(side, i1.x, i1.y), tt.x);
  return mix(a, b, tt.y);
}` : '';
  const gridForce = g ? /* wgsl */`
    if (topo[${S.twoSided}u + i] != 0u) {
      force -= iter.grid * 0.5 * (densityGradient(start * 2u, p.xy) + densityGradient(start * 2u + 1u, p.xy));
    } else {
      force -= iter.grid * densityGradient(start * 2u + bitcast<u32>(p.w), p.xy);
    }` : '';
  return shaderHeader(t, o, canvas) + /* wgsl */`
@group(0) @binding(4) var<storage, read> centroid: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> posOut: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> vel: array<vec2<f32>>;${gridFns}
var<workgroup> tilePos: array<vec2<f32>, ${WG}>;
var<workgroup> tileSize: array<vec2<f32>, ${WG}>;
var<workgroup> tileIndex: array<u32, ${WG}>;
var<workgroup> tileSide: array<u32, ${WG}>;

fn deterministicUnit(i: u32, j: u32) -> vec2<f32> {
  let a = ((i + 1u) * 73856093u) ^ ((j + 1u) * 19349663u);
  let t = f32(a % 628319u) / 100000.0;
  return vec2<f32>(cos(t), sin(t));
}

/** Density + exact-overlap force on component a from b, for the pair (min(a,b), max(a,b)). */
fn pairForce(a: u32, pa: vec2<f32>, sa: vec2<f32>, b: u32, pb: vec2<f32>, sb: vec2<f32>) -> vec2<f32> {
  // The CPU placer evaluates each pair once as (i<j) and applies +F to i, -F to j.
  let lo = min(a, b);
  let hi = max(a, b);
  let side = select(-1.0, 1.0, a == lo);
  var d = select(pb - pa, pa - pb, a == lo);
  if (abs(d.x) + abs(d.y) < 1e-8) { d = deterministicUnit(lo, hi) * 1e-3; }
  let ext = 0.5 * (sa + sb) + vec2<f32>(${lit(o.clearance)});
  let ov = ext - abs(d);
  var f = vec2<f32>(0.0);
  if (ov.x > 0.0 && ov.y > 0.0) {
    if (ov.x / ext.x < ov.y / ext.y) {
      f.x += select(-1.0, 1.0, d.x >= 0.0) * iter.overlap * (ov.x / ext.x + 0.15);
    } else {
      f.y += select(-1.0, 1.0, d.y >= 0.0) * iter.overlap * (ov.y / ext.y + 0.15);
    }
  }
  let q = d / max(ext, vec2<f32>(1.0));
  let qd = length(q) + 1e-6;
  if (qd < 2.6) { f += q / qd * (iter.density * (2.6 - qd) / (qd * 2.6)); }
  return side * f;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let t = gid.x;
  let lid = lid3.x;
  let start = gid.y;
  let base = start * N;
  let live = t < MOVABLE;
  var i = 0u;
  var p = vec4<f32>(0.0);
  var size = vec2<f32>(0.0);
  var force = vec2<f32>(0.0);
  if (live) {
    i = topo[${S.movable}u + t];
    p = posIn[base + i];
    size = compSize(i, bitcast<u32>(p.z));

    // Net forces.
    for (var e = topo[${S.compStart}u + i]; e < topo[${S.compStart}u + i + 1u]; e++) {
      let pin = topo[${S.refs}u + 2u * e];
      let ni = topo[${S.refs}u + 2u * e + 1u];
      let w = netWeight(ni);
      let begin = netOff(ni);
      let m = netOff(ni + 1u) - begin;
      if (m == 2u) {
        let p0 = netPin(begin);
        let p1 = netPin(begin + 1u);
        let d = pinPos(base, p1) - pinPos(base, p0);
        let dist = length(d) + 1e-9;
        let anchored = ((pinFlags(p0) | pinFlags(p1)) & 2u) != 0u;
        let scale = select(${lit(o.movableNetScale)}, ${lit(o.fixedAnchorBoost)}, anchored);
        let f = d / dist * (iter.wire * scale * w * tanh(dist / 18.0));
        force += select(-f, f, topo[${S.pinFirst}u + pin] == 1u);
      } else {
        let d = centroid[start * NETS + ni] - pinPos(base, pin);
        let dist = length(d) + 1e-9;
        force += d / dist * (iter.wire * w * tanh(dist / 18.0) / max(1.0, f32(m - 1u)));
      }
    }

    // Fixed macros and canvas boundary.
    for (var q = 0u; q < FIXED; q++) {
      let j = topo[${S.fixed}u + q];
      let pj = posIn[base + j];
      if (!sharesSide(i, bitcast<u32>(p.w), j, bitcast<u32>(pj.w))) { continue; }
      var d = p.xy - pj.xy;
      if (abs(d.x) + abs(d.y) < 1e-8) { d = deterministicUnit(i, j) * 1e-3; }
      let ext = 0.5 * (size + compSize(j, bitcast<u32>(pj.z))) + vec2<f32>(${lit(o.macroClearance)});
      let ov = ext - abs(d);
      if (ov.x > 0.0 && ov.y > 0.0) {
        if (ov.x < ov.y) { force.x += select(-1.0, 1.0, d.x >= 0.0) * ${lit(o.macroStrength)} * (0.5 + ov.x / ext.x); }
        else { force.y += select(-1.0, 1.0, d.y >= 0.0) * ${lit(o.macroStrength)} * (0.5 + ov.y / ext.y); }
      } else {
        let nq = d / max(ext, vec2<f32>(1.0));
        let nd = length(nq) + 1e-6;
        if (nd < 1.8) { force += nq / nd * (0.22 * ${lit(o.macroStrength)} * (1.8 - nd) / 1.8); }
      }
    }
    let half = 0.5 * size;
    let hs = max(half, vec2<f32>(1.0));
    let bs = ${lit(o.boundaryStrength)};
    if (p.x < half.x) { force.x += bs * (half.x - p.x) / hs.x; }
    if (p.x > CANVAS.x - half.x) { force.x -= bs * (p.x - (CANVAS.x - half.x)) / hs.x; }
    if (p.y < half.y) { force.y += bs * (half.y - p.y) / hs.y; }
    if (p.y > CANVAS.y - half.y) { force.y -= bs * (p.y - (CANVAS.y - half.y)) / hs.y; }${gridForce}
  }

  // Movable-movable density/overlap, tiled through workgroup memory.
  for (var tile = 0u; tile < MOVABLE; tile += ${WG}u) {
    let src = tile + lid;
    if (src < MOVABLE) {
      let j = topo[${S.movable}u + src];
      let pj = posIn[base + j];
      tilePos[lid] = pj.xy;
      tileSize[lid] = compSize(j, bitcast<u32>(pj.z));
      tileIndex[lid] = j;
      tileSide[lid] = bitcast<u32>(pj.w);
    }
    workgroupBarrier();
    if (live) {
      let count = min(${WG}u, MOVABLE - tile);
      for (var k = 0u; k < count; k++) {
        let j = tileIndex[k];
        if (j != i && sharesSide(i, bitcast<u32>(p.w), j, tileSide[k])) { force += pairForce(i, p.xy, size, j, tilePos[k], tileSize[k]); }
      }
    }
    workgroupBarrier();
  }

  if (live) {
    var v = ${lit(o.damping)} * vel[base + i] + iter.step * force;
    let mag = length(v);
    if (mag > ${lit(o.maxMove)}) { v *= ${lit(o.maxMove)} / mag; }
    vel[base + i] = v;
    let half = 0.5 * size;
    let xy = max(half, min(CANVAS - half, p.xy + v));
    posOut[base + i] = vec4<f32>(xy, p.z, p.w);
  }
}
`;
}

/**
 * WebGPU AnalyticalGlobalPlacer. Runs the same force model as the CPU placer for a
 * whole batch of starting layouts at once (one grid row per start) and reads the
 * positions back only after the last iteration.
 */
export class GpuAnalyticalGlobalPlacer {
  constructor(device, problem, options = {}) {
    this.device = device; this.problem = problem;
    this.options = resolveGlobalPlacerOptions(options);
    this.grid = this.options.gridDensity.strength > 0 ? densityGridSpec(problem, this.options.gridDensity) : null;
    this.tables = buildTables(problem, this.options, this.grid);
    const t = this.tables, U = GPUBufferUsage;
    this.topo = createBuffer(device, t.topo.byteLength, U.STORAGE, t.topo);
    this.stat = createBuffer(device, Math.max(4, t.stat.byteLength), U.STORAGE, t.stat.length ? t.stat : new Float32Array(1));
    this.iterUniform = createBuffer(device, 32, U.UNIFORM | U.COPY_DST);
    const pipeline = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    this.centroidPipeline = pipeline(centroidWgsl(t, this.options, problem.canvas));
    this.forcePipeline = pipeline(forceWgsl(t, this.options, problem.canvas, this.grid));
    if (this.grid) {
      this.scatterPipeline = pipeline(scatterWgsl(t, this.options, problem.canvas, this.grid));
      this.blurXPipeline = pipeline(blurXWgsl(this.grid, this.options.gridDensity.target));
      this.blurYPipeline = pipeline(blurYWgsl(this.grid));
      if (this.grid.blocked) { const b = new Float32Array(2 * this.grid.gw * this.grid.gh); b.set(this.grid.blocked[0]); b.set(this.grid.blocked[1], this.grid.gw * this.grid.gh); this.blockedBuf = createBuffer(device, b.byteLength, U.STORAGE, b); }
    }
  }

  /** Per-iteration schedule, identical to AnalyticalGlobalPlacer.optimize(). */
  #schedule(iterations) {
    const o = this.options, out = new Float32Array(iterations * 8);
    let step = o.step;
    for (let it = 0; it < iterations; it++) {
      const phase = it / Math.max(1, iterations - 1);
      out.set([o.densityStrength * (1.25 - 0.45 * phase), o.overlapStrength * (1.15 - 0.15 * phase), o.wireStrength * (0.75 + 0.45 * phase), step, o.gridDensity.strength], it * 8);
      step *= o.cooling;
    }
    return out;
  }

  /** Run `iterations` steps from every layout in `layouts`; returns the final layouts. */
  async optimizeBatch(layouts, iterations = this.options.iterations) {
    const device = this.device, t = this.tables, n = t.n, starts = layouts.length, U = GPUBufferUsage;
    if (!starts) return [];
    const host = new ArrayBuffer(starts * n * 16), hf = new Float32Array(host), hu = new Uint32Array(host);
    layouts.forEach((layout, s) => layout.forEach((pl, i) => {
      const c = this.problem.components[i], src = c.fixed ?? pl, o = (s * n + i) * 4;
      hf[o] = src.x; hf[o + 1] = src.y; hu[o + 2] = src.rotation & 3; hu[o + 3] = src.side ? 1 : 0;
    }));
    if (!t.movable.length || iterations <= 0) return this.#toLayouts(hf, hu, starts);

    const posBytes = Math.max(16, starts * n * 16);
    const pos = [0, 1].map(() => createBuffer(device, posBytes, U.STORAGE | U.COPY_DST | U.COPY_SRC));
    for (const b of pos) device.queue.writeBuffer(b, 0, host);
    const vel = createBuffer(device, Math.max(8, starts * n * 8), U.STORAGE);
    const centroid = createBuffer(device, Math.max(8, starts * t.nets * 8), U.STORAGE);
    const schedule = this.#schedule(iterations);
    const scheduleBuf = createBuffer(device, schedule.byteLength, U.COPY_SRC, schedule);
    const readback = createBuffer(device, posBytes, U.COPY_DST | U.MAP_READ);

    const entries = (list) => list.flatMap((buffer, binding) => buffer ? [{ binding, resource: { buffer } }] : []);
    const shared = [this.topo, this.stat, this.iterUniform];
    // The centroid pass does not read the iteration uniform (binding 3), so 'auto' drops it.
    const centroidGroups = pos.map((p) => device.createBindGroup({ layout: this.centroidPipeline.getBindGroupLayout(0), entries: entries([p, this.topo, this.stat, null, centroid]) }));
    const g = this.grid, gridCells = g ? starts * 2 * g.gw * g.gh : 0;
    const density = g ? createBuffer(device, gridCells * 4, U.STORAGE) : null;
    const tmp = g ? createBuffer(device, gridCells * g.kernels.length * 4, U.STORAGE) : null;
    const phi = g ? createBuffer(device, gridCells * 4, U.STORAGE) : null;
    const forceGroups = pos.map((p, k) => device.createBindGroup({ layout: this.forcePipeline.getBindGroupLayout(0), entries: entries([p, ...shared, centroid, pos[1 - k], vel, phi]) }));
    const gridGroups = g && {
      scatter: pos.map((p) => device.createBindGroup({ layout: this.scatterPipeline.getBindGroupLayout(0), entries: entries([p, this.topo, this.stat, null, density]) })),
      blurX: device.createBindGroup({ layout: this.blurXPipeline.getBindGroupLayout(0), entries: entries([density, tmp, this.blockedBuf]) }),
      blurY: device.createBindGroup({ layout: this.blurYPipeline.getBindGroupLayout(0), entries: entries([tmp, phi, density]) }),
    };
    const netGroups = Math.ceil(t.nets / NET_WG), compGroups = Math.ceil(t.movable.length / WG);

    try {
      let cur = 0;
      for (let first = 0; first < iterations; first += ITERATIONS_PER_SUBMIT) {
        const enc = device.createCommandEncoder();
        for (let it = first; it < Math.min(iterations, first + ITERATIONS_PER_SUBMIT); it++) {
          enc.copyBufferToBuffer(scheduleBuf, it * 32, this.iterUniform, 0, 32);
          const pass = enc.beginComputePass();
          if (g) {
            pass.setPipeline(this.scatterPipeline); pass.setBindGroup(0, gridGroups.scatter[cur]); pass.dispatchWorkgroups(Math.ceil(n / NET_WG), starts);
            const gx = Math.ceil(g.gw / GRID_WG), gy = Math.ceil(g.gh / GRID_WG);
            pass.setPipeline(this.blurXPipeline); pass.setBindGroup(0, gridGroups.blurX); pass.dispatchWorkgroups(gx, gy, starts * 2);
            pass.setPipeline(this.blurYPipeline); pass.setBindGroup(0, gridGroups.blurY); pass.dispatchWorkgroups(gx, gy, starts * 2);
          }
          if (t.nets) { pass.setPipeline(this.centroidPipeline); pass.setBindGroup(0, centroidGroups[cur]); pass.dispatchWorkgroups(netGroups, starts); }
          pass.setPipeline(this.forcePipeline); pass.setBindGroup(0, forceGroups[cur]); pass.dispatchWorkgroups(compGroups, starts);
          pass.end();
          cur = 1 - cur;
        }
        if (first + ITERATIONS_PER_SUBMIT >= iterations) enc.copyBufferToBuffer(pos[cur], 0, readback, 0, posBytes);
        device.queue.submit([enc.finish()]);
      }
      await readback.mapAsync(GPUMapMode.READ);
      const raw = readback.getMappedRange().slice(0);
      readback.unmap();
      return this.#toLayouts(new Float32Array(raw), new Uint32Array(raw), starts);
    } finally {
      for (const b of [...pos, vel, centroid, scheduleBuf, readback, density, tmp, phi]) b?.destroy();
    }
  }

  async optimize(initial) {
    const [layout] = await this.optimizeBatch([initial]);
    return { layout, trace: [] };
  }

  #toLayouts(f, u, starts) {
    const n = this.tables.n;
    return Array.from({ length: starts }, (_, s) => this.problem.components.map((c, i) => {
      if (c.fixed) return { ...c.fixed };
      const o = (s * n + i) * 4;
      return { x: f[o], y: f[o + 1], rotation: u[o + 2] & 3, side: u[o + 3] & 1 };
    }));
  }

  destroy() { this.topo.destroy(); this.stat.destroy(); this.iterUniform.destroy(); this.blockedBuf?.destroy(); }
}
