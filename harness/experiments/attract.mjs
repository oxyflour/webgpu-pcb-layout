// Attraction test for placement objectives: is the human layout a (local) optimum of the objective?
// One greedy local search on small parts (movable, < 8 pins), legal moves only (no overlap at
// 0.1 mm clearance on a shared side, inside the canvas): shift 0.4-2 mm, quarter / half turn, swap
// with a same-size part within 6 mm. A move is kept when the objective strictly drops.
//   --obj hpwl   : HPWL of all nets (mm, benchmark definition)
//   --obj hpwlx  : HPWL + mu * crossings of signal-net spanning-tree segments (nets with 2-30 parts)
//   --obj hpwlg  : HPWL + nu * channel deficit: sum over facing pad pairs (different parts and nets, shared layer,
//                  overlapping in the other axis) of max(0, 0.8 - gap) mm (a 0.4-0.8 mm gap is 0 or 1 track by grid phase)
//   --obj hpwlgx : both terms
//   --obj ovf    : round-1 overflow cells of the benchmark router (1 round), mean of --phases
//   --obj vias   : vias of the full benchmark routing, mean of --phases
// Router objectives use grid phases off the evaluation diagonal (no grid exploits) and pick parts
// near round-1 overflow cells (--pick ovf, default for them); hpwl / hpwlx pick uniformly.
//   --start human        : legalized human layout (test A, no damage)
//   --start noise<S>     : small parts at human + uniform [-S, S] mm, human rotation, legalized (test B)
// node harness/experiments/attract.mjs --board k60 --start noise2 --obj ovf --seed 1 --out FILE [--evals N] [--budget S] [--mu 5] [--phases 2] [--save F]
import fs from 'node:fs';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { loadBoard, legalize, evaluateRobust, rotatedSize, worldPin } from '../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, n = C.length, H = b.a.originalLayout;
const obj = arg('obj'), nu = Number(arg('nu', 5)), useG = /^hpwlg/.test(obj), useX = /^hpwlg?x$/.test(obj), seed = Number(arg('seed', 1)), startArg = arg('start', 'human'), mu = Number(arg('mu', 5));
const router = obj === 'ovf' || obj === 'vias', phases = Number(arg('phases', obj === 'vias' ? 3 : 2)), pick = arg('pick', router ? 'ovf' : 'uniform');
const evals = Number(arg('evals', router ? 100000 : 30000)), budgetS = Number(arg('budget', 1e9));
let s = seed * 2654435761 >>> 0; const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296), pickOf = (a) => a[Math.floor(rnd() * a.length)];
const small = [...Array(n).keys()].filter((i) => !C[i].fixed && C[i].pins.length < 8);

// Start layout.
let L;
if (startArg === 'human') L = legalize(b, H).layout;
else if (startArg.startsWith('noise')) { const S = Number(startArg.slice(5)), J = H.map((q) => ({ ...q }));
  for (const i of small) J[i] = { ...H[i], x: H[i].x + (rnd() * 2 - 1) * S, y: H[i].y + (rnd() * 2 - 1) * S };
  L = legalize(b, J).layout; }
else { const j = JSON.parse(fs.readFileSync(startArg, 'utf8')); L = legalize(b, j.layout ?? j).layout; }
// --cl > 0.1: the start is re-legalized at that clearance (spacing test).
if (Number(arg('cl', 0.1)) > 0.1) { const { lib } = await import('../lib/env.mjs'), { legalizeLayout } = await lib('src/optimizer/legalizer.js'); L = legalizeLayout(p, L, { clearance: Number(arg('cl')) }).layout; }
L = L.map((q) => ({ ...q }));
const L0 = L.map((q) => ({ ...q }));

// Distance of small parts to the human pose.
const drift = (X) => { const d = small.map((i) => Math.hypot(X[i].x - H[i].x, X[i].y - H[i].y)).sort((a, c) => a - c);
  return { medMm: +d[d.length >> 1].toFixed(2), p90Mm: +d[Math.floor(d.length * 0.9)].toFixed(2), within1: +(d.filter((v) => v <= 1).length / d.length).toFixed(2), sameRot: small.filter((i) => X[i].rotation % 4 === H[i].rotation % 4).length }; };

