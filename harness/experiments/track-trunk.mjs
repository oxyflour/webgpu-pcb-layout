// Do small parts sit on the routes of their nets (human routing from the KiCad tracks)?
// Small part = movable, < 8 signal pins. Two kinds:
//  (a) part pad q on a net with >= 2 other pads O: trunk = union of the track paths joining O;
//      stub = track distance q -> trunk; near = straight distance q -> nearest pad of O.
//      onTrunk = stub < 0.5 x near. Straight-line version (human AND a tool layout, no tracks):
//      lineStub = distance q -> straight spanning tree of O.
//  (b) series part: exactly 2 signal pads, each on a net with exactly one other pad (P, D):
//      detour = (track P->q1 + track q2->D) / |P - D|_1 ; straight version (|P q1| + |q2 D|) / |P D|_1.
// node harness/experiments/track-trunk.mjs --board k60 [--tool L.json]
import fs from 'node:fs';
import { loadBoard } from '../lib/board.mjs';
import { loadTracks, padBoxes, netGraph, dijkstra } from '../lib/tracks.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, H = b.a.originalLayout;
const tool = arg('tool') ? (() => { const j = JSON.parse(fs.readFileSync(arg('tool'), 'utf8')); return j.layout ?? j; })() : null;
const segs = loadTracks(b), padsH = padBoxes(b, H), padsT = tool ? padBoxes(b, tool) : null;
const sig = new Array(C.length).fill(0), netParts = p.nets.map((n) => new Set(n.pins.map((pi) => p.pins[pi].componentIndex)));
p.nets.forEach((n, k) => { if (netParts[k].size >= 2 && netParts[k].size <= 30) for (const pi of n.pins) sig[p.pins[pi].componentIndex]++; });
const small = (i) => !C[i].fixed && sig[i] > 0 && sig[i] < 8;
const padsOfNet = new Map(); b.a.routing.pads.forEach((pd, pi) => { if (pd.net >= 0) { if (!padsOfNet.has(pd.net)) padsOfNet.set(pd.net, []); padsOfNet.get(pd.net).push(pi); } });
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
const segDist = (x, y, a, c) => { const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy || 1e-12, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)); return Math.hypot(a.x + t * dx - x, a.y + t * dy - y); };
const mstLines = (pts) => { const inT = [0], out = [], rest = pts.map((_, k) => k).slice(1);
  while (rest.length) { let bi = -1, bj = -1, bd = Infinity; for (const k of rest) for (const j of inT) { const d = Math.abs(pts[k].x - pts[j].x) + Math.abs(pts[k].y - pts[j].y); if (d < bd) { bd = d; bi = k; bj = j; } }
    out.push([pts[bj], pts[bi]]); inT.push(bi); rest.splice(rest.indexOf(bi), 1); } return out; };
const A = { stub: [], near: [], onTrunk: 0, n: 0, lineH: [], lineT: [], onLineH: 0, onLineT: 0 }, B = { track: [], lineH: [], lineT: [] };
const graphs = new Map(), graph = (k) => { if (!graphs.has(k)) graphs.set(k, netGraph(segs, padsH, k)); return graphs.get(k); };
for (let i = 0; i < C.length; i++) {
  if (!small(i)) continue;
  const myPads = [...padsOfNet.entries()].flatMap(([k, list]) => list.filter((pi) => padsH[pi].comp === i).map((pi) => [k, pi])).filter(([k]) => netParts[k].size <= 30);
  for (const [k, pq] of myPads) {
    const O = padsOfNet.get(k).filter((pi) => padsH[pi].comp !== i);
    if (O.length < 2) continue;
    const g = graph(k), on = (pi) => g.padNode.get(pi);
    // trunk: track paths from O[0] to every other pad of O
    const { dist, prev } = dijkstra(g.adj, [on(O[0])]);
    if (!O.every((pi) => dist.has(on(pi))) || !dist.has(on(pq))) continue;
    const trunk = new Set();
    for (const pi of O) for (let u = on(pi); u != null; u = prev.get(u)) trunk.add(u);
    const st = dijkstra(g.adj, [...trunk]).dist.get(on(pq));
    const near = Math.min(...O.map((pi) => Math.hypot(padsH[pi].x - padsH[pq].x, padsH[pi].y - padsH[pq].y)));
    A.n++; A.stub.push(st); A.near.push(near); if (st < 0.5 * near) A.onTrunk++;
    for (const [pads, key, cnt] of [[padsH, 'lineH', 'onLineH'], ...(padsT ? [[padsT, 'lineT', 'onLineT']] : [])]) {
      const pts = O.map((pi) => pads[pi]), lines = mstLines(pts), d = Math.min(...lines.map(([a, c]) => segDist(pads[pq].x, pads[pq].y, a, c)));
      const nr = Math.min(...pts.map((a) => Math.hypot(a.x - pads[pq].x, a.y - pads[pq].y)));
      A[key].push(d / Math.max(nr, 1e-6)); if (d < 0.5 * nr) A[cnt]++;
    }
  }
  // (b) series part
  if (myPads.length === 2 && myPads.every(([k]) => padsOfNet.get(k).filter((pi) => padsH[pi].comp !== i).length === 1)) {
    const [[k1, q1], [k2, q2]] = myPads, P0 = padsOfNet.get(k1).find((pi) => padsH[pi].comp !== i), D0 = padsOfNet.get(k2).find((pi) => padsH[pi].comp !== i);
    const g1 = graph(k1), g2 = graph(k2), t1 = dijkstra(g1.adj, [g1.padNode.get(P0)]).dist.get(g1.padNode.get(q1)), t2 = dijkstra(g2.adj, [g2.padNode.get(D0)]).dist.get(g2.padNode.get(q2));
    const l1 = (pads) => Math.abs(pads[P0].x - pads[D0].x) + Math.abs(pads[P0].y - pads[D0].y);
    const st = (pads) => (Math.hypot(pads[P0].x - pads[q1].x, pads[P0].y - pads[q1].y) + Math.hypot(pads[D0].x - pads[q2].x, pads[D0].y - pads[q2].y)) / l1(pads);
    if (t1 != null && t2 != null && l1(padsH) > 1) B.track.push((t1 + t2) / l1(padsH));
    if (l1(padsH) > 1) { B.lineH.push(st(padsH)); if (padsT) B.lineT.push(st(padsT)); }
  }
}
const f = (x) => x.toFixed(2);
console.log(JSON.stringify({ board: b.name,
  a: { parts: A.n, stubP50Mm: f(q(A.stub, .5)), nearP50Mm: f(q(A.near, .5)), onTrunkShare: f(A.onTrunk / A.n), lineRatioHumanP50: f(q(A.lineH, .5)), onLineHumanShare: f(A.onLineH / A.lineH.length), ...(padsT ? { lineRatioToolP50: f(q(A.lineT, .5)), onLineToolShare: f(A.onLineT / A.lineT.length) } : {}) },
  b: { series: B.lineH.length, trackDetourP50: f(q(B.track, .5)), straightDetourHumanP50: f(q(B.lineH, .5)), straightDetourHumanP90: f(q(B.lineH, .9)), ...(padsT ? { straightDetourToolP50: f(q(B.lineT, .5)), straightDetourToolP90: f(q(B.lineT, .9)) } : {}) } }));
