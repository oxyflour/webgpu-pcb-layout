// Measurement noise of the evaluation router: route the SAME layout under perturbations that do not
// change the layout in any physically meaningful way, and report the spread of clean nets / vias.
//   --perturb shift   : translate the whole board (outline, every part) by (s, s/2) mm, i.e. move the
//                       0.4 mm routing grid's phase; s = seed * 0.05 mm (seed 0 = unshifted)
//   --perturb jitter  : move every movable part by a uniform random offset in [-a, a] mm (a = --amp)
// One row (JSON) per call appended to --out.
// node harness/experiments/router-noise.mjs --board k60 --layout human|legal|FILE --perturb shift --seed 3 --mode full|fast --out FILE
import fs from 'node:fs';
import { loadBoard, evaluate, legalize } from '../../lib/board.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board'), src = arg('layout', 'human'), perturb = arg('perturb', 'shift'), seed = Number(arg('seed', 0));
const amp = Number(arg('amp', 0.01)), mode = arg('mode', 'full'), out = arg('out');
const b = loadBoard(board);
let L = src === 'human' || src === 'legal' ? b.a.originalLayout.map((l) => ({ ...l })) : JSON.parse(fs.readFileSync(src, 'utf8'));
if (src === 'legal') L = legalize(b, L).layout;

function rng(s) { let x = (s * 2654435761) >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
if (perturb === 'shift' && seed) {
  const dx = seed * 0.05, dy = seed * 0.025, mv = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
  const r = b.a.routing;
  r.canvas = { ...r.canvas, width: r.canvas.width + dx, height: r.canvas.height + dy };
  r.outline = r.outline?.map((o) => ({ ...o, outer: mv(o.outer), ...(o.holes ? { holes: o.holes.map(mv) } : {}) }));
  if (r.blocked?.length) throw new Error('shift: blocked areas not handled');
  L = L.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));
}
if (perturb === 'jitter' && seed) {
  const R = rng(seed);
  L = L.map((l, i) => b.p.components[i].fixed ? l : { ...l, x: l.x + (2 * R() - 1) * amp, y: l.y + (2 * R() - 1) * amp });
}
const t = performance.now();
const m = evaluate(b, L, { fast: mode === 'fast' });
const row = { board, layout: src, perturb, seed, amp: perturb === 'jitter' ? amp : undefined, mode, clean: m.clean, nets: m.nets, vias: m.vias, routedLengthMm: m.routedLengthMm, rounds: m.routeRounds, converged: m.routeConverged, s: Math.round((performance.now() - t) / 100) / 10 };
fs.appendFileSync(out, JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