// Legality.
const W = p.canvas.width, Hh = p.canvas.height, CL = Number(arg("cl", 0.1));
const box = (i, q = L[i]) => { const [w, h] = rotatedSize(C[i], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
const shares = (i, j) => C[i].twoSided || C[j].twoSided || L[i].side === L[j].side;
const legalAt = (i, skip = -1) => { const a = box(i); if (a[0] < 0 || a[1] < 0 || a[2] > W || a[3] > Hh) return false;
  for (let j = 0; j < n; j++) { if (j === i || j === skip || !shares(i, j)) continue; const c = box(j); if (a[0] < c[2] + CL && c[0] < a[2] + CL && a[1] < c[3] + CL && c[1] < a[3] + CL) return false; } return true; };

// Geometric objectives (incremental per net).
const netsOf = Array.from({ length: n }, () => new Set()); p.nets.forEach((net, ni) => net.pins.forEach((pi) => netsOf[p.pins[pi].componentIndex].add(ni)));
const sig = p.nets.map((net) => new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30 && net.pins.length >= 2);
const hp = (ni) => { const ps = p.nets[ni].pins; if (ps.length < 2) return 0; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pi of ps) { const [x, y] = worldPin(p, L, pi); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 - x0 + y1 - y0; };
const netSegs = (ni) => { if (!sig[ni]) return []; const ps = p.nets[ni].pins, pts = ps.map((pi) => worldPin(p, L, pi)), inT = new Array(pts.length).fill(false), best = pts.map((q) => [Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]), 0]), out = [];
  inT[0] = true; for (let it = 1; it < pts.length; it++) { let u = -1; for (let k = 0; k < pts.length; k++) if (!inT[k] && (u < 0 || best[k][0] < best[u][0])) u = k;
    inT[u] = true; const a = pts[best[u][1]], c = pts[u]; out.push([a[0], a[1], c[0], c[1], Math.min(a[0], c[0]), Math.max(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[1], c[1])]);
    for (let k = 0; k < pts.length; k++) if (!inT[k]) { const d = Math.hypot(pts[k][0] - c[0], pts[k][1] - c[1]); if (d < best[k][0]) best[k] = [d, u]; } }
  return out; };
const o3 = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
const X = (s, t) => s[5] >= t[4] && t[5] >= s[4] && s[7] >= t[6] && t[7] >= s[6] && o3(s[0], s[1], s[2], s[3], t[0], t[1]) * o3(s[0], s[1], s[2], s[3], t[2], t[3]) < 0 && o3(t[0], t[1], t[2], t[3], s[0], s[1]) * o3(t[0], t[1], t[2], t[3], s[2], s[3]) < 0;
let hpN = p.nets.map((_, ni) => hp(ni)), segs = p.nets.map((_, ni) => netSegs(ni));
const crossOf = (A) => { let x = 0; for (const ni of A) for (const s of segs[ni]) for (let nj = 0; nj < segs.length; nj++) { if (nj === ni || (A.has(nj) && nj < ni)) continue; for (const t of segs[nj]) if (X(s, t)) x++; } return x; };
const totals = () => { let x = 0; for (let ni = 0; ni < segs.length; ni++) for (const s of segs[ni]) for (let nj = ni + 1; nj < segs.length; nj++) for (const t of segs[nj]) if (X(s, t)) x++;
  return { hpwlMm: Math.round(hpN.reduce((a, v) => a + v, 0)), crossings: x }; };
// Channel deficit between facing pads (router pad geometry).
const RP = b.a.routing.pads, padsOf = Array.from({ length: n }, () => []); RP.forEach((pad, pi) => padsOf[pad.comp].push(pi));
const rq = (x, y, r) => { r = ((r % 4) + 4) % 4; return r === 0 ? [x, y] : r === 1 ? [-y, x] : r === 2 ? [-x, -y] : [y, -x]; };
const padBox = (pi) => { const pad = RP[pi], q = L[pad.comp], [rx, ry] = rq(q.side ? -pad.lx : pad.lx, pad.ly, q.rotation), a = pad.rot * Math.PI / 180;
  let hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h), hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h); if (q.rotation & 1) [hx, hy] = [hy, hx];
  const x = q.x + rx, y = q.y + ry; return [x - hx, y - hy, x + hx, y + hy, pad.tht || pad.hole ? 3 : q.side === 1 ? 2 : 1]; };
const GAP = 0.8, pairPen = (pi, a, pj, c) => { if (RP[pi].comp === RP[pj].comp || (RP[pi].net >= 0 && RP[pi].net === RP[pj].net) || !(a[4] & c[4])) return 0;
  const ox = Math.min(a[2], c[2]) - Math.max(a[0], c[0]), oy = Math.min(a[3], c[3]) - Math.max(a[1], c[1]);
  const g = ox > 0 && oy <= 0 ? -oy : oy > 0 && ox <= 0 ? -ox : ox > 0 && oy > 0 ? 0 : Infinity; return g < GAP ? GAP - g : 0; };
const chanOf = (parts) => { const S = new Set(parts), mine = parts.flatMap((i) => padsOf[i]), mb = mine.map(padBox); let s = 0;
  for (let pj = 0; pj < RP.length; pj++) { const c = padBox(pj); for (let k = 0; k < mine.length; k++) { const pi = mine[k]; if (S.has(RP[pj].comp) && pj <= pi) continue; s += pairPen(pi, mb[k], pj, c); } } return s; };
