// Start from the human layout and see where the tool's algorithms move it.
//   legal   : shared legalizer only (the human layout has overlaps)
//   cypress : harness Cypress pass warm-started from the human layout, legalizer
//   cyp-bench : Cypress with the benchmark config (1000 iterations, lr 0.01), legalizer
//   uncross : legal + experiments/uncross.mjs moves (run that script on the saved layout)
//   loo     : every small part (movable, < 8 pins) re-placed by the tool init rule with ALL other
//             parts at their human pose (one startLayout call per part), then all re-placed parts
//             combined, legalized
//   loo-rot : loo positions, human rotations
//   loo-slot: loo position and rotation, then the nearest spot (0.1 mm steps, spiral) where the part
//             fits among all other parts at their legalized human poses; parts combined, legalized
//   loo-slot-rot : loo-slot with the human rotation
// Reports the drift of small parts from the human pose (median / p90, mm), rotation changes and
// the routing metrics (5 grid phases, native exact).
// node harness/experiments/from-human.mjs --board k60 --level loo --seed 1 --out FILE
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, needsFastRouting, rotatedSize } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board'), level = arg('level', 'legal'), seed = Number(arg('seed', 1));
const b = loadBoard(board), C = b.p.components, H = b.a.originalLayout, n = C.length;
const small = [...Array(n).keys()].filter((i) => !C[i].fixed && C[i].pins.length < 8);
const pose = (q) => ({ x: q.x, y: q.y, rotation: q.rotation });
const dir = path.resolve(`harness/results/from-human/${board}-${level}-${seed}`); fs.mkdirSync(dir, { recursive: true });
let L = H.map((q) => ({ ...q })), cy = null;
if (level === 'cypress' || level === 'cyp-bench') {
  const knobs = level === 'cyp-bench' ? { iterations: 1000, learning_rate: 0.01 } : {};
  const r = await runCypress(b, { jobDir: path.join(dir, 'cypress'), seed: 1000 + seed, init: H, knobs, budgetS: needsFastRouting(b) ? 80 : 150 });
  cy = r.status; if (!r.layout) throw new Error(r.status); L = r.layout;
}
if (level.startsWith('loo')) {
  const HL = legalize(b, H).layout, box = (i, q) => { const [w, h] = rotatedSize(C[i], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
  const shares = (i, j, qi) => C[i].twoSided || C[j].twoSided || qi.side === HL[j].side;
  const fits = (i, q) => { const a = box(i, q); if (a[0] < 0 || a[1] < 0 || a[2] > b.p.canvas.width || a[3] > b.p.canvas.height) return false;
    for (let j = 0; j < n; j++) { if (j === i || !shares(i, j, q)) continue; const c = box(j, HL[j]); if (a[0] < c[2] + 0.1 && c[0] < a[2] + 0.1 && a[1] < c[3] + 0.1 && c[1] < a[3] + 0.1) return false; } return true; };
  globalThis.slot = (i, q) => { for (let r = 0; r <= 150; r++) { const pts = r ? Array.from({ length: 8 * r }, (_, k) => { const a = (k / (8 * r)) * 2 * Math.PI; return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))]; }) : [[0, 0]];
    for (const [dx, dy] of pts) { const c = { ...q, x: q.x + dx * 0.1, y: q.y + dy * 0.1 }; if (fits(i, c)) return c; } } return q; };
}
if (level === 'loo' || level === 'loo-rot' || level.startsWith('loo-slot')) {
  // Plan = every movable part at its human pose except part i; read part i from the start layout.
  const all = Object.fromEntries(C.map((c, i) => [c.id, pose(H[i])]).filter(([, q], i) => !C[i].fixed));
  for (const i of small) {
    const plan = { ...all }; delete plan[C[i].id];
    const S = startLayout(b, plan, { seed, jitterMm: 0 });
    L[i] = { ...S[i], ...(level.endsWith('-rot') ? { rotation: H[i].rotation } : {}) };
    if (level.startsWith('loo-slot')) L[i] = globalThis.slot(i, L[i]);
  }
}
const leg = legalize(b, L);
fs.writeFileSync(path.join(dir, 'final-layout.json'), JSON.stringify(leg.layout));
const d = small.map((i) => Math.hypot(leg.layout[i].x - H[i].x, leg.layout[i].y - H[i].y)).sort((a, c) => a - c), qq = (f) => +d[Math.floor(f * (d.length - 1))].toFixed(2);
const m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
const row = { board, level, seed, cypress: cy, smallDriftMm: { p50: qq(0.5), p90: qq(0.9) }, within1mm: +(d.filter((x) => x <= 1).length / d.length).toFixed(2),
  rotationsChanged: small.filter((i) => leg.layout[i].rotation !== H[i].rotation).length, smallParts: small.length,
  clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
