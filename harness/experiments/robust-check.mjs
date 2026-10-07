// Does the median over grid phases (evaluateRobust) reduce measurement noise? Score the same layout
// under 0.01 mm jitter seeds with a single routing and with the median of `shifts` phases.
// node harness/experiments/robust-check.mjs --board k60 --layout FILE|human [--seeds 8] [--shifts 3] [--fast]
import fs from 'node:fs';
import { loadBoard, evaluate, evaluateRobust } from '../lib/board.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), src = arg('layout', 'human'), seeds = Number(arg('seeds', 8)), shifts = Number(arg('shifts', 3)), fast = argv.includes('--fast');
const L0 = src === 'human' ? b.a.originalLayout : JSON.parse(fs.readFileSync(src, 'utf8'));
const jitter = (seed) => { let x = (seed * 2654435761) >>> 0 || 1; const R = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; return L0.map((l, i) => b.p.components[i].fixed ? l : { ...l, x: l.x + (2 * R() - 1) * 0.01, y: l.y + (2 * R() - 1) * 0.01 }); };
const single = [], robust = [];
for (let s = 1; s <= seeds; s++) {
  const L = jitter(s), a = evaluate(b, L, { fast }), r = await evaluateRobust(b, L, { shifts, fast });
  single.push(a); robust.push(r);
}
const sd = (v) => { const m = v.reduce((x, y) => x + y, 0) / v.length; return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / (v.length - 1)); };
const rng = (v) => `${Math.min(...v)}-${Math.max(...v)}`;
const row = { board: b.name, layout: src, seeds, shifts, fast,
  single: { clean: rng(single.map((m) => m.clean)), cleanSd: +sd(single.map((m) => m.clean)).toFixed(1), vias: rng(single.map((m) => m.vias)), viasSd: +sd(single.map((m) => m.vias)).toFixed(1) },
  median: { clean: rng(robust.map((m) => m.clean)), cleanSd: +sd(robust.map((m) => m.clean)).toFixed(1), vias: rng(robust.map((m) => m.vias)), viasSd: +sd(robust.map((m) => m.vias)).toFixed(1) } };
console.log(JSON.stringify(row));
