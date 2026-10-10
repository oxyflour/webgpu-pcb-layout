// Summary of experiments/tree.mjs rows.jsonl: one line per configuration, seeds 1/2/3.
// node harness/experiments/tree-summary.mjs harness/results/tree/rows.jsonl
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const g = new Map();
for (const r of rows) { const k = `${r.board} ${r.level}${r.boost ? ` boost=${r.boost}` : ''}${r.w != null ? ` w=${r.w}` : ''}${r.global ? ' +Cypress' : ' start only'}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
console.log('| Configuration | Clean nets (count of total, seeds 1/2/3) | Vias (count) | HPWL (mm) | Non-IC parts: start-layout distance to human pose, median (mm) | Legal (all seeds) |\n|---|---|---|---|---|---|');
for (const [k, rs] of g) { rs.sort((a, c) => a.seed - c.seed); const j = (f) => rs.map(f).join(' / ');
  console.log(`| ${k} | ${j((r) => r.clean)} of ${rs[0].nets} | ${j((r) => r.vias)} | ${j((r) => Math.round(r.hpwlMm))} | ${j((r) => r.initToHumanMedMm)} | ${rs.every((r) => r.legal) ? 'yes' : 'no'} |`); }
