// Can a weighted HPWL make the human small-part positions optimal? Diagnostic in perfect context:
// every other part at its human pose, one small part (movable, < 8 pins) at a time, its human rotation.
// For one part the weighted HPWL f(x, y) = sum_n w(class n) * HPWL_n is separable in x and y, convex and
// piecewise linear, so its minimizers form a box [x0, x1] x [y0, y1]; "distance" = distance of the human
// centre to that box (0 = the human position is optimal).
//   1. upper bound: share of parts whose human centre lies in the box any weights can reach
//      (the box of the per-axis pin breakpoints of all their nets);
//   2. learned class weights (ranking loss: the human position must not lose to shifts of 0.5-5 mm
//      along x or y), leave one board out;
//   3. distance to the minimizer box for: unweighted HPWL, learned weights, and the tool start rule.
// Net class = size bucket (2 / 3-5 / 6-30 parts) x large parts on it (IC = movable >= 8 pins, connector
// = fixed >= 8 pins: none / IC / connector / both); crystal and differential-pair nets have their own.
// node harness/experiments/hpwl-weights.mjs [--boards a,b] [--test-only ppc-n3] [--out FILE.json]
import fs from 'node:fs';
import { loadBoard, worldPin, EVAL_BOARDS } from '../lib/board.mjs';
import { boardAnalysis } from '../lib/human-metrics.mjs';
import { startLayout } from '../lib/init.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const boards = arg('boards', EVAL_BOARDS.filter((b) => b !== 'ppc-n3').join(',')).split(','), testOnly = arg('test-only', 'ppc-n3').split(',').filter(Boolean);
const SIZE = ['2', '3-5', '6-30'], BIG = ['none', 'IC', 'conn', 'IC+conn'];
const CLASSES = [...SIZE.flatMap((s) => BIG.map((g) => `${s}/${g}`)), 'crystal', 'pair'];
const SHIFTS = [0.5, 1, 2, 3, 5];

// Per board: for every small part, per axis, the terms of f: [{cls, lo, hi, offs}] with lo / hi the
// extremes of the other pins of the net and offs the offsets of the part's own pins on it.
function analyse(name) {
  const b = loadBoard(name), p = b.p, C = p.components, H = b.a.originalLayout, A = boardAnalysis(b);
  const big = (i) => C[i].pins.length >= 8, crystal = new Set(A.groups.crystal), pair = new Set(A.pairs.flat());
  const cls = p.nets.map((net, ni) => {
    const parts = [...new Set(net.pins.map((pi) => p.pins[pi].componentIndex))]; if (parts.length < 2 || parts.length > 30) return -1;
    if (crystal.has(ni)) return CLASSES.indexOf('crystal'); if (pair.has(ni)) return CLASSES.indexOf('pair');
    const ic = parts.some((i) => big(i) && !C[i].fixed), conn = parts.some((i) => big(i) && C[i].fixed);
    return CLASSES.indexOf(`${parts.length === 2 ? '2' : parts.length <= 5 ? '3-5' : '6-30'}/${ic && conn ? 'IC+conn' : ic ? 'IC' : conn ? 'conn' : 'none'}`);
  });
  const pinsOf = C.map(() => []); p.pins.forEach((pin, pi) => pinsOf[pin.componentIndex].push(pi));
  const netOfPin = new Int32Array(p.pins.length).fill(-1); p.nets.forEach((n, ni) => n.pins.forEach((pi) => { netOfPin[pi] = ni; }));
  const S = startLayout(b, {}, { seed: 1 }), parts = [];
  // Tool start rule in perfect context: every small part re-placed with all other parts at their human pose.
  for (let i = 0; i < C.length; i++) {
    if (C[i].fixed || C[i].pins.length >= 8) continue;
    const byNet = new Map();
    for (const pi of pinsOf[i]) { const ni = netOfPin[pi]; if (ni < 0 || cls[ni] < 0) continue; if (!byNet.has(ni)) byNet.set(ni, []); byNet.get(ni).push(pi); }
    const terms = [[], []];
    for (const [ni, own] of byNet) {
      const others = p.nets[ni].pins.filter((pj) => p.pins[pj].componentIndex !== i).map((pj) => worldPin(p, H, pj)); if (!others.length) continue;
      for (const ax of [0, 1]) { const c = H[i][ax ? 'y' : 'x'];
        terms[ax].push({ cls: cls[ni], lo: Math.min(...others.map((q) => q[ax])), hi: Math.max(...others.map((q) => q[ax])), offs: own.map((pi) => worldPin(p, H, pi)[ax] - c) }); }
    }
    if (!terms[0].length) continue;
    parts.push({ board: name, ref: C[i].id, h: [H[i].x, H[i].y], terms });
  }
  // Start rule with perfect context: one part at a time (startLayout with every other part planned at its human pose).
  const plan = Object.fromEntries(C.map((c, i) => [c.id, { x: H[i].x, y: H[i].y, rotation: H[i].rotation }]).filter(([ref]) => !C.find((c) => c.id === ref).fixed));
  for (const q of parts) { const { [q.ref]: _, ...others } = plan, L = startLayout(b, others, { seed: 1 }), i = C.findIndex((c) => c.id === q.ref); q.rule = [L[i].x, L[i].y]; }
  return parts;
}

