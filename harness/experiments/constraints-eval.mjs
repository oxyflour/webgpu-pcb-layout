// lib/constraints.mjs over a sweep: per board the human layout, the no-agent tool layouts (3 seeds)
// and the submitted agent layouts (3 sessions), routed with evaluateRobust (native exact; tool
// routing > 1000 parts; perNet of the median-via phase), every constraint evaluated. Resumable
// rows in --out; --summary prints the decap and critical-net tables.
// node harness/experiments/constraints-eval.mjs --out harness/results/constraints-v12.jsonl [--dir sweep-eval-v12] [--agent v12s] [--boards a,b] [--jobs 3] [--summary]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, evaluateRobust, toolRouting, exactRouting, needsFastRouting, EVAL_BOARDS } from '../lib/board.mjs';
import { loadConstraints, evalConstraints } from '../lib/constraints.mjs';
import { HARNESS_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const R = path.join(HARNESS_ROOT, 'results'), out = path.resolve(arg('out')), dir = arg('dir', 'sweep-eval-v12'), agent = arg('agent', 'v12s');
const ALL = EVAL_BOARDS;
const rows = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const read = (f) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j) ? j : j.layout; };

if (argv.includes('--summary')) {
  const by = {}; for (const r of rows()) ((by[r.board] ??= {})[r.kind] ??= []).push(r);
  const mean = (v) => v.length ? v.reduce((a, c) => a + c, 0) / v.length : NaN, f = (v, d = 1) => isFinite(v) ? v.toFixed(d) : '-';
  const three = (g, fn, d = 1) => `${f(fn(g.human[0]), d)} / ${f(mean((g.tool ?? []).map(fn)), d)} / ${f(mean((g.agent ?? []).map(fn)), d)}`;
  console.log('| Board | Decoupling capacitors (count) / assigned by schematic sheet (count) | Distance to the assigned IC, median: human / no agent / agent (mm) | Within 3 mm of the assigned IC: human / no agent / agent (share) |');
  console.log('|---|---|---|---|');
  for (const b of ALL) { const g = by[b]; if (!g?.human) continue; const h = g.human[0].c.decap;
    console.log(`| ${b} | ${h.count} / ${h.fromSheet} | ${three(g, (r) => r.c.decap.medianMm)} | ${three(g, (r) => r.c.decap.within3mm, 2)} |`); }
  console.log('\n| Board | Critical constraints (count): net classes / crystal / pairs | Not routed: human / no agent / agent (count of constraints) | Routed length, sum: human / no agent / agent (mm) | Vias, sum: human / no agent / agent (count) | Pair length mismatch, median: human / no agent / agent (mm) | Constraints with more vias than the human: no agent / agent (count) |');
  console.log('|---|---|---|---|---|---|---|');
  for (const b of ALL) { const g = by[b]; if (!g?.human) continue; const H = g.human[0].c.critical, kinds = (k) => H.filter((c) => c.kind === k).length;
    const sum = (r, k) => r.c.critical.reduce((a, c) => a + c[k], 0), nr = (r) => r.c.critical.filter((c) => !c.clean).length;
    const mm = (r) => { const v = r.c.critical.filter((c) => c.kind === 'pair').map((c) => c.mismatchMm).sort((a, c) => a - c); return v.length ? v[(v.length - 1) >> 1] : NaN; };
    const worse = (rs) => mean((rs ?? []).map((r) => r.c.critical.filter((c, k) => c.vias > H[k].vias).length));
    console.log(`| ${b} | ${kinds('class')} / ${kinds('crystal')} / ${kinds('pair')} | ${three(g, nr, 1)} | ${three(g, (r) => sum(r, 'lengthMm'), 0)} | ${three(g, (r) => sum(r, 'vias'), 0)} | ${three(g, mm)} | ${f(worse(g.tool))} / ${f(worse(g.agent))} |`); }
  process.exit(0);
}

const done = new Set(rows().map((r) => `${r.board}|${r.label}`)), tasks = [];
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
  if (!cache.has(t.board)) { const b = loadBoard(t.board); cache.set(t.board, { b, C: loadConstraints(b) }); }
  const { b, C } = cache.get(t.board), L = t.file === 'human' ? b.a.originalLayout : read(t.file);
  const m = await evaluateRobust(b, L, { detail: true, ...(needsFastRouting(b) ? toolRouting(b) : exactRouting()) });
  const row = { board: t.board, label: t.label, kind: t.kind, clean: m.clean, vias: m.vias, c: evalConstraints(b, L, C, m.perNet) };
  fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(t.board, t.label);
} };
await Promise.all(Array.from({ length: Number(arg('jobs', 3)) }, worker));
