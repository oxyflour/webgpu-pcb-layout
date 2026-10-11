// Is the human placement tree-like? Part graph from signal nets (2..30 parts, clique per net),
// human poses from the KiCad file. Root = part with the most signal pins.
// node harness/experiments/tree-structure.mjs [board ...]
import { loadBoard, BOARDS } from '../../lib/board.mjs';
import { worldPin } from '../../lib/board.mjs';

// Edge length = shortest distance between two pins of the parts on a shared signal net (human pose).
const pinDistance = (p, H) => { const m = new Map();
  for (const net of p.nets) { const ps = net.pins.map((pi) => [p.pins[pi].componentIndex, ...worldPin(p, H, pi)]); if (new Set(ps.map((x) => x[0])).size > 30) continue;
    for (const a of ps) for (const c of ps) if (a[0] < c[0]) { const k = a[0] * 1e5 + c[0], v = Math.hypot(a[1] - c[1], a[2] - c[2]); if (!(m.get(k) <= v)) m.set(k, v); } }
  return (i, j) => m.get(Math.min(i, j) * 1e5 + Math.max(i, j)); };
const boards = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BOARDS);
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
const spearman = (xs, ys) => {
  const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(v.length); o.forEach(([, i], k) => r[i] = k); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length, mx = (n - 1) / 2;
  let a = 0, bx = 0, by = 0; for (let i = 0; i < n; i++) { a += (rx[i] - mx) * (ry[i] - mx); bx += (rx[i] - mx) ** 2; by += (ry[i] - mx) ** 2; }
  return a / Math.sqrt(bx * by);
};
const rows = [];
for (const name of boards) {
  const b = loadBoard(name), p = b.p, C = p.components, H = b.a.originalLayout, n = C.length;
  const sigPins = new Array(n).fill(0);
  const adj = Array.from({ length: n }, () => new Map());
  for (const net of p.nets) {
    const cs = [...new Set(net.pins.map((pi) => p.pins[pi].componentIndex))];
    if (cs.length < 2 || cs.length > 30) continue;
    for (const pi of net.pins) sigPins[p.pins[pi].componentIndex]++;
    for (const a of cs) for (const c of cs) if (a !== c) adj[a].set(c, (adj[a].get(c) ?? 0) + 1);
  }
  const d = pinDistance(p, H);
  const root = sigPins.indexOf(Math.max(...sigPins));
  // BFS from root: hop depth and BFS order.
  const depth = new Array(n).fill(-1), order = [root]; depth[root] = 0;
  for (let k = 0; k < order.length; k++) for (const j of adj[order[k]].keys()) if (depth[j] < 0) { depth[j] = depth[order[k]] + 1; order.push(j); }
  const reach = order.slice(1);
  // Graph shape on the reached component.
  const V = order.length, E = order.reduce((s, i) => s + adj[i].size, 0) / 2;
  // Earlier-neighbour count in BFS order: 1 = tree-like (one parent), >= 2 = closes a cycle.
  const pos = new Array(n).fill(-1); order.forEach((i, k) => pos[i] = k);
  const earlier = reach.map((i) => [...adj[i].keys()].filter((j) => pos[j] < pos[i]).length);
  // Human proximity: is the physically nearest graph neighbour one of the BFS parents (depth-1)?
  const small = reach.filter((i) => !C[i].fixed && sigPins[i] <= 4);
  const nearestIsParent = small.filter((i) => { const ns = [...adj[i].keys()]; const nn = ns.reduce((a, j) => d(i, j) < d(i, a) ? j : a); return depth[nn] === depth[i] - 1; }).length;
  // Pruned graph: keep only edges the human made short (centre distance <= T mm); its cycle rank.
  const pruned = (T) => { let e = 0; const par = order.map((_, k) => k), find = (x) => par[x] === x ? x : (par[x] = find(par[x])); let comps = V;
    for (const i of order) for (const j of adj[i].keys()) if (pos[j] > pos[i] && d(i, j) <= T) { e++; const a = find(pos[i]), c = find(pos[j]); if (a !== c) { par[a] = c; comps--; } }
    return { e, cyc: e - V + comps, comps }; };
  const p5 = pruned(5), p10 = pruned(10);
  // Human-length MST on the graph: share of all connections (edges) that are tree edges, and
  // how long non-tree edges are compared with tree edges.
  const edges = []; for (const i of order) for (const j of adj[i].keys()) if (pos[j] > pos[i]) edges.push([d(i, j), i, j]);
  edges.sort((a, c) => a[0] - c[0]);
  const par = new Map(order.map((i) => [i, i])), find = (x) => par.get(x) === x ? x : (par.set(x, find(par.get(x))), par.get(x));
  const tree = [], extra = [];
  for (const e of edges) { const a = find(e[1]), c = find(e[2]); if (a !== c) { par.set(a, c); tree.push(e[0]); } else extra.push(e[0]); }
  const corr = spearman(reach.map((i) => depth[i]), reach.map((i) => Math.hypot(H[i].x - H[root].x, H[i].y - H[root].y)));
  const hist = [1, 2, 3].map((k) => earlier.filter((x) => (k < 3 ? x === k : x >= 3)).length / earlier.length);
  rows.push({ board: name, parts: n, rootRef: C[root].id, rootPins: sigPins[root], reached: V, E, cycRank: E - V + 1,
    maxDepth: Math.max(...depth), depthHist: [1, 2, 3, 4].map((k) => depth.filter((x) => x === k).length).join('/'),
    earlier1: hist[0], earlier2: hist[1], earlier3p: hist[2],
    corrDepthDist: corr, nearestIsParent: nearestIsParent / small.length, smallN: small.length,
    cyc5: p5.cyc, comps5: p5.comps, cyc10: p10.cyc, comps10: p10.comps,
    mstMed: q(tree, 0.5), extraMed: q(extra, 0.5), extraShort5: extra.filter((x) => x <= 5).length / Math.max(1, extra.length) });
}
const f = (x) => typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(2) : x;
console.log(Object.keys(rows[0]).join('\t'));
for (const r of rows) console.log(Object.values(r).map(f).join('\t'));
console.log(JSON.stringify(rows));
