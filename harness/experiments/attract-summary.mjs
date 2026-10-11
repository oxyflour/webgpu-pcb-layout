// Summarize attract.mjs rows: per (start, objective) the 3-seed values as "s1 / s2 / s3".
// node harness/experiments/attract-summary.mjs harness/results/attract/k60.jsonl
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) { const k = `${r.start}|${r.obj}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
const j = (rs, f) => rs.sort((a, c) => a.seed - c.seed).map(f).join(' / ');
console.log('| Start | Objective | Search evals (count) | Objective start -> end | Small-part drift from human, median: start -> end (mm) | Within 1 mm of human: start -> end (share) | Vias: start -> end (count) | Clean nets end (count) | HPWL end (mm) | Round-1 overflow end (cells) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const [k, rs] of groups) {
  const [st, ob] = k.split('|');
  console.log(`| ${st} | ${ob} | ${j(rs, (r) => r.evals)} | ${j(rs, (r) => `${Math.round(r.objective[0])}->${Math.round(r.objective[1])}`)} | ${j(rs, (r) => `${r.drift[0].medMm}->${r.drift[1].medMm}`)} | ${j(rs, (r) => `${r.drift[0].within1}->${r.drift[1].within1}`)} | ${j(rs, (r) => `${r.eval[0].vias}->${r.eval[1].vias}`)} | ${j(rs, (r) => r.eval[1].clean)} | ${j(rs, (r) => Math.round(r.eval[1].hpwlMm))} | ${j(rs, (r) => r.eval[1].ovf1)} |`);
}
