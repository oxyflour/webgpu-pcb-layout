// Predictability of the template offsets (experiments/templates.mjs), leave one board out, no
// error accumulation: per small part, |predicted d1 - human d1| and |d2| error (mm), by the
// parent kind (IC / small part) and against the zero predictor (own pin on the parent pin).
// node harness/experiments/templates-error.mjs [board ...]
import fs from 'node:fs';
import { BOARDS } from '../lib/board.mjs';
import { model } from './templates.mjs';
const all = JSON.parse(fs.readFileSync('harness/results/templates-train.json', 'utf8'));
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
console.log('| Board | Parent kind | Parts (count) | Human pin-to-pin link d1, median (mm) | d1 error, learned, p50 / p90 (mm) | d2 error, learned, p50 / p90 (mm) |\n|---|---|---|---|---|---|');
for (const board of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BOARDS)) {
  const predict = model(Object.entries(all).filter(([nm]) => nm !== board && !(board.startsWith('ppc') && nm.startsWith('ppc'))).flatMap(([, s]) => s));
  for (const kind of ['B', 's']) {
    const S = all[board].filter((s) => s.key[6] === kind), e1 = [], e2 = [], z = [];
    for (const s of S) { const m = predict(s.key); if (!m) continue; e1.push(Math.hypot(m.d1[0] - s.d1[0], m.d1[1] - s.d1[1])); e2.push(Math.hypot(m.d2[0] - s.d2[0], m.d2[1] - s.d2[1])); z.push(Math.hypot(...s.d1)); }
    console.log(`| ${board} | ${kind === 'B' ? 'IC (>= 8 pins)' : 'small part'} | ${S.length} | ${q(z, .5).toFixed(1)} | ${q(e1, .5).toFixed(1)} / ${q(e1, .9).toFixed(1)} | ${q(e2, .5).toFixed(1)} / ${q(e2, .9).toFixed(1)} |`);
  }
}
