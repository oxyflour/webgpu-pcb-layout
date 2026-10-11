// One markdown table per board from attract.mjs rows: objective x start, vias after the search
// (seeds 1/2/3, evaluated at the 5 diagonal grid phases) and small-part drift from the human pose.
// node harness/experiments/attract-table.mjs harness/results/attract/k60.jsonl [more.jsonl ...]
import fs from 'node:fs';
const rows = process.argv.slice(2).flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  .filter((r) => ['human', 'noise2', 'noise5'].includes(r.start) && (r.cl ?? 0.1) === 0.1);
const name = (r) => ({ hpwl: 'HPWL', hpwlx: `HPWL + ${r.mu} mm per net crossing`, hpwlg: `HPWL + ${r.nu} x channel deficit`, hpwlgx: `HPWL + ${r.nu} x channel deficit + ${r.mu} mm per crossing`, ovf: `round-1 overflow (${r.phases} search phases)`, vias: `vias (${r.phases} search phases)` }[r.obj])
  + (r.evals > 60000 || (r.trace && r.accepted?.relocate > 1000) ? ', annealed' : '') + (r.accepted?.relocate ? ', + relocate' : '');
const g = new Map();
for (const r of rows) { const k = name(r); if (!g.has(k)) g.set(k, {}); (g.get(k)[r.start] ??= []).push(r); }
const cell = (rs, f) => rs ? rs.sort((a, c) => a.seed - c.seed).map(f).join(' / ') : '-';
const start = (st) => cell(rows.filter((r) => r.start === st && r.obj === 'hpwl'), (r) => r.eval[0].vias);
console.log(`| Search objective | Human legal start: vias after search (count, seeds 1/2/3) | Human +-2 mm start (vias ${start('noise2')}): vias after | Human +-5 mm start (vias ${start('noise5')}): vias after | Small-part drift from human after search, median (mm): human / +-2 / +-5 start, seed 1 | Router objectives, human start, seed 1: objective on its search phases, start -> end, vs the same quantity on the 5 evaluation phases (count) |`);
console.log('|---|---|---|---|---|---|');
for (const [k, by] of g) {
  const d = ['human', 'noise2', 'noise5'].map((st) => by[st]?.find((r) => r.seed === 1)?.drift[1].medMm ?? '-').join(' / ');
  const h = by.human?.find((r) => r.seed === 1), ro = h && (h.obj === 'ovf' || h.obj === 'vias') ? `${h.objective[0]} -> ${h.objective[1]} vs ${h.eval[0][h.obj === 'ovf' ? 'ovf1' : 'vias']} -> ${h.eval[1][h.obj === 'ovf' ? 'ovf1' : 'vias']}` : '-';
  console.log(`| ${k} | ${cell(by.human, (r) => r.eval[1].vias)} | ${cell(by.noise2, (r) => r.eval[1].vias)} | ${cell(by.noise5, (r) => r.eval[1].vias)} | ${d} | ${ro} |`);
}