// One axis: f(x) = sum w * (max(hi, x + max off) - min(lo, x + min off)); minimizer interval.
const fAxis = (terms, w, x) => terms.reduce((s, t) => { const a = Math.max(...t.offs), z = Math.min(...t.offs); return s + w[t.cls] * (Math.max(t.hi, x + a) - Math.min(t.lo, x + z)); }, 0);
function argminAxis(terms, w) {
  const cand = terms.flatMap((t) => t.offs.flatMap((o) => [t.lo - o, t.hi - o])).sort((a, c) => a - c);
  let best = Infinity, lo = 0, hi = 0;
  for (const x of cand) { const v = fAxis(terms, w, x); if (v < best - 1e-9) { best = v; lo = hi = x; } else if (Math.abs(v - best) <= 1e-9) hi = x; }
  return [lo, hi];
}
const boxDist = (h, bx) => Math.hypot(...[0, 1].map((ax) => Math.max(0, bx[ax][0] - h[ax], h[ax] - bx[ax][1])));
const reach = (q) => [0, 1].map((ax) => { const c = q.terms[ax].flatMap((t) => t.offs.flatMap((o) => [t.lo - o, t.hi - o])); return [Math.min(...c), Math.max(...c)]; });

// Ranking samples: per part, axis, shift: feature vector d[c] = sum over class-c terms of (f_c(x_h + s) - f_c(x_h)).
function samples(parts) {
  const out = [];
  for (const q of parts) for (const ax of [0, 1]) for (const s of SHIFTS) for (const sg of [-1, 1]) {
    const d = new Float64Array(CLASSES.length), x0 = q.h[ax], x1 = x0 + sg * s;
    for (const t of q.terms[ax]) { const a = Math.max(...t.offs), z = Math.min(...t.offs); d[t.cls] += (Math.max(t.hi, x1 + a) - Math.min(t.lo, x1 + z)) - (Math.max(t.hi, x0 + a) - Math.min(t.lo, x0 + z)); }
    if (d.some((v) => Math.abs(v) > 1e-9)) out.push(d);
  }
  return out;
}
// Learn w >= 0 (mean 1) minimizing mean log(1 + exp(-w.d / tau)) by projected gradient descent.
function learn(S, { tau = 0.5, iters = 3000, lr = 0.05 } = {}) {
  const K = CLASSES.length; let w = new Float64Array(K).fill(1);
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(K);
    for (const d of S) { let m = 0; for (let k = 0; k < K; k++) m += w[k] * d[k]; const sgm = 1 / (1 + Math.exp(m / tau)); for (let k = 0; k < K; k++) g[k] -= sgm * d[k] / tau; }
    for (let k = 0; k < K; k++) w[k] = Math.max(0, w[k] - lr * g[k] / S.length);
    const mean = w.reduce((a, v) => a + v, 0) / K; if (mean > 0) for (let k = 0; k < K; k++) w[k] /= mean;
  }
  return Array.from(w, (v) => +v.toFixed(3));
}
const med = (v) => { const s = [...v].sort((a, c) => a - c); return s.length ? s[(s.length - 1) >> 1] : NaN; };
const share = (v, f) => v.filter(f).length / v.length;

