// Clusters of the human short-edge graph (signal part graph keeping edges with centre distance
// <= T mm): IC content per cluster, cycle rank inside clusters, and the cluster graph (clusters
// joined by the remaining long edges) cycle rank. IC = >= 8 signal pins.
// node harness/experiments/tree-clusters.mjs [--T 5] [board ...]
import { loadBoard, BOARDS } from '../../lib/board.mjs';
import { worldPin } from '../../lib/board.mjs';
const argv = process.argv.slice(2), ti = argv.indexOf('--T'), T = ti < 0 ? 5 : Number(argv[ti + 1]);
// Edge length = shortest distance between two pins of the parts on a shared signal net (human pose).
const pinDistance = (p, H) => { const m = new Map();
  for (const net of p.nets) { const ps = net.pins.map((pi) => [p.pins[pi].componentIndex, ...worldPin(p, H, pi)]); if (new Set(ps.map((x) => x[0])).size > 30) continue;
    for (const a of ps) for (const c of ps) if (a[0] < c[0]) { const k = a[0] * 1e5 + c[0], v = Math.hypot(a[1] - c[1], a[2] - c[2]); if (!(m.get(k) <= v)) m.set(k, v); } }
  return (i, j) => m.get(Math.min(i, j) * 1e5 + Math.max(i, j)); };
const boards = argv.filter((a, k) => a !== '--T' && k !== ti + 1);
console.log(['board', 'T(mm)', 'parts in graph', 'clusters(>=2 parts)', 'singletons', 'clusters with 0 IC', '1 IC', '>=2 IC', 'parts in 1-IC clusters (share)', 'cycle rank inside clusters', 'short edges', 'cluster graph: nodes', 'edges', 'cycle rank'].join('\t'));
for (const name of boards.length ? boards : Object.keys(BOARDS)) {
  const b = loadBoard(name), p = b.p, n = p.components.length, H = b.a.originalLayout;
  const sig = new Array(n).fill(0), adj = Array.from({ length: n }, () => new Set());
  for (const net of p.nets) { const cs = [...new Set(net.pins.map((pi) => p.pins[pi].componentIndex))]; if (cs.length < 2 || cs.length > 30) continue;
    for (const pi of net.pins) sig[p.pins[pi].componentIndex]++; for (const a of cs) for (const c of cs) if (a !== c) adj[a].add(c); }
  const inG = [...Array(n).keys()].filter((i) => adj[i].size), d = pinDistance(p, H);
  const par = [...Array(n).keys()], find = (x) => par[x] === x ? x : (par[x] = find(par[x]));
  let short = 0; const long = [];
  for (const i of inG) for (const j of adj[i]) if (j > i) { if (d(i, j) <= T) { short++; par[find(i)] = find(j); } else long.push([i, j]); }
  const cl = new Map(); for (const i of inG) { const r = find(i); if (!cl.has(r)) cl.set(r, []); cl.get(r).push(i); }
  const big = [...cl.values()].filter((m) => m.length >= 2), ics = (m) => m.filter((i) => sig[i] >= 8).length;
  const cyc = short - inG.length + cl.size;
  const ce = new Set(long.map(([i, j]) => [find(i), find(j)].sort().join()).filter((k) => { const [a, c] = k.split(','); return a !== c; }));
  const cpar = new Map([...cl.keys()].map((k) => [k, k])), cf = (x) => cpar.get(x) === x ? x : (cpar.set(x, cf(cpar.get(x))), cpar.get(x)); let cc = cl.size;
  for (const k of ce) { const [a, c] = k.split(',').map(Number); const x = cf(a), y = cf(c); if (x !== y) { cpar.set(x, y); cc--; } }
  console.log([name, T, inG.length, big.length, cl.size - big.length, big.filter((m) => !ics(m)).length, big.filter((m) => ics(m) === 1).length, big.filter((m) => ics(m) >= 2).length,
    (big.filter((m) => ics(m) === 1).reduce((s, m) => s + m.length, 0) / inG.length).toFixed(2), cyc, short, cl.size, ce.size, ce.size - cl.size + cc].join('\t'));
}
