// Causality test for net crossings: greedy discrete moves on a legal layout that lower
//   cost = crossings of net spanning-tree segments + lambda * spanning-tree length (mm)
// Moves keep legality: 180 deg turn of a movable 2-pin part; swap of two movable parts with the
// same footprint size and side within --radius mm. Then legalize (sanity) and evaluate.
// node harness/experiments/uncross.mjs --board k60 --layout L.json --lambda 0.2 --out FILE [--save F] [--tag T]
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust, worldPin, rotatedSize } from '../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, n = C.length, lambda = Number(arg('lambda', 0.2)), radius = Number(arg('radius', 10)), passes = Number(arg('passes', 4));
const src = arg('layout'), L = src === 'human' ? legalize(b, b.a.originalLayout).layout : (() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return (j.layout ?? j).map((q) => ({ ...q })); })();
const nets = p.nets.map((net) => new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30 && net.pins.length >= 2 ? net.pins : null);
const netsOf = Array.from({ length: n }, () => new Set()); nets.forEach((ps, ni) => ps && ps.forEach((pi) => netsOf[p.pins[pi].componentIndex].add(ni)));
const netSegs = (ni) => { const ps = nets[ni], pts = ps.map((pi) => worldPin(p, L, pi)), inT = new Array(pts.length).fill(false), best = pts.map((q) => [Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]), 0]), out = [];
  inT[0] = true; for (let it = 1; it < pts.length; it++) { let u = -1; for (let k = 0; k < pts.length; k++) if (!inT[k] && (u < 0 || best[k][0] < best[u][0])) u = k;
    inT[u] = true; const a = pts[best[u][1]], c = pts[u]; out.push([a[0], a[1], c[0], c[1], Math.min(a[0], c[0]), Math.max(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[1], c[1])]);
    for (let k = 0; k < pts.length; k++) if (!inT[k]) { const d = Math.hypot(pts[k][0] - c[0], pts[k][1] - c[1]); if (d < best[k][0]) best[k] = [d, u]; } }
  return out; };
const segs = nets.map((ps, ni) => ps ? netSegs(ni) : []);
const o = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
const X = (s, t) => s[5] >= t[4] && t[5] >= s[4] && s[7] >= t[6] && t[7] >= s[6] && o(s[0], s[1], s[2], s[3], t[0], t[1]) * o(s[0], s[1], s[2], s[3], t[2], t[3]) < 0 && o(t[0], t[1], t[2], t[3], s[0], s[1]) * o(t[0], t[1], t[2], t[3], s[2], s[3]) < 0;
const len = (ni) => segs[ni].reduce((a, s) => a + Math.hypot(s[2] - s[0], s[3] - s[1]), 0);
// cost terms involving the net set A (pairs inside A counted once)
const local = (A) => { let x = 0, l = 0; for (const ni of A) { l += len(ni); for (const s of segs[ni]) for (let nj = 0; nj < segs.length; nj++) { if (nj === ni || (A.has(nj) && nj < ni)) continue; for (const t of segs[nj]) if (X(s, t)) x++; } } return { x, l, c: x + lambda * l }; };
const total = () => { let x = 0, l = 0; for (let ni = 0; ni < segs.length; ni++) { l += len(ni); for (const s of segs[ni]) for (let nj = ni + 1; nj < segs.length; nj++) for (const t of segs[nj]) if (X(s, t)) x++; } return { x, l: Math.round(l) }; };
const before = total();
const movable = [...Array(n).keys()].filter((i) => !C[i].fixed && netsOf[i].size);
const size = (i) => rotatedSize(C[i], L[i].rotation).map((v) => v.toFixed(3)).join('x');
const tryMove = (parts, apply, undo) => {
  const A = new Set(parts.flatMap((i) => [...netsOf[i]])), c0 = local(A).c, old = [...A].map((ni) => segs[ni]);
  apply(); for (const ni of A) segs[ni] = netSegs(ni);
  if (local(A).c < c0 - 1e-6) return true;
  undo(); [...A].forEach((ni, k) => segs[ni] = old[k]); return false;
};
let flips = 0, swaps = 0;
for (let pass = 0; pass < passes; pass++) {
  let changed = 0;
  for (const i of movable) if (C[i].pins.length === 2 && C[i].rotatable !== false) {
    const r = L[i].rotation; if (tryMove([i], () => L[i].rotation = (r + 2) % 4, () => L[i].rotation = r)) { flips++; changed++; }
  }
  for (const i of movable) for (const j of movable) {
    if (j <= i || C[i].sides !== C[j].sides || Math.hypot(L[i].x - L[j].x, L[i].y - L[j].y) > radius || size(i) !== size(j)) continue;
    const a = { ...L[i] }, c = { ...L[j] };
    // swap positions, each keeps its own rotation choice among the two that keep the footprint
    if (tryMove([i, j], () => { L[i] = { ...L[i], x: c.x, y: c.y }; L[j] = { ...L[j], x: a.x, y: a.y }; }, () => { L[i] = a; L[j] = c; })) { swaps++; changed++; }
  }
  if (!changed) break;
}
const after = total(), leg = legalize(b, L);
if (arg('save')) fs.writeFileSync(arg('save'), JSON.stringify(leg.layout));
const m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
const row = { board: b.name, layout: src, tag: arg('tag'), lambda, radius, flips, swaps, crossings: [before.x, after.x], mstMm: [before.l, after.l], legalizerMoved: leg.moved, clean: m.clean, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
