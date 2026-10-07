// Key-information check: does Cypress (+ shared legalizer) preserve a good starting layout?
// node harness/experiments/warmstart.mjs --board pico --out DIR --variant human-default
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluate } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';

const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board', 'pico'), out = path.resolve(arg('out', `harness/results/warmstart-${Date.now()}`)), seed = Number(arg('seed', 1000));
const variants = {
  'random-default': { init: false, knobs: {} },
  'human-default': { init: true, knobs: {} },
  'human-gentle': { init: true, knobs: { iterations: 300, learning_rate: 0.002 } },
  'human-dense': { init: true, knobs: { iterations: 300, learning_rate: 0.002, target_density: 0.9 } },
};
const b = loadBoard(board);
fs.mkdirSync(out, { recursive: true });
const rows = [];
for (const v of arg('variant', Object.keys(variants).join(',')).split(',')) {
  const cfg = variants[v];
  const r = await runCypress(b, { jobDir: path.join(out, `${board}-${v}-${seed}`), seed, init: cfg.init ? b.a.originalLayout : null, knobs: cfg.knobs });
  if (!r.layout) { rows.push({ board, variant: v, ...r }); console.log(JSON.stringify(rows.at(-1))); continue; }
  const disp = r.layout.map((q, i) => Math.hypot(q.x - b.a.originalLayout[i].x, q.y - b.a.originalLayout[i].y)).filter((_, i) => !b.p.components[i].fixed);
  const rotChanged = r.layout.filter((q, i) => !b.p.components[i].fixed && q.rotation !== b.a.originalLayout[i].rotation).length;
  const leg = legalize(b, r.layout), m = evaluate(b, leg.layout);
  rows.push({ board, variant: v, seed, status: r.status, wallS: +r.wallS.toFixed(1), overflow: r.finalOverflow, meanMoveFromHumanMm: +(disp.reduce((s, x) => s + x, 0) / disp.length).toFixed(2), rotChanged, legalFailed: leg.failed, ...m });
  console.log(JSON.stringify(rows.at(-1)));
  fs.writeFileSync(path.join(out, `${board}-${v}-${seed}`, 'final-layout.json'), JSON.stringify(leg.layout));
}
fs.appendFileSync(path.join(out, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
