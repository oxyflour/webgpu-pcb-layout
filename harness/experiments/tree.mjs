// Attachment tree, key-information test without the agent (AGENTS.md). All levels get the human IC
// poses (what the agent plans), like experiments/modules.mjs.
//   ics          : tool init (pins-small), then global Cypress                       (current tool)
//   parent-human : every movable non-IC part (< 8 signal pins) starts at the pins of its human
//                  parent = the connected part with the shortest pin-to-pin distance in the human
//                  layout; its other links weigh 0.02 in the init
//   parent-human-w: + Cypress net weight W on the nets shared with the parent
//   prune-human  : links that are not edges of the human minimum spanning tree of the part graph
//                  (edge length = human pin-to-pin distance) pull --w (default 0.2) times as hard in
//                  the init; in Cypress nets with no tree edge get weight --w
// node harness/experiments/tree.mjs --board k60 --level parent-human --seed 1 --out DIR [--w 3] [--no-global]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, legalOk, needsFastRouting, exactRouting, worldPin } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';
import { buildModules } from '../lib/modules.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board'), level = arg('level', 'ics'), seed = Number(arg('seed', 1)), global = !argv.includes('--no-global'), W = Number(arg('w', arg('level') === 'prune-human' ? 0.2 : 3));
const out = path.resolve(arg('out', 'harness/results/tree')), boost = Number(arg('boost', 10));
const b = loadBoard(board), H = b.a.originalLayout, p = b.p, C = p.components, n = C.length;
const { modules } = buildModules(b);
const plan = {};
for (const ic of modules.keys()) plan[C[ic].id] = { x: H[ic].x, y: H[ic].y, rotation: H[ic].rotation };

// Signal pins per part and shortest human pin-to-pin distance per connected pair.
const sig = new Array(n).fill(0), dist = Array.from({ length: n }, () => new Map()), shared = Array.from({ length: n }, () => new Map());
for (const net of p.nets) {
  const ps = net.pins.map((pi) => [p.pins[pi].componentIndex, ...worldPin(p, H, pi)]);
  if (new Set(ps.map((x) => x[0])).size > 30) continue;
  for (const a of ps) { sig[a[0]]++; for (const c of ps) if (a[0] !== c[0]) {
    const v = Math.hypot(a[1] - c[1], a[2] - c[2]); if (!(dist[a[0]].get(c[0]) <= v)) dist[a[0]].set(c[0], v);
    if (!shared[a[0]].has(c[0])) shared[a[0]].set(c[0], new Set()); shared[a[0]].get(c[0]).add(net.id); } }
}
let parent = null, netWeights = {}, linkScale = null, treeEdges = null;
if (level === 'prune-human') {
  const edges = [];
  for (let i = 0; i < n; i++) for (const [j, v] of dist[i]) if (j > i) edges.push([v, i, j]);
  edges.sort((a, c) => a[0] - c[0]);
  const par = [...Array(n).keys()], find = (x) => par[x] === x ? x : (par[x] = find(par[x])), treeNets = new Set();
  treeEdges = new Set();
  for (const [, i, j] of edges) { const a = find(i), c = find(j); if (a !== c) { par[a] = c; treeEdges.add(i * 1e5 + j).add(j * 1e5 + i); for (const id of shared[i].get(j)) treeNets.add(id); } }
  linkScale = (i, j) => treeEdges.has(i * 1e5 + j) ? 1 : W;
  for (const net of p.nets) { const k = new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size; if (k >= 2 && k <= 30 && !treeNets.has(net.id)) netWeights[net.id] = W; }
}
if (level.startsWith('parent-human')) {
  parent = new Map();
  for (let i = 0; i < n; i++) {
    if (C[i].fixed || sig[i] >= 8 || !dist[i].size) continue;
    parent.set(i, [...dist[i]].reduce((a, c) => c[1] < a[1] ? c : a)[0]);
  }
  linkScale = (i, j) => parent.get(i) === j ? boost : 1;
  if (level === 'parent-human-w') for (const [i, j] of parent) for (const id of shared[i].get(j)) netWeights[id] = W;
}
const tag = `${board}-${level}${level.endsWith('-w') || treeEdges ? W : ''}${parent ? `-boost${boost}` : ''}${global ? '' : '-noglobal'}-${seed}`, dir = path.join(out, tag);
fs.mkdirSync(dir, { recursive: true });
const init = startLayout(b, plan, { seed, linkScale });
// Start-layout distance to the human pose of the parts with a parent / of all non-IC movable parts.
const movable = [...Array(n).keys()].filter((i) => !C[i].fixed && sig[i] < 8 && sig[i] > 0);
const med = (L) => { const d = movable.map((i) => Math.hypot(L[i].x - H[i].x, L[i].y - H[i].y)).sort((a, c) => a - c); return +d[d.length >> 1].toFixed(2); };
let L = init, cy = null;
if (global) {
  const r = await runCypress(b, { jobDir: path.join(dir, 'global'), seed: 1000 + seed, init, netWeights, budgetS: needsFastRouting(b) ? 80 : 150 });
  cy = { status: r.status, wallS: Math.round(r.wallS) };
  if (!r.layout) { console.log(JSON.stringify({ tag, error: r.status })); process.exit(1); }
  L = r.layout;
}
const leg = legalize(b, L);
fs.writeFileSync(path.join(dir, 'final-layout.json'), JSON.stringify(leg.layout));
const m = await evaluateRobust(b, leg.layout, exactRouting());
const row = { board, level, boost: parent ? boost : null, w: level.endsWith('-w') || treeEdges ? W : null, global, seed, parents: parent?.size ?? 0, weightedNets: Object.keys(netWeights).length,
  initToHumanMedMm: med(init), finalToHumanMedMm: med(leg.layout), cypress: cy, legalizerFailed: leg.failed,
  legal: legalOk(m), clean: m.clean, nets: m.nets, vias: m.vias, viaSites: m.viaSites, hpwlMm: m.hpwlMm, noise: m.noise, routeConverged: m.routeConverged };
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
