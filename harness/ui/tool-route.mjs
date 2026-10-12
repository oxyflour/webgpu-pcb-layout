// Routing of the editor's layout under the evaluation protocol (experiments/sweep-eval.mjs): the layout
// is legalized (0.1 mm, as every scored candidate; asIs: the file's own layout, routed unchanged like
// the human layout), then routed per grid phase and the median taken.
// Boards <= 1000 parts: exact native routing at the 8 sweep offsets (why-stable.mjs); larger boards:
// the tool routing at 3 phases (sweep-eval-big.mjs). The tracks drawn are those of the median-vias
// phase (as evaluateRobust), moved back by its grid offset. Run by server.mjs in a child process.
//   node harness/ui/tool-route.mjs <request.json>   request {name, text, layout, asIs}; prints the result JSON
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { legalize, needsFastRouting, toolRouting, exactRouting } from '../lib/board.mjs';
import { editorBoard } from './editor-board.mjs';

const OFFSETS = ['0,0', '0.05,0.31', '0.13,0.07', '0.21,0.26', '0.29,0.14', '0.37,0.33', '0.09,0.19', '0.25,0.02'].map((o) => o.split(',').map(Number));
const { name, text, layout, asIs = false } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t0 = performance.now(), { b } = editorBoard(name, text);
const leg = asIs ? { layout, failed: 0 } : legalize(b, layout), L = leg.layout;
const moved = L.filter((p, i) => Math.hypot(p.x - layout[i].x, p.y - layout[i].y) > 1e-6 || p.rotation !== layout[i].rotation).length;
const big = needsFastRouting(b), base = big ? toolRouting(b) : exactRouting();
const offsets = big ? [0, 1, 2].map((k) => [k * 0.4 / 3, k * 0.4 / 3]) : OFFSETS;
const runs = await Promise.all(offsets.map((offset) => new Promise((resolve, reject) => {
  const w = new Worker(new URL('./tool-route-phase.mjs', import.meta.url), { workerData: { name, text, layout: L, opts: { ...base, offset } } });
  w.once('message', (m) => resolve({ ...m, offset })); w.once('error', reject);
})));
const med = (k) => { const v = runs.map((m) => m[k]).sort((x, y) => x - y); return v[(v.length - 1) >> 1]; };
const span = (k) => [Math.min(...runs.map((m) => m[k])), Math.max(...runs.map((m) => m[k]))];
const rep = [...runs].sort((x, y) => x.vias - y.vias)[(runs.length - 1) >> 1];

// Tracks of the representative phase per layer as flat coordinates (polyline k of layer l spans
// points starts[k] .. starts[k+1]-1, net nets[k]), vias as x, y pairs; the page's drawing format.
const { W, H, cell, layers: NL } = rep.grid, P = W * H, [dx, dy] = rep.offset;
const xy = (q) => [(q % W + 0.5) * cell - dx, (Math.floor(q / W) + 0.5) * cell - dy];
const perLayer = Array.from({ length: NL }, () => ({ coords: [], starts: [], nets: [] })), vias = [];
for (const [n, path] of rep.paths ?? []) {
  let cur = null;
  const flush = () => { if (cur && cur.pts.length > 1) { const T = perLayer[cur.l]; T.starts.push(T.coords.length / 2); T.nets.push(n); for (const q of cur.pts) T.coords.push(...xy(q)); } };
  for (let k = 0; k < path.length; k++) {
    const l = Math.floor(path[k] / P), q = path[k] % P;
    if (!cur || cur.l !== l) { flush(); if (cur) vias.push(...xy(q)); cur = { l, pts: [q] }; } else cur.pts.push(q);
  }
  flush();
}
const complete = rep.status.filter((s) => s === 1 || s === 2).length;
process.stdout.write(JSON.stringify({
  ms: Math.round(performance.now() - t0),
  stats: { nets: rep.nets, clean: med('clean'), vias: med('vias'), length: med('routedLengthMm'), complete, layers: NL, cell, rounds: rep.routeRounds, converged: runs.filter((m) => m.routeConverged).length },
  protocol: { phases: runs.length, routing: rep.routing, noise: { clean: span('clean'), vias: span('vias') }, representative: { clean: rep.clean, vias: rep.vias, offset: rep.offset }, legalizeMoved: moved, asIs, legalFailed: leg.failed },
  layers: perLayer.map((T) => ({ coords: T.coords.map((v) => Math.round(v * 1000) / 1000), starts: [...T.starts, T.coords.length / 2], nets: T.nets })),
  vias: vias.map((v) => Math.round(v * 1000) / 1000), status: rep.status,
}));