const chanTotal = () => { const B = RP.map((_, pi) => padBox(pi)); let s = 0; for (let i = 0; i < RP.length; i++) for (let j = i + 1; j < RP.length; j++) s += pairPen(i, B[i], j, B[j]); return s; };
const refresh = () => { hpN = p.nets.map((_, ni) => hp(ni)); segs = p.nets.map((_, ni) => netSegs(ni)); };

// Router objectives (worker pool, one worker per phase).
const offs = Array.from({ length: phases }, (_, k) => [0.4 * (k + 0.5) / phases, 0.4 * (((k * 3 + 1) % phases) + 0.5) / phases]);
const crn = argv.includes('--crn');
// --crn: every try draws fresh random grid phases and routes the old and the new layout on the same phases
// (common random numbers; no fixed grid to exploit); kept when the new mean is lower.
const pool = router ? (crn ? [...offs, ...offs] : offs).map(() => new Worker(new URL('./attract-worker.mjs', import.meta.url), { workerData: { name: b.name } })) : [];
let cells = [];
const routeCost = async (keepCells = false) => {
  const rs = await Promise.all(pool.slice(0, offs.length).map((w, k) => new Promise((res) => { w.once('message', res); w.postMessage({ id: k, layout: L, offset: offs[k], maxRounds: obj === 'ovf' ? 1 : 0, cells: keepCells }); })));
  if (keepCells) cells = rs.flatMap((r) => r.cells);
  return rs.reduce((a, r) => a + (obj === 'ovf' ? r.ovf1 : r.vias), 0) / rs.length; };

