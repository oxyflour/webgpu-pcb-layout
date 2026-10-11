// Detailed placement after the legalizer: greedy local search on small parts (movable, < 8 pins),
// legal moves only (no body overlap at 0.1 mm clearance on a shared side, inside the canvas):
// shift 0.4-2 mm, quarter / half turn, swap with a same-size part within 6 mm. A move is kept when
//   cost = HPWL (mm, all nets, benchmark definition) + nu * channel deficit (mm)
// drops (simulated annealing: a worse move is kept with probability exp(-d / T), T falls geometrically
// from T0 to T0 / 1000 over the tries (evals) or the time budget, whichever runs out first; T0 = 0 is greedy). A fourth move, relocate, jumps the part
// next to its partners (mean of the other pins of its nets with <= 30 parts, +-1.5 mm).
// Channel deficit = sum over facing pad pairs (different parts and nets, shared layer, overlapping in
// the other axis) of max(0, 0.8 mm - gap) (a 0.4-0.8 mm gap passes 0 or 1 track on the 0.4 mm routing
// grid depending on the grid phase; human k60: 161 such pairs, tool 598). Neighbour queries use a
// 4 mm bucket grid of part bodies.
// experiments/attract.mjs (obj hpwlg) is the offline version; RESULTS.md "Attraction test".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rotatedSize, worldPin } from './board.mjs';
import { HARNESS_ROOT } from './env.mjs';
import { loadConstraints } from './constraints.mjs';
import { padCentre, padBox as padBoxOf, spanningSegments } from './geometry.mjs';
// Optional human-practice terms (RESULTS.md "New metrics against the human layout"):
//   kappa (default 0.5) * distance (mm) of every decoupling capacitor's supply pad to the nearest supply pad of
//   its assigned IC(s) (lib/constraints.mjs: constraint file, else same schematic sheet, else any IC on the
//   supply) beyond decapFreeMm, + 10 x kappa per mm beyond a decap's maxMm;
//   critical nets with limits in the constraint file (maxVias, maxLengthMm, keepoutMm, layer, priority,
//   maxMismatchMm): HPWL x (1 + critW), + 10 per mm of HPWL beyond maxLengthMm, + |HPWL difference| of a
//   pair beyond maxMismatchMm, + rho per foreign pad (sharing a layer with the net) in the corridor of
//   the net's pin-to-pin spanning-tree segments (half width keepoutMm or 0.2, + 0.2 mm): a clear,
//   straight path the router can take without vias. `constraints` overrides loadConstraints(b); chi: crystal nets count (1 + chi) x HPWL.
const analyses = new WeakMap();
// engine: 'js' | 'native' (native/detail.cpp: same random stream and move sequence, identical result with
// T0 = 0 and a fixed number of tries; no critical-net terms) | 'auto' (native when built and no critical
// nets with limits). Distances use sqrt(dx^2 + dy^2), not Math.hypot, so both engines round alike.
export const DETAIL_EXE = path.join(HARNESS_ROOT, 'native', process.platform === 'win32' ? 'detail.exe' : 'detail');
export const nativeDetailAvailable = () => fs.existsSync(DETAIL_EXE);
const dist = (dx, dy) => Math.sqrt(dx * dx + dy * dy);

