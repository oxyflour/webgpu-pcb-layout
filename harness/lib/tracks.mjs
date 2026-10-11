// Human routing of a registered KiCad board: track segments (and track arcs as chords) per
// problem net, in canvas coordinates, and a per-net graph (segment endpoints, T-junctions split,
// layers ignored: vias join layers at the same point) with the pads of the net attached.
import fs from 'node:fs';
import { worldPin } from './board.mjs';

import * as P from '../../core/src/problem.js';
const NUM = String.raw`(-?[\d.]+(?:e-?\d+)?)`;

export function loadTracks(b) {
  const text = fs.readFileSync(b.file, 'utf8'), o = b.a.origin;
  const names = new Map();
  // Net declarations (net N "name") / (net N name); pads repeat them, keep the first.
  for (const m of text.matchAll(/\(net (\d+) (?:"((?:[^"\\]|\\.)*)"|([^\s()"]+))\)/g)) if (!names.has(m[1])) names.set(m[1], m[2] ?? m[3]);
  const netIndex = new Map(b.p.nets.map((n, i) => [n.id, i]));
  const segs = b.p.nets.map(() => []);
  const add = (x1, y1, x2, y2, layer, net) => { const k = netIndex.get(names.get(net)); if (k !== undefined) segs[k].push([x1 - o.x, y1 - o.y, x2 - o.x, y2 - o.y, layer]); };
  for (const m of text.matchAll(new RegExp(String.raw`\(segment \(start ${NUM} ${NUM}\) \(end ${NUM} ${NUM}\) \(width ${NUM}\) \(layer "?([^")]+)"?\) \(net (\d+)\)`, 'g'))) add(+m[1], +m[2], +m[3], +m[4], m[6], m[7]);
  for (const m of text.matchAll(new RegExp(String.raw`\(arc \(start ${NUM} ${NUM}\) \(mid ${NUM} ${NUM}\) \(end ${NUM} ${NUM}\) \(width ${NUM}\) \(layer "?([^")]+)"?\) \(net (\d+)\)`, 'g'))) {
    add(+m[1], +m[2], +m[3], +m[4], m[8], m[9]); add(+m[3], +m[4], +m[5], +m[6], m[8], m[9]);
  }
  return segs;
}

// Pad boxes of the routing problem in layout L (same transform as the benchmark router).
export function padBoxes(b, L) {
  return b.a.routing.pads.map((pad) => {
    const pl = L[pad.comp], [rx, ry] = P.rotateQuarter(...P.localPin(pad.lx, pad.ly, pl.side), pl.rotation);
    const a = pad.rot * Math.PI / 180;
    let hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h), hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h);
    if (pl.rotation & 1) [hx, hy] = [hy, hx];
    return { comp: pad.comp, net: pad.net, x: pl.x + rx, y: pl.y + ry, hx, hy };
  });
}

// Graph of net k: nodes = points, adjacency with lengths; pad nodes 'p<padIndex>' joined at 0 mm
// to every track point inside the pad box (+0.05 mm). Returns { adj: Map(node -> [[node, mm]]), padNode }.
export function netGraph(segs, pads, k) {
  const S = segs[k].map((s) => [...s]), key = (x, y) => `${Math.round(x * 200)},${Math.round(y * 200)}`;
  // Split segments at endpoints of other segments lying on their interior (T-junctions).
  const pts = S.flatMap((s) => [[s[0], s[1]], [s[2], s[3]]]);
  const parts = [];
  for (const s of S) {
    const dx = s[2] - s[0], dy = s[3] - s[1], l2 = dx * dx + dy * dy, cut = [0, 1];
    if (l2 > 1e-9) for (const [x, y] of pts) { const t = ((x - s[0]) * dx + (y - s[1]) * dy) / l2; if (t > 1e-4 && t < 1 - 1e-4 && Math.hypot(s[0] + t * dx - x, s[1] + t * dy - y) < 0.005) cut.push(t); }
    cut.sort((a, c) => a - c);
    for (let q = 1; q < cut.length; q++) parts.push([s[0] + cut[q - 1] * dx, s[1] + cut[q - 1] * dy, s[0] + cut[q] * dx, s[1] + cut[q] * dy]);
  }
  const adj = new Map(), link = (a, c, w) => { if (!adj.has(a)) adj.set(a, []); if (!adj.has(c)) adj.set(c, []); adj.get(a).push([c, w]); adj.get(c).push([a, w]); };
  const xy = new Map();
  for (const [x1, y1, x2, y2] of parts) { const a = key(x1, y1), c = key(x2, y2); xy.set(a, [x1, y1]); xy.set(c, [x2, y2]); link(a, c, Math.hypot(x2 - x1, y2 - y1)); }
  const padNode = new Map();
  pads.forEach((pd, pi) => {
    if (pd.net !== k) return;
    const node = `p${pi}`; padNode.set(pi, node); if (!adj.has(node)) adj.set(node, []);
    for (const [nk, [x, y]] of xy) if (Math.abs(x - pd.x) <= pd.hx + 0.05 && Math.abs(y - pd.y) <= pd.hy + 0.05) link(node, nk, 0);
  });
  return { adj, padNode, xy };
}

// Dijkstra from a set of source nodes; returns Map(node -> [dist, prev]).
export function dijkstra(adj, sources) {
  const dist = new Map(), prev = new Map(), done = new Set(), q = [];
  for (const s of sources) { dist.set(s, 0); prev.set(s, null); q.push([0, s]); }
  while (q.length) {
    let bi = 0; for (let i = 1; i < q.length; i++) if (q[i][0] < q[bi][0]) bi = i;
    const [d, u] = q[bi]; q[bi] = q[q.length - 1]; q.pop();
    if (done.has(u)) continue; done.add(u);
    for (const [v, w] of adj.get(u) ?? []) if (!(dist.get(v) <= d + w)) { dist.set(v, d + w); prev.set(v, u); q.push([d + w, v]); }
  }
  return { dist, prev };
}
export const pinXY = (b, L, pi) => worldPin(b.p, L, pi);
