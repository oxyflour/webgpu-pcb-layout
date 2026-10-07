// Runtime copy of the adapter's src/router/board-router.js with small hooks, so the other
// repository is not modified. Generated under harness/results/.cache on first import.
//   options.deadline (performance.now() ms): stop after the round that passes it.
//   options.sharedUsage / options.sharedHistory: use these typed arrays (SharedArrayBuffer).
//   options.onWindow(win): called with every A* search window [x0, y0, x1, y1] (cells).
//   options.exposeRouter: return the router internals instead of running the rounds.
//   options.astarWeight: weighted A* (heuristic x w); 1 keeps the original search bit for bit
//   (even reassociating ng + h changed ppc-n3 from 8802 to 8739 vias: the router is chaotic).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAYOUT_ROOT, HARNESS_ROOT } from './env.mjs';

function patch(text, find, replace) {
  if (!text.includes(find)) throw new Error(`board-router.js changed: hook point not found: ${find.slice(0, 60)}`);
  return text.replace(find, replace);
}

export function generateRouter() {
  const src = path.join(LAYOUT_ROOT, 'src/router/board-router.js');
  let t = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  t = t.replace(/from '(\.\.?\/[^']+)'/g, (_, rel) => `from '${pathToFileURL(path.resolve(path.dirname(src), rel)).href}'`);
  t = patch(t, '    options.onRound?.({ round: rounds, maxRounds, overflow });\n',
    '    options.onRound?.({ round: rounds, maxRounds, overflow });\n    if (options.deadline && performance.now() > options.deadline) break;\n');
  t = patch(t, 'const usage = new Uint16Array(N), history = new Float32Array(N);',
    'const usage = options.sharedUsage ?? new Uint16Array(N), history = options.sharedHistory ?? new Float32Array(N);');
  t = patch(t, '    curGen++;\n', '    curGen++;\n    options.onWindow?.(win);\n');
  t = patch(t, 'heap.push(Math.abs(q % W - tx) + Math.abs(((q / W) | 0) - ty), s);', 'heap.push(AW * (Math.abs(q % W - tx) + Math.abs(((q / W) | 0) - ty)), s);');
  t = patch(t, 'heap.push(ng + Math.abs(nx[j] - tx) + Math.abs(ny[j] - ty), n);', 'heap.push(AW === 1 ? ng + Math.abs(nx[j] - tx) + Math.abs(ny[j] - ty) : ng + AW * (Math.abs(nx[j] - tx) + Math.abs(ny[j] - ty)), n);');
  t = patch(t, '  const heap = new MinHeap(1 << 16);\n', '  const heap = new MinHeap(1 << 16);\n  const AW = options.astarWeight ?? 1;\n');
  t = patch(t, '  const routes = new Array(board.netCount).fill(null);\n',
    '  if (options.exposeRouter) return { routeNet, usage, history, setPres: (v) => { pres = v; }, pres, presentGrowth, historyGain, grid: { W, H, L, P, N, cell }, netPads, padCenter, netBlock, netVia, margin };\n  const routes = new Array(board.netCount).fill(null);\n');
  // viaSites: physical vias (a run of consecutive layer changes at one cell = one via); `vias` keeps
  // counting every adjacent-layer step (on 10-layer ppc a through via counts up to 9).
  t = patch(t, '  let clean = 0, complete = 0, vias = 0, length = 0;\n', '  let clean = 0, complete = 0, vias = 0, length = 0, viaSites = 0;\n');
  t = patch(t, '        vias++;\n', '        vias++;\n        if (!(k > 1 && Math.abs(path[k - 1] - path[k - 2]) === P)) viaSites++;\n');
  t = patch(t, 'nets: order.length, complete, clean, vias, length, status,', 'nets: order.length, complete, clean, vias, viaSites, length, status,');
  const out = path.join(HARNESS_ROOT, 'results', '.cache', 'board-router-hooks.mjs');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== t) fs.writeFileSync(out, t);
  return pathToFileURL(out).href;
}

export const routerUrl = generateRouter();
export const { routeBoard, evaluationRouting } = await import(routerUrl);
