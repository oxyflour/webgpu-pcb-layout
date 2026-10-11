// lib/detail.mjs on saved tool layouts: legalize, detail pass, legalize, evaluateRobust (native exact).
// node harness/experiments/detail-check.mjs --board k60 --out FILE [--budget 30] [--t0 3] [--nu 2] [--relocate 0.15] [--seed 1] L1.json L2.json ...
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust } from '../lib/board.mjs';
import { detailPlace } from '../lib/detail.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const files = argv.filter((a, k) => !a.startsWith('--') && !(k > 0 && argv[k - 1].startsWith('--')));
const b = loadBoard(arg('board')), opts = { budgetS: Number(arg('budget', 30)), T0: Number(arg('t0', 3)), nu: Number(arg('nu', 2)), relocate: Number(arg('relocate', 0.15)), seed: Number(arg('seed', 1)), gap: Number(arg('gap', 0.8)) };
const pick = (m) => ({ clean: m.clean, vias: m.vias, hpwlMm: Math.round(m.hpwlMm), ovf1: m.margin?.overflowRound1 });
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8')), L0 = legalize(b, j.layout ?? j).layout;
  const d = detailPlace(b, L0, opts), leg = legalize(b, d.layout);
  if (arg('save')) fs.writeFileSync(arg('save'), JSON.stringify(leg.layout));
  const [m0, m1] = [await evaluateRobust(b, L0, { router: 'native', detail: true }), await evaluateRobust(b, leg.layout, { router: 'native', detail: true })];
  const row = { board: b.name, layout: f, ...opts, evals: d.evals, accepted: d.accepted, seconds: d.seconds, legalizerMoved: leg.moved, before: pick(m0), after: pick(m1) };
  fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
}