const t0 = performance.now();
const startTot = totals(), startDrift = drift(L);
const startChan = chanTotal();
let cur = router ? await routeCost(true) : startTot.hpwlMm + (useG ? nu * startChan : 0) + (useX ? mu * startTot.crossings : 0);
const startCost = cur, trace = [[0, +cur.toFixed(1), startDrift.medMm]];
const near = (x, y, r) => small.filter((i) => { const a = box(i); return x > a[0] - r && x < a[2] + r && y > a[1] - r && y < a[3] + r; });
let accepted = { shift: 0, turn: 0, swap: 0, relocate: 0 }, tried = 0, nextTrace = 1;
// --relocate P: with probability P the move is a jump next to the part's partners (mean of the other pins of its nets
// with <= 30 parts, + uniform +-1.5 mm). --anneal T0: simulated annealing (accept worse by exp(-d/T), T geometric T0 -> T0/1000).
const relocP = Number(arg('relocate', 0)), T0 = Number(arg('anneal', 0));
const partnerMean = (i) => { let sx = 0, sy = 0, k = 0; for (const ni of netsOf[i]) { if (!sig[ni]) continue; for (const pi of p.nets[ni].pins) { if (p.pins[pi].componentIndex === i) continue; const [x, y] = worldPin(p, L, pi); sx += x; sy += y; k++; } } return k ? [sx / k, sy / k] : null; };
const sizeKey = (i, r) => rotatedSize(C[i], r).map((v) => v.toFixed(2)).join();
while (tried < evals && (performance.now() - t0) / 1000 < budgetS) {
  let i;
  if (pick === 'ovf') { if (!cells.length) break; const [cx, cy] = pickOf(cells), cand = near(cx, cy, 1.5); if (!cand.length) { cells = cells.filter((c) => c[0] !== cx || c[1] !== cy); continue; } i = pickOf(cand); }
  else i = pickOf(small);
  const old = { ...L[i] }, kind = rnd(); let j = -1, oldJ = null, type;
  if (kind < relocP) { type = 'relocate'; const m = partnerMean(i); if (!m) continue; L[i] = { ...old, x: m[0] + (rnd() * 2 - 1) * 1.5, y: m[1] + (rnd() * 2 - 1) * 1.5 }; }
  else if (kind < relocP + (1 - relocP) * 0.55) { type = 'shift'; const st = pickOf([0.4, 0.8, 1.2, 2]), dir = pickOf([[1, 0], [-1, 0], [0, 1], [0, -1]]); L[i] = { ...old, x: old.x + dir[0] * st, y: old.y + dir[1] * st }; }
  else if (kind < relocP + (1 - relocP) * 0.8) { type = 'turn'; if (C[i].rotatable === false) continue; L[i] = { ...old, rotation: (old.rotation + pickOf([1, 2, 3])) % 4 }; }
  else { type = 'swap'; const sz = sizeKey(i, old.rotation);
    const others = small.filter((k) => k !== i && L[k].side === old.side && Math.hypot(L[k].x - old.x, L[k].y - old.y) < 6 && [0, 1].some((r) => sizeKey(k, (L[k].rotation + r) % 4) === sz));
    if (!others.length) continue; j = pickOf(others); oldJ = { ...L[j] };
    const rj = sizeKey(j, oldJ.rotation) === sz ? oldJ.rotation : (oldJ.rotation + 1) % 4, ri = sz === sizeKey(j, oldJ.rotation) ? old.rotation : (old.rotation + 1) % 4;
    L[i] = { ...old, x: oldJ.x, y: oldJ.y, rotation: ri }; L[j] = { ...oldJ, x: old.x, y: old.y, rotation: rj }; }
  if (!legalAt(i, j) || (j >= 0 && !legalAt(j, i))) { L[i] = old; if (j >= 0) L[j] = oldJ; continue; }
  tried++;
  let ok;
  if (router && crn) {
    const Lold = L.slice(); Lold[i] = old; if (j >= 0) Lold[j] = oldJ;
    const ph = offs.map(() => [rnd() * 0.4, rnd() * 0.4]), key = obj === 'ovf' ? 'ovf1' : 'vias';
    const rs = await Promise.all(pool.map((w, k) => new Promise((res) => { w.once('message', res); w.postMessage({ id: k, layout: k < phases ? Lold : L, offset: ph[k % phases], maxRounds: obj === 'ovf' ? 1 : 0, cells: k < phases }); })));
    const mo = rs.slice(0, phases).reduce((a, r) => a + r[key], 0) / phases, mn = rs.slice(phases).reduce((a, r) => a + r[key], 0) / phases;
    cells = rs.slice(0, phases).flatMap((r) => r.cells); ok = mn < mo; if (ok) cur += mn - mo; }
  else if (router) { const c = await routeCost(); ok = c < cur; if (ok) { cur = c; if (pick === 'ovf') await routeCost(true); } }
  else { const A = new Set([...netsOf[i], ...(j >= 0 ? netsOf[j] : [])]), oldH = [...A].map((ni) => hpN[ni]), oldS = [...A].map((ni) => segs[ni]);
    const parts = j >= 0 ? [i, j] : [i], swapL = () => { const nw = parts.map((k) => L[k]); L[i] = old; if (j >= 0) L[j] = oldJ; return nw; };
    let g0 = 0, g1 = 0; if (useG) { const nw = swapL(); g0 = chanOf(parts); L[i] = nw[0]; if (j >= 0) L[j] = nw[1]; g1 = chanOf(parts); }
    const x0 = useX ? crossOf(A) : 0, h0 = oldH.reduce((a, v) => a + v, 0);
    for (const ni of A) { hpN[ni] = hp(ni); if (useX) segs[ni] = netSegs(ni); }
    const x1 = useX ? crossOf(A) : 0, h1 = [...A].reduce((a, ni) => a + hpN[ni], 0), d = h1 - h0 + mu * (x1 - x0) + nu * (g1 - g0);
    const T = T0 ? T0 * Math.pow(1e-3, tried / evals) : 0; ok = d < -1e-6 || (T > 0 && rnd() < Math.exp(-d / T)); if (ok) cur += d; else [...A].forEach((ni, k) => { hpN[ni] = oldH[k]; segs[ni] = oldS[k]; }); }
  if (ok) accepted[type]++; else { L[i] = old; if (j >= 0) L[j] = oldJ; }
  if (tried >= nextTrace) { trace.push([tried, +cur.toFixed(1), drift(L).medMm]); nextTrace *= 2; }
}
pool.forEach((w) => w.terminate());
const searchS = (performance.now() - t0) / 1000;
trace.push([tried, +cur.toFixed(1), drift(L).medMm]);
refresh();
const endTot = totals(), leg = legalize(b, L);
if (arg('save')) fs.writeFileSync(arg('save'), JSON.stringify(leg.layout));
const [m0, m1] = [await evaluateRobust(b, L0, { router: 'native', detail: true }), await evaluateRobust(b, leg.layout, { router: 'native', detail: true })];
const pick3 = (m) => ({ clean: m.clean, vias: m.vias, hpwlMm: m.hpwlMm, ovf1: m.margin?.overflowRound1 });
const row = { board: b.name, start: startArg, obj, crn: crn || undefined, cl: CL, mu: useX ? mu : undefined, seed, phases: router ? phases : undefined, pick, evals: tried, searchS: Math.round(searchS), accepted, legalizerMoved: leg.moved,
  objective: [+startCost.toFixed(1), +cur.toFixed(1)], crossings: [startTot.crossings, endTot.crossings], channelDeficitMm: [+startChan.toFixed(1), +chanTotal().toFixed(1)], nu: useG ? nu : undefined, drift: [startDrift, drift(leg.layout)], eval: [pick3(m0), pick3(m1)], trace };
fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
