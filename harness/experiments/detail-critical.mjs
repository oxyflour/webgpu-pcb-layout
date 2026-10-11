// Critical-net terms of the detail pass (lib/detail.mjs critW / rho) on boards with a constraint file
// (--dir, default harness/constraints/examples): start layout (empty plan, seeds 1000 / 8919 /
// 16838) -> legalizer -> 30 s detail pass without / with the file's critical nets -> legalizer ->
// evaluateRobust with the file's router rules in both arms. Resumable rows in --out; --summary.
// node harness/experiments/detail-critical.mjs --out F [--boards a,b] [--jobs 3] [--summary]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, toolRouting, exactRouting, needsFastRouting } from '../lib/board.mjs';
import { startLayout } from '../lib/init.mjs';
import { detailPlace } from '../lib/detail.mjs';
import { loadConstraints, routerRules, evalConstraints } from '../lib/constraints.mjs';
import { HARNESS_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const out = path.resolve(arg('out')), cdir = path.resolve(arg('dir', path.join(HARNESS_ROOT, 'constraints', 'examples'))), seeds = [1000, 8919, 16838];
const ALL = ['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp', 'pic', 'nxp', 'rx', 'k60', 'acc', 'ppc-n3'];
const rows = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

if (argv.includes('--summary')) {
  const by = {}; for (const r of rows()) ((by[r.board] ??= {})[r.variant] ??= []).push(r);
  const mean = (v) => v.reduce((a, c) => a + c, 0) / v.length, f = (v, d = 1) => isFinite(v) ? v.toFixed(d) : '-';
  console.log('| Board | Constrained pairs (count) | Pairs passing: without -> with critical terms (count, mean of 3 seeds) | Vias on constrained nets (count) | Routed length of constrained nets (mm) | Clean nets (count) | Vias, all nets (count) |');
  console.log('|---|---|---|---|---|---|---|');
  let tot = { p0: 0, p1: 0, n: 0 };
  for (const b of ALL) { const g = by[b]; if (!g?.base || !g?.crit) continue; const x = (v, fn, d = 1) => f(mean(g[v].map(fn)), d), two = (fn, d = 1) => `${x('base', fn, d)} -> ${x('crit', fn, d)}`;
    tot.p0 += mean(g.base.map((r) => r.pass)); tot.p1 += mean(g.crit.map((r) => r.pass)); tot.n += g.base[0].pairs;
    console.log(`| ${b} | ${g.base[0].pairs} | ${two((r) => r.pass)} | ${two((r) => r.cvias)} | ${two((r) => r.clen, 0)} | ${two((r) => r.clean)} | ${two((r) => r.vias, 0)} |`); }
  console.log(`\nPairs passing over all boards: ${tot.p0.toFixed(1)} -> ${tot.p1.toFixed(1)} of ${tot.n}`);
  process.exit(0);
}

const done = new Set(rows().map((r) => `${r.board}|${r.seed}|${r.variant}`)), tasks = [];
for (const board of (arg('boards') ?? ALL.join(',')).split(',')) { if (!fs.existsSync(path.join(cdir, `${board}.json`))) continue;
  for (const seed of seeds) for (const variant of ['base', 'crit']) if (!done.has(`${board}|${seed}|${variant}`)) tasks.push({ board, seed, variant }); }
console.log('tasks', tasks.length);
const worker = async () => { for (let t; (t = tasks.shift());) {
  const b = loadBoard(t.board), C = loadConstraints(b, { file: path.join(cdir, `${t.board}.json`) }), rules = routerRules(b, C);
  const L0 = legalize(b, startLayout(b, {}, { seed: t.seed })).layout, d = detailPlace(b, L0, { budgetS: needsFastRouting(b) ? 60 : 30, seed: t.seed, ...(t.variant === 'crit' ? { constraints: C } : { critW: 0, rho: 0 }) }), L = legalize(b, d.layout).layout;
  const m = await evaluateRobust(b, L, { detail: true, ...(needsFastRouting(b) ? toolRouting(b) : exactRouting()), netRules: rules });
  const ruled = new Set(rules.map((r) => r.net)), ce = evalConstraints(b, L, C, m.perNet).critical.filter((c, k) => C.critical[k].nets.some((n) => ruled.has(n)));
  const row = { ...t, evals: d.evals, clean: m.clean, vias: m.vias, pairs: ce.length, pass: ce.filter((c) => c.pass).length, cvias: ce.reduce((a, c) => a + c.vias, 0), clen: ce.reduce((a, c) => a + c.lengthMm, 0) };
  fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
} };
await Promise.all(Array.from({ length: Number(arg('jobs', 3)) }, worker));
