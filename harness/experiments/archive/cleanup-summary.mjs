// Summary of cleanup-check rows: per layout and cleanup setting, clean nets and vias over the grid
// offsets (median, min-max). node harness/experiments/cleanup-summary.mjs FILE...
import fs from 'node:fs';
const rows = process.argv.slice(2).flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; };
const short = (p) => p === 'human' ? 'human' : p.replace(/.*results\//, '').replace(/\/workspace\/final-layout\.json|\/session\/.*|\.json$/g, '');
const g = new Map();
for (const r of rows) { const k = `${r.board}|${short(r.layout)}`; if (!g.has(k)) g.set(k, {}); (g.get(k)[r.cleanup] ??= []).push(r); }
console.log('| Board | Layout | No cleanup: clean nets (median, min–max over offsets) | Cleanup ×4: clean nets (median, min–max) | No cleanup: vias (median, min–max) | Cleanup ×4: vias (median, min–max) | Nets not clean before cleanup (median) | Recovered by cleanup (median) | Route time no cleanup / cleanup (s, median) | Offsets (count) |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
const f = (rs, k) => { const v = rs.map((r) => r[k]); return `${med(v)} (${Math.min(...v)}–${Math.max(...v)})`; };
for (const [k, by] of g) { const [board, lay] = k.split('|'), a = by[0] ?? [], c = by[4] ?? [];
  console.log(`| ${board} | ${lay} | ${f(a, 'clean')} | ${c.length ? f(c, 'clean') : '-'} | ${f(a, 'vias')} | ${c.length ? f(c, 'vias') : '-'} | ${c.length ? med(c.map((r) => r.cleanupStats?.nets ?? 0)) : '-'} | ${c.length ? med(c.map((r) => r.cleanupStats?.recovered ?? 0)) : '-'} | ${med(a.map((r) => r.s))} / ${c.length ? med(c.map((r) => r.s)) : '-'} | ${a.length}/${c.length} |`); }
