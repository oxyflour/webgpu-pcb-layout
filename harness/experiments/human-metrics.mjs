// lib/human-metrics.mjs over a sweep: per board the human layout, the no-agent tool layouts (3
// seeds) and the submitted agent layouts (3 sessions). Routed lengths from evaluateRobust (native
// exact; tool routing on boards > 1000 parts), perNet of the median-via phase. Resumable rows in
// --out; --summary prints the two tables.
// node harness/experiments/human-metrics.mjs --out harness/results/human-metrics-v12.jsonl [--dir sweep-eval-v12] [--agent v12s] [--boards a,b] [--jobs 3] [--summary]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, evaluateRobust, toolRouting, exactRouting, needsFastRouting } from '../lib/board.mjs';
import { boardAnalysis, humanMetrics } from '../lib/human-metrics.mjs';
import { HARNESS_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const R = path.join(HARNESS_ROOT, 'results'), out = path.resolve(arg('out')), dir = arg('dir', 'sweep-eval-v12'), agent = arg('agent', 'v12s');
const ALL = ['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp', 'safety', 'pic', 'nxp', 'rx', 'k60', 'acc', 'ppc-n3'];
const rows = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const read = (f) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : j.layout; };

if (argv.includes('--summary')) {
  const by = {}; for (const r of rows()) ((by[r.board] ??= {})[r.kind] ??= []).push(r);
  const mean = (v) => v.length ? v.reduce((a, c) => a + c, 0) / v.length : NaN, f = (v, d = 1) => isFinite(v) ? v.toFixed(d) : '-';
  const avg = (rs, g) => rs ? mean(rs.map(g).filter((v) => v != null)) : NaN;
  console.log('| Board | Decoupling capacitors with an IC on their supply (count) | Distance to the nearest IC supply pin, median: human / no agent / agent (mm) | p90: human / no agent / agent (mm) | Within 3 mm: human / no agent / agent (share) | Same IC as human: no agent / agent (share) |');
  console.log('|---|---|---|---|---|---|');
  for (const b of ALL) { const g = by[b]; if (!g?.human) continue; const h = g.human[0].m.decap, x = (k, q) => avg(g[k], (r) => r.m.decap[q]);
    console.log(`| ${b} | ${h.count} | ${f(h.medianMm)} / ${f(x('tool', 'medianMm'))} / ${f(x('agent', 'medianMm'))} | ${f(h.p90Mm)} / ${f(x('tool', 'p90Mm'))} / ${f(x('agent', 'p90Mm'))} | ${f(h.within3mm, 2)} / ${f(x('tool', 'within3mm'), 2)} / ${f(x('agent', 'within3mm'), 2)} | ${f(x('tool', 'sameIcAsHuman'), 2)} / ${f(x('agent', 'sameIcAsHuman'), 2)} |`); }
  console.log('\n| Board | Crystal nets (count) | Crystal nets, routed length: human / no agent / agent (mm) | Clock nets (count) | Clock nets, routed length: human / no agent / agent (mm) | Reset nets (count) | Reset nets, routed length: human / no agent / agent (mm) | Differential pairs (count) | Pairs, routed length: human / no agent / agent (mm) | Pairs, length mismatch median: human / no agent / agent (mm) | Vias on all these nets: human / no agent / agent (count) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const b of ALL) { const g = by[b]; if (!g?.human) continue; const h = g.human[0].m, x = (k, gr, q) => avg(g[k], (r) => r.m[gr][q]);
    const three = (gr, q, d = 0) => `${f(h[gr][q], d)} / ${f(x('tool', gr, q), d)} / ${f(x('agent', gr, q), d)}`;
    const vias = (m) => ['crystal', 'clock', 'reset', 'diffPairs'].reduce((a, gr) => a + (m[gr].vias ?? 0), 0);
    console.log(`| ${b} | ${h.crystal.nets} | ${three('crystal', 'routedMm')} | ${h.clock.nets} | ${three('clock', 'routedMm')} | ${h.reset.nets} | ${three('reset', 'routedMm')} | ${h.diffPairs.pairs} | ${three('diffPairs', 'routedMm')} | ${three('diffPairs', 'mismatchMedianMm', 1)} | ${vias(h)} / ${f(avg(g.tool, (r) => vias(r.m)), 0)} / ${f(avg(g.agent, (r) => vias(r.m)), 0)} |`); }
  process.exit(0);
}

const done = new Set(rows().map((r) => `${r.board}|${r.label}`));
const tasks = [];
for (const board of (arg('boards') ?? ALL.join(',')).split(',')) {
  const list = [{ label: 'human', kind: 'human', file: 'human' }];
  for (const seed of [1000, 8919, 16838]) { const f = path.join(R, dir, 'tool', `${board}-${seed}.json`); if (fs.existsSync(f)) list.push({ label: `tool-${seed}`, kind: 'tool', file: f }); }
  for (const r of [1, 2, 3]) { const sf = path.join(R, `${agent}-${board}`, `rep${r}`, 'session', 'session.json'); if (!fs.existsSync(sf)) continue;
    const s = JSON.parse(fs.readFileSync(sf, 'utf8')), id = s.submitted ?? s.best; if (id) list.push({ label: `agent-rep${r}`, kind: 'agent', file: path.join(R, `${agent}-${board}`, `rep${r}`, 'session', 'candidates', `${id}.json`) }); }
  for (const t of list) if (!done.has(`${board}|${t.label}`)) tasks.push({ board, ...t });
}
console.log('tasks', tasks.length);
const cache = new Map();
const worker = async () => { for (let t; (t = tasks.shift());) {
  if (!cache.has(t.board)) { const b = loadBoard(t.board); cache.set(t.board, { b, A: boardAnalysis(b) }); }
  const { b, A } = cache.get(t.board), H = b.a.originalLayout, L = t.file === 'human' ? H : read(t.file);
  const m = await evaluateRobust(b, L, { detail: true, ...(needsFastRouting(b) ? toolRouting(b) : exactRouting()) });
  const row = { board: t.board, label: t.label, kind: t.kind, clean: m.clean, vias: m.vias, m: humanMetrics(b, L, A, { human: H, perNet: m.perNet }) };
  fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(t.board, t.label);
} };
await Promise.all(Array.from({ length: Number(arg('jobs', 3)) }, worker));
