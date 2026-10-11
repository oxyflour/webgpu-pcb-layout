// Paired effect of lib/uncross.mjs on agent candidates: each candidate layout of the given session
// dirs (made without uncross, PCB_UNCROSS=0) is scored as is and after uncross (plan parts kept),
// both with evaluateRobust + tool routing (as in place). Rows to --out.
// node harness/experiments/uncross-paired.mjs --board k60 --dirs results/v10-k60 --out FILE
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, evaluateRobust, toolRouting, legalOk, placementMetrics, worldPin, rotatedSize } from '../lib/board.mjs';
import { createUncross } from '../lib/uncross.mjs';
const uncross = createUncross({ worldPin, rotatedSize });
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), idx = new Map(b.p.components.map((c, i) => [c.id, i])), out = arg('out');
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);
for (const d of arg('dirs').split(',')) for (const r of [1, 2, 3]) {
  const cd = path.join(d, `rep${r}`, 'session', 'candidates'); if (!fs.existsSync(cd)) continue;
  for (const f of fs.readdirSync(cd)) {
    const file = path.join(cd, f); if (done.has(file)) continue;
    const c = JSON.parse(fs.readFileSync(file, 'utf8')), u = uncross(b, c.layout, { deadlineMs: 10000, keep: Object.keys(c.plan ?? {}).map((ref) => idx.get(ref)) });
    const m0 = await evaluateRobust(b, c.layout, toolRouting(b)), m1 = await evaluateRobust(b, u.layout, toolRouting(b));
    const row = { file, board: b.name, crossings: u.crossings, flips: u.flips, swaps: u.swaps, legal: legalOk(placementMetrics(b, u.layout)), clean: [m0.clean, m1.clean], vias: [m0.vias, m1.vias], hpwlMm: [m0.hpwlMm, m1.hpwlMm] };
    fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
  }
}
