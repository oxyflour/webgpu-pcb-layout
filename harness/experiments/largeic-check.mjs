// Validation of the large-IC start rules (lib/init.mjs placeNearLargeICs) inside a given layout:
// re-place the small parts linked to ICs with >= 100 pins by the rules (parts the rules skip keep
// their pose), legalize, optionally run the global Cypress pass, score (exact router, median of
// grid phases).
// node harness/experiments/largeic-check.mjs --board ppc-n3 --layout FILE|human --tag t --out DIR [--cypress]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, legalOk, exactRouting, needsFastRouting } from '../lib/board.mjs';
import { placeNearLargeICs } from '../lib/init.mjs';
import { runCypress } from '../lib/cypress.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'ppc-n3')), C = b.p.components, src = arg('layout'), out = path.resolve(arg('out')), tag = arg('tag');
const L = (src === 'human' ? b.a.originalLayout : JSON.parse(fs.readFileSync(src, 'utf8'))).map((q) => ({ ...q }));
const free = new Set();
for (const n of b.p.nets) {
  const cs = [...new Set(n.pins.map((pi) => b.p.pins[pi].componentIndex))];
  if (cs.length > 30 || !cs.some((c) => !C[c].fixed && C[c].pins.length >= 100)) continue;
  for (const c of cs) if (!C[c].fixed && C[c].pins.length > 0 && C[c].pins.length < 8) free.add(c);
}
const before = L.map((q) => ({ ...q })), moved = placeNearLargeICs(b, L, free);
const dir = path.join(out, tag); fs.mkdirSync(dir, { recursive: true });
let start = L, cy = null;
if (argv.includes('--cypress')) {
  const r = await runCypress(b, { jobDir: path.join(dir, 'cypress'), seed: 1001, init: legalize(b, L).layout, budgetS: needsFastRouting(b) ? 80 : 150 });
  cy = r.status; if (r.layout) start = r.layout;
}
const leg = legalize(b, start);
fs.writeFileSync(path.join(dir, 'final-layout.json'), JSON.stringify(leg.layout));
const shift = [...free].map((i) => Math.hypot(L[i].x - before[i].x, L[i].y - before[i].y)).filter((d) => d > 1e-6).sort((a, c) => a - c);
const m = await evaluateRobust(b, leg.layout, exactRouting());
const row = { tag, layout: src, candidates: free.size, moved, ruleShiftMm: shift.length ? { p50: +shift[shift.length >> 1].toFixed(1), p90: +shift[Math.floor(0.9 * (shift.length - 1))].toFixed(1) } : null, cypress: cy,
  legal: legalOk(m), clean: m.clean, nets: m.nets, vias: m.vias, viaSites: m.viaSites, hpwlMm: m.hpwlMm, noise: m.noise };
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