export function detailPlace(b, layout, { nu = 2, T0 = 3, relocate = 0.15, evals = Infinity, budgetS = 30, seed = 1, gap = 0.8, clearance = 0.1, kappa = 0.5, decapFreeMm = 0, chi = 0, critW = 3, rho = 4, constraints = null, engine = 'auto' } = {}) {
  const p = b.p, C = p.components, n = C.length, L = layout.map((q) => ({ ...q })), t0 = performance.now();
  let s = seed * 2654435761 >>> 0; const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296), pickOf = (a) => a[Math.floor(rnd() * a.length)];
  const small = [...Array(n).keys()].filter((i) => !C[i].fixed && C[i].pins.length < 8);
  if (!small.length) return { layout: L, evals: 0, accepted: 0 };
  const W = p.canvas.width, H = p.canvas.height;
  const box = (i, q = L[i]) => { const [w, h] = rotatedSize(C[i], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
  const shares = (i, j) => C[i].twoSided || C[j].twoSided || L[i].side === L[j].side;
  // Bucket grid of part bodies (4 mm cells); `where[i]` = cells holding part i, updated on accepted moves.
  const G = 4, gw = Math.ceil(W / G) + 1, gh = Math.ceil(H / G) + 1, buckets = Array.from({ length: gw * gh }, () => []), where = new Array(n), mark = new Int32Array(n);
  let stamp = 0;
  const cellRange = (a) => [Math.max(0, Math.min(gw - 1, Math.floor(a[0] / G))), Math.max(0, Math.min(gh - 1, Math.floor(a[1] / G))), Math.max(0, Math.min(gw - 1, Math.floor(a[2] / G))), Math.max(0, Math.min(gh - 1, Math.floor(a[3] / G)))];
  const insert = (i) => { const [x0, y0, x1, y1] = cellRange(box(i)); where[i] = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { buckets[y * gw + x].push(i); where[i].push(y * gw + x); } };
  const remove = (i) => { for (const c of where[i]) { const bk = buckets[c], k = bk.indexOf(i); bk[k] = bk[bk.length - 1]; bk.pop(); } };
  for (let i = 0; i < n; i++) insert(i);
  // Visit every part whose cells meet rectangle a (each once per stamp).
  const visit = (a, fn) => { const [x0, y0, x1, y1] = cellRange(a); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (const j of buckets[y * gw + x]) if (mark[j] !== stamp) { mark[j] = stamp; fn(j); } };
  const legalAt = (i, skip = -1) => { const a = box(i); if (a[0] < 0 || a[1] < 0 || a[2] > W || a[3] > H) return false;
    let ok = true; stamp++; visit([a[0] - clearance, a[1] - clearance, a[2] + clearance, a[3] + clearance], (j) => { if (!ok || j === i || j === skip || !shares(i, j)) return; const c = box(j); if (a[0] < c[2] + clearance && c[0] < a[2] + clearance && a[1] < c[3] + clearance && c[1] < a[3] + clearance) ok = false; }); return ok; };
  // HPWL per net.
  const netsOf = Array.from({ length: n }, () => new Set()); p.nets.forEach((net, ni) => net.pins.forEach((pi) => netsOf[p.pins[pi].componentIndex].add(ni)));
  const hp = (ni) => { const ps = p.nets[ni].pins; if (ps.length < 2) return 0; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pi of ps) { const [x, y] = worldPin(p, L, pi); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x1 - x0 + y1 - y0; };
  const hpN = p.nets.map((_, ni) => hp(ni));
  // Decoupling and crystal terms.
  const CN = constraints ?? analyses.get(b) ?? (analyses.set(b, loadConstraints(b)), analyses.get(b)), HA = CN.analysis;
  const wN = new Float64Array(p.nets.length).fill(1); if (chi) for (const ni of HA.groups.crystal) wN[ni] = 1 + chi;
  const decaps = kappa ? CN.decaps.map((d) => { const ics = new Set(d.ics); return { ...d, ic: HA.icPadsOn[d.net].filter((q) => ics.has(HA.padOf[q].comp)) }; }).filter((d) => d.ic.length) : [];
  const decapOwn = new Int32Array(n).fill(-1); decaps.forEach((d, k) => { decapOwn[d.comp] = k; });
  const decapsBy = Array.from({ length: n }, () => []); decaps.forEach((d, k) => { decapsBy[d.comp].push(k); for (const q of new Set(d.ic.map((q) => HA.padOf[q].comp))) decapsBy[q].push(k); });
  const centre = (rp) => padCentre(L, rp);
  const decapDist = (k) => { const d = decaps[k], [x, y] = centre(HA.padOf[d.pad].rp); let best = Infinity; for (const q of d.ic) { const [u, v] = centre(HA.padOf[q].rp), e = dist(u - x, v - y); if (e < best) best = e; } return Math.max(0, best - decapFreeMm) + (d.maxMm != null ? 10 * Math.max(0, best - d.maxMm) : 0); };
  const decapOf = (parts) => { if (!kappa) return 0; const ks = new Set(parts.flatMap((i) => decapsBy[i])); let s = 0; for (const k of ks) s += decapDist(k); return s; };
  // Channel deficit (router pad geometry, as src/router/board-router.js rasterizes it).
  const RP = b.a.routing.pads, padsOf = Array.from({ length: n }, () => []); RP.forEach((pad, pi) => padsOf[pad.comp].push(pi));
  const padBox = (pi) => padBoxOf(L, RP[pi]);
  const pairPen = (pi, a, pj, c) => { if (RP[pi].comp === RP[pj].comp || (RP[pi].net >= 0 && RP[pi].net === RP[pj].net) || !(a[4] & c[4])) return 0;
    const ox = Math.min(a[2], c[2]) - Math.max(a[0], c[0]), oy = Math.min(a[3], c[3]) - Math.max(a[1], c[1]);
    const g = ox > 0 && oy <= 0 ? -oy : oy > 0 && ox <= 0 ? -ox : ox > 0 && oy > 0 ? 0 : Infinity; return g < gap ? gap - g : 0; };
  // Deficit of the pairs involving the pads of `parts` (pairs inside `parts` once); only parts whose
  // body is within `gap` + 2 mm of a moved part can contribute.
  const chanOf = (parts) => { const S = new Set(parts), mine = parts.flatMap((i) => padsOf[i]), mb = mine.map(padBox), r = gap + 2; let sum = 0;
    const near = [...parts]; stamp++; for (const i of parts) mark[i] = stamp;
    for (const i of parts) { const a = box(i); visit([a[0] - r, a[1] - r, a[2] + r, a[3] + r], (j) => near.push(j)); }
    for (const j of near) { if (!padsOf[j].length) continue;
      for (const pj of padsOf[j]) { const cb = padBox(pj); for (let k = 0; k < mine.length; k++) { if (S.has(j) && pj <= mine[k]) continue; sum += pairPen(mine[k], mb[k], pj, cb); } } }
    return sum; };
  // Critical nets with limits.
  const LIM = ['priority', 'maxVias', 'layer', 'keepoutMm', 'maxLengthMm', 'maxMismatchMm'];
  const crit = critW || rho ? CN.critical.filter((c) => LIM.some((k) => c[k] != null)).map((c) => ({ ...c, hw: (c.keepoutMm ?? 0.2) + 0.2 })) : [];
  for (const c of crit) for (const ni of c.nets) wN[ni] *= 1 + critW;
  const critOfComp = Array.from({ length: n }, () => new Set()); crit.forEach((c, k) => c.nets.forEach((ni) => p.nets[ni].pins.forEach((pi) => critOfComp[p.pins[pi].componentIndex].add(k))));
  // Layers of a net's pads (sides never change in the pass, so cached).
  const layerCache = new Map(), netLayers = (ni) => { if (!layerCache.has(ni)) { let m = 0; for (let pj = 0; pj < RP.length; pj++) if (RP[pj].net === ni) m |= padBox(pj)[4]; layerCache.set(ni, m); } return layerCache.get(ni); };
  const segsOf = (ni) => spanningSegments(p.nets[ni].pins.map((pi) => worldPin(p, L, pi)));
  const segDist = (x, y, [a, c]) => { const dx = c[0] - a[0], dy = c[1] - a[1], l2 = dx * dx + dy * dy, u = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0; return dist(a[0] + u * dx - x, a[1] + u * dy - y); };
  const critBox = (c) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const ni of c.nets) for (const pi of p.nets[ni].pins) { const [x, y] = worldPin(p, L, pi); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return [x0 - c.hw - 1, y0 - c.hw - 1, x1 + c.hw + 1, y1 + c.hw + 1]; };
  const critCost = (k) => { const c = crit[k]; let s = 0;
    for (const ni of c.nets) { const lm = netLayers(ni);
      for (const sg of segsOf(ni)) { stamp++; visit([Math.min(sg[0][0], sg[1][0]) - c.hw - 1, Math.min(sg[0][1], sg[1][1]) - c.hw - 1, Math.max(sg[0][0], sg[1][0]) + c.hw + 1, Math.max(sg[0][1], sg[1][1]) + c.hw + 1], (j) => {
        for (const pj of padsOf[j]) { if (RP[pj].net === ni) continue; const bx = padBox(pj); if (!(bx[4] & lm)) continue; const r = Math.max(bx[2] - bx[0], bx[3] - bx[1]) / 2; if (segDist((bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2, sg) < c.hw + r) s += rho; } }); }
      if (c.maxLengthMm != null) s += 10 * Math.max(0, hp(ni) - c.maxLengthMm); }
    if (c.kind === 'pair' && c.maxMismatchMm != null) s += Math.max(0, Math.abs(hp(c.nets[0]) - hp(c.nets[1])) - c.maxMismatchMm);
    return s; };
  const intersects = (a, c) => a[0] < c[2] && c[0] < a[2] && a[1] < c[3] && c[1] < a[3];
  const critTouched = (parts, ks) => { for (const i of parts) { for (const k of critOfComp[i]) ks.add(k); const a = box(i); crit.forEach((c, k) => { if (!ks.has(k) && intersects(a, critBox(c))) ks.add(k); }); } return ks; };
  const critOf = (ks) => { let s = 0; for (const k of ks) s += critCost(k); return s; };
  const sig = p.nets.map((net) => new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30);
  const partnerMean = (i) => { let sx = 0, sy = 0, k = 0; for (const ni of netsOf[i]) { if (!sig[ni]) continue; for (const pi of p.nets[ni].pins) { if (p.pins[pi].componentIndex === i) continue; const [x, y] = worldPin(p, L, pi); sx += x; sy += y; k++; } } return k ? [sx / k, sy / k] : null; };
  const sizeKey = (i, r) => rotatedSize(C[i], r).map((v) => v.toFixed(2)).join();
  if (engine === 'native' || (engine === 'auto' && !crit.length && nativeDetailAvailable())) {
    if (crit.length) throw new Error('native detail pass: critical-net terms are not ported (engine js)');
    return runNative({ b, L, small, sizeKey, wN, decaps, sig, RP, opts: { nu, T0, relocate, evals, budgetS, seed, gap, clearance, kappa, decapFreeMm } });
  }
  let tried = 0, accepted = 0, delta = 0;
  while (tried < evals && (performance.now() - t0) / 1000 < budgetS) {
    const i = pickOf(small), old = { ...L[i] }, kind = rnd(); let j = -1, oldJ = null;
    // relocate: next to the partners' mean; a decoupling capacitor jumps next to a supply pad of its IC.
    if (kind < relocate) { const own = decapOwn[i], m = own >= 0 ? centre(HA.padOf[pickOf(decaps[own].ic)].rp) : partnerMean(i); if (!m) continue; L[i] = { ...old, x: m[0] + (rnd() * 2 - 1) * 1.5, y: m[1] + (rnd() * 2 - 1) * 1.5 }; }
    else if (kind < relocate + (1 - relocate) * 0.55) { const st = pickOf([0.4, 0.8, 1.2, 2]), dir = pickOf([[1, 0], [-1, 0], [0, 1], [0, -1]]); L[i] = { ...old, x: old.x + dir[0] * st, y: old.y + dir[1] * st }; }
    else if (kind < relocate + (1 - relocate) * 0.8) { if (C[i].rotatable === false) continue; L[i] = { ...old, rotation: (old.rotation + pickOf([1, 2, 3])) % 4 }; }
    else { const sz = sizeKey(i, old.rotation);
      const others = small.filter((k) => k !== i && L[k].side === old.side && Math.abs(L[k].x - old.x) < 6 && Math.abs(L[k].y - old.y) < 6 && dist(L[k].x - old.x, L[k].y - old.y) < 6 && [0, 1].some((r) => sizeKey(k, (L[k].rotation + r) % 4) === sz));
      if (!others.length) continue; j = pickOf(others); oldJ = { ...L[j] };
      const rj = sizeKey(j, oldJ.rotation) === sz ? oldJ.rotation : (oldJ.rotation + 1) % 4, ri = sz === sizeKey(j, oldJ.rotation) ? old.rotation : (old.rotation + 1) % 4;
      L[i] = { ...old, x: oldJ.x, y: oldJ.y, rotation: ri }; L[j] = { ...oldJ, x: old.x, y: old.y, rotation: rj }; }
    if (!legalAt(i, j) || (j >= 0 && !legalAt(j, i))) { L[i] = old; if (j >= 0) L[j] = oldJ; continue; }
    tried++;
    const parts = j >= 0 ? [i, j] : [i], nw = parts.map((k) => L[k]);
    L[i] = old; if (j >= 0) L[j] = oldJ;
    const g0 = nu ? chanOf(parts) : 0;
    L[i] = nw[0]; if (j >= 0) L[j] = nw[1];
    const g1 = nu ? chanOf(parts) : 0, c1 = decapOf(parts), ks = crit.length ? critTouched(parts, new Set()) : null;
    L[i] = old; if (j >= 0) L[j] = oldJ; const c0 = decapOf(parts); if (ks) critTouched(parts, ks); const k0 = ks?.size ? critOf(ks) : 0;
    L[i] = nw[0]; if (j >= 0) L[j] = nw[1]; const k1 = ks?.size ? critOf(ks) : 0;
    const A = new Set(parts.flatMap((k) => [...netsOf[k]])), oldH = [...A].map((ni) => hpN[ni]);
    let dh = 0; for (const ni of A) { const v = hp(ni); dh += (v - hpN[ni]) * wN[ni]; hpN[ni] = v; }
    const d = dh + nu * (g1 - g0) + kappa * (c1 - c0) + (k1 - k0);
    // Progress: share of the tries when they are bounded, else of the time budget (the larger of both).
    const T = T0 ? T0 * Math.pow(1e-3, Math.min(1, Math.max(isFinite(evals) ? tried / evals : 0, (performance.now() - t0) / 1000 / budgetS))) : 0;
    if (d < -1e-6 || (T > 0 && rnd() < Math.exp(-d / T))) { accepted++; delta += d; for (const k of parts) { remove(k); insert(k); } }
    else { [...A].forEach((ni, k) => { hpN[ni] = oldH[k]; }); L[i] = old; if (j >= 0) L[j] = oldJ; }
  }
  return { layout: L, evals: tried, accepted, costDelta: Math.round(delta), seconds: Math.round((performance.now() - t0) / 100) / 10 };
}

// Binary input of native/detail.cpp (format documented there) and the result merged into the layout.
function runNative({ b, L, small, sizeKey, wN, decaps, sig, RP, opts }) {
  const p = b.p, C = p.components, n = C.length, parts = [], keys = new Map(), key = (s) => { if (!keys.has(s)) keys.set(s, keys.size); return keys.get(s); };
  const i32 = (a) => { const x = Buffer.alloc(a.length * 4); a.forEach((v, k) => x.writeInt32LE(v, k * 4)); parts.push(x); };
  const f64 = (a) => { const x = Buffer.alloc(a.length * 8); a.forEach((v, k) => x.writeDoubleLE(v, k * 8)); parts.push(x); };
  const isSmall = new Uint8Array(n); for (const i of small) isSmall[i] = 1;
  i32([n, p.nets.length, p.pins.length, RP.length, decaps.length, opts.seed * 2654435761 >>> 0 | 0]);
  f64([p.canvas.width, p.canvas.height, opts.clearance, opts.nu, opts.T0, opts.relocate, opts.budgetS, opts.gap, opts.kappa, opts.decapFreeMm, opts.evals]);
  C.forEach((c, i) => { f64([c.width, c.height, L[i].x, L[i].y]); i32([L[i].rotation, L[i].side ? 1 : 0, c.twoSided ? 1 : 0, c.rotatable === false ? 0 : 1, isSmall[i], key(sizeKey(i, 0)), key(sizeKey(i, 1))]); });
  p.pins.forEach((q) => { i32([q.componentIndex]); f64([q.x, q.y]); });
  p.nets.forEach((net, ni) => { i32([net.pins.length, sig[ni] ? 1 : 0]); f64([wN[ni]]); i32(net.pins); });
  RP.forEach((pad) => { const a = pad.rot * Math.PI / 180; i32([pad.comp, pad.net, pad.tht || pad.hole ? 1 : 0]);
    f64([pad.lx, pad.ly, 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h), 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h)]); });
  decaps.forEach((d) => { i32([d.comp, d.pad, d.maxMm != null ? 1 : 0]); f64([d.maxMm ?? 0]); i32([d.ic.length]); i32(d.ic); });
  const file = path.join(os.tmpdir(), `detail-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(file, Buffer.concat(parts));
  try {
    const r = spawnSync(DETAIL_EXE, [file], { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
    if (r.status !== 0) throw new Error(`native detail pass failed (${r.status}): ${r.stderr || r.error?.message}`);
    const o = JSON.parse(r.stdout);
    o.layout.forEach(([x, y, rotation], i) => { L[i] = { ...L[i], x, y, rotation }; });
    return { layout: L, evals: o.evals, accepted: o.accepted, costDelta: o.costDelta, seconds: o.seconds, searchSeconds: o.searchSeconds, readSeconds: o.readSeconds, engine: 'native', ...(r.stderr.trim() ? { profile: JSON.parse(r.stderr.trim()) } : {}) };
  } finally { fs.rmSync(file, { force: true }); }
}