const data = Object.fromEntries([...boards, ...testOnly].map((bd) => [bd, analyse(bd)]));
const ones = new Array(CLASSES.length).fill(1), rows = [];
const all = learn(boards.flatMap((bd) => samples(data[bd])));
for (const bd of [...boards, ...testOnly]) {
  const train = boards.filter((x) => x !== bd), w = learn(train.flatMap((x) => samples(data[x]))), P = data[bd];
  const dist = (wt) => P.map((q) => boxDist(q.h, [0, 1].map((ax) => argminAxis(q.terms[ax], wt))));
  const dU = dist(ones), dW = dist(w), dR = P.map((q) => Math.hypot(q.rule[0] - q.h[0], q.rule[1] - q.h[1])), inReach = P.filter((q) => boxDist(q.h, reach(q)) < 1e-6).length;
  rows.push({ board: bd, parts: P.length, inReach: +(inReach / P.length).toFixed(2), unweighted: { med: +med(dU).toFixed(2), opt: +share(dU, (v) => v < 0.25).toFixed(2), within2: +share(dU, (v) => v <= 2).toFixed(2) }, learned: { med: +med(dW).toFixed(2), opt: +share(dW, (v) => v < 0.25).toFixed(2), within2: +share(dW, (v) => v <= 2).toFixed(2) }, rule: { med: +med(dR).toFixed(2), within2: +share(dR, (v) => v <= 2).toFixed(2) }, weights: w });
  console.log(JSON.stringify(rows.at(-1)));
}
// Upper bound of class weighting: coordinate search of w (values 0.1-10) minimizing the mean distance on
// the training boards themselves (in-sample, no hold-out).
const trainParts = boards.flatMap((bd) => data[bd]), meanDist = (wt) => trainParts.reduce((s, q) => s + boxDist(q.h, [0, 1].map((ax) => argminAxis(q.terms[ax], wt))), 0) / trainParts.length;
let wb = [...ones], fb = meanDist(wb); const f0 = fb;
for (let pass = 0; pass < 3; pass++) for (let k = 0; k < CLASSES.length; k++) for (const v of [0.1, 0.25, 0.5, 1, 2, 4, 10]) { const w2 = [...wb]; w2[k] = v; const f = meanDist(w2); if (f < fb - 1e-6) { fb = f; wb = w2; } }
console.log(`
in-sample best class weights: mean distance ${f0.toFixed(3)} mm (unweighted) -> ${fb.toFixed(3)} mm;`, CLASSES.map((c, k) => `${c}=${wb[k]}`).join(' '));
const res = { classes: CLASSES, weightsAllBoards: all, inSample: { unweightedMeanMm: f0, bestMeanMm: fb, weights: wb }, rows };
if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(res, null, 1));
console.log('\nweights (all training boards):', CLASSES.map((c, k) => `${c}=${all[k]}`).join(' '));
console.log('\n| Board | Small parts (count) | Human centre reachable by some weighting (share) | Unweighted HPWL: distance of human to the optimum, median (mm) | Unweighted: human optimal (share) | Learned weights (leave one board out): distance, median (mm) | Learned: human optimal (share) | Learned: within 2 mm (share) | Tool start rule: distance to human, median (mm) | Start rule: within 2 mm (share) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.board}${testOnly.includes(r.board) ? ' (test only)' : ''} | ${r.parts} | ${r.inReach} | ${r.unweighted.med} | ${r.unweighted.opt} | ${r.learned.med} | ${r.learned.opt} | ${r.learned.within2} | ${r.rule.med} | ${r.rule.within2} |`);
