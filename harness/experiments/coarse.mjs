// Coarse-vs-fine key information and Cypress spreading. Human IC poses for all levels.
//   --noise S : small parts (movable, < 8 pins) planned at their human position + uniform noise
//               in [-S, S] mm (omit = tool init for them); --rot human|init: their rotation
//   --knobs '{"target_density":0.5}' : Cypress knobs on top of the harness defaults
//   --no-global : start layout -> legalizer only
// node harness/experiments/coarse.mjs --board k60 --seed 1 --out DIR [--noise 5 --rot human] [--knobs JSON] [--no-global]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, needsFastRouting, rotatedSize } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';
import { buildModules } from '../lib/modules.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board'), seed = Number(arg('seed', 1)), global = !argv.includes('--no-global'), noise = arg('noise'), rot = arg('rot', 'human'), knobs = JSON.parse(arg('knobs', '{}'));
const out = path.resolve(arg('out', 'harness/results/coarse'));
const b = loadBoard(board), H = b.a.originalLayout, C = b.p.components;
const { modules } = buildModules(b);
const plan = {};
for (const ic of modules.keys()) plan[C[ic].id] = { x: H[ic].x, y: H[ic].y, rotation: H[ic].rotation };
let s = seed * 2654435761 >>> 0; const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
const small = (i) => !C[i].fixed && C[i].pins.length < 8;
if (noise != null) {
  const S = Number(noise), base = rot === 'init' ? startLayout(b, plan, { seed }) : null;
  C.forEach((c, i) => { if (small(i)) plan[c.id] = { x: H[i].x + (rnd() * 2 - 1) * S, y: H[i].y + (rnd() * 2 - 1) * S, rotation: base ? base[i].rotation : H[i].rotation }; });
}
const tag = `${board}${noise != null ? `-noise${noise}-${rot}` : '-ics'}${Object.entries(knobs).map(([k, v]) => `-${k}${v}`).join('')}${global ? '' : '-noglobal'}-${seed}`, dir = path.join(out, tag);
fs.mkdirSync(dir, { recursive: true });
const init = startLayout(b, plan, { seed });
let L = init, cy = null;
if (global) {
  const r = await runCypress(b, { jobDir: path.join(dir, 'global'), seed: 1000 + seed, init, knobs, budgetS: needsFastRouting(b) ? 80 : 150 });
  cy = { status: r.status, wallS: Math.round(r.wallS) };
  if (!r.layout) { console.log(JSON.stringify({ tag, error: r.status })); process.exit(1); }
  L = r.layout;
}
const leg = legalize(b, L);
fs.writeFileSync(path.join(dir, 'final-layout.json'), JSON.stringify(leg.layout));
const m = await evaluateRobust(b, leg.layout, { router: 'native' });
const sm = C.map((c, i) => i).filter(small), dist = sm.map((i) => Math.hypot(leg.layout[i].x - H[i].x, leg.layout[i].y - H[i].y)).sort((a, c) => a - c);
const row = { board, tag, noise: noise ?? null, rot: noise != null ? rot : null, knobs, global, seed, cypress: cy, smallToHumanMedMm: +dist[dist.length >> 1].toFixed(2),
  clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
