// Why does the human layout route the same at every grid phase? Per layout and grid offset:
//   convergence: rounds until overflow 0 (or none), overflow after round 1 and at the end;
//   pitch sweep: route at another grid pitch (less / more capacity) and see if the spread appears;
//   pin access: pads whose cells have no free same-layer neighbour cell (enclosed by other owners).
// node harness/experiments/why-stable.mjs --board k60 --layout human|FILE --pitch 0.4 --offset dx,dy
import fs from 'node:fs';
import { loadBoard, legalize, placementMetrics } from '../lib/board.mjs';
import { routeBoard, evaluationRouting } from '../lib/router-gen.mjs';
import { routeBoardNative } from '../lib/native-router.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), src = arg('layout', 'human'), pitch = Number(arg('pitch', 0.4));
const [dx, dy] = arg('offset', '0,0').split(',').map(Number);
let L = src === 'human' ? b.a.originalLayout.map((l) => ({ ...l })) : (() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return legalize(b, Array.isArray(j) ? j : j.layout).layout; })();
const r = b.a.routing, mv = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
const board = { ...r, pitch, canvas: { ...r.canvas, width: r.canvas.width + Math.max(dx, dy), height: r.canvas.height + Math.max(dx, dy) }, outline: r.outline?.map((o) => ({ ...o, outer: mv(o.outer), ...(o.holes ? { holes: o.holes.map(mv) } : {}) })) };
L = L.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
const opts = evaluationRouting(board);
// Pin access from the rasterization.
const R = routeBoard(board, L, b.a.sides, { ...opts, rasterOnly: true });
const { grid: { W, H, L: NL, P }, owner, padCells } = R;
let enclosed = 0, tight = 0;
for (const cells of padCells) {
  const own = owner[cells[0]], free = new Set();
  for (const c of cells) { const l = Math.floor(c / P), q = c - l * P, x = q % W, y = (q / W) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) { if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = l * P + ny * W + nx; if (owner[n] === -1) free.add(n); } }
  if (free.size === 0) enclosed++; else if (free.size <= 1) tight++;
}
const log = [];
const m = routeBoardNative(board, L, b.a.sides, { ...opts, onRound: (x) => log.push(x.overflow) });
const zero = log.indexOf(0);
console.log(JSON.stringify({ board: b.name, file: src, hpwlMm: placementMetrics(b, L).hpwlMm, layout: src.replace(/.*[\/]/, ''), pitch, offset: [dx, dy], clean: m.clean, nets: m.nets, vias: m.vias, rounds: m.rounds, zeroAtRound: zero < 0 ? null : zero + 1, overflowR1: log[0], overflowR5: log[4] ?? 0, overflowEnd: log.at(-1), pads: padCells.length, enclosedPads: enclosed, tightPads: tight }));
