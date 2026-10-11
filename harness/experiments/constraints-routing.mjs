// Router rules from a constraint file (lib/constraints.mjs routerRules) on fixed layouts: the human
// layout and the no-agent tool layouts (3 seeds), routed plain and with the rules (evaluateRobust,
// native exact; tool routing > 1000 parts). Constraint file per board: --dir (default
// harness/constraints/examples). Resumable rows in --out; --summary prints the table.
// node harness/experiments/constraints-routing.mjs --out harness/results/constraints-routing.jsonl [--boards a,b] [--jobs 3] [--summary]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, evaluateRobust, toolRouting, exactRouting, needsFastRouting } from '../lib/board.mjs';
import { loadConstraints, routerRules, evalConstraints } from '../lib/constraints.mjs';
import { HARNESS_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const out = path.resolve(arg('out')), cdir = path.resolve(arg('dir', path.join(HARNESS_ROOT, 'constraints', 'examples'))), tools = path.join(HARNESS_ROOT, 'results', arg('tools', 'sweep-eval-v12'), 'tool');
const ALL = ['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp', 'safety', 'pic', 'nxp', 'rx', 'k60', 'acc', 'ppc-n3'];
const rows = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

if (argv.includes('--summary')) {
  const by = {}; for (const r of rows()) ((by[r.board] ??= {})[`${r.kind}|${r.mode}`] ??= []).push(r);
  const mean = (v) => v.reduce((a, c) => a + c, 0) / v.length, f = (v, d = 0) => isFinite(v) ? v.toFixed(d) : '-';
  const lim = (r) => r.c.critical.filter((c) => c.limited), ok = (r) => lim(r).filter((c) => c.pass).length, cv = (r) => lim(r).reduce((a, c) => a + c.vias, 0);
  console.log('| Board | Constrained pairs (count) | Human, plain -> rules: clean nets (count) | Human: vias (count) | Human: constrained pairs passing (count) | Human: vias on constrained nets (count) | No agent, plain -> rules, mean of 3: clean nets (count) | No agent: vias (count) | No agent: pairs passing (count) | No agent: vias on constrained nets (count) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const b of ALL) { const g = by[b]; if (!g) continue; const x = (k, m, fn, d = 0) => f(mean(g[`${k}|${m}`].map(fn)), d), pair = (k, fn, d = 0) => `${x(k, 'plain', fn, d)} -> ${x(k, 'rules', fn, d)}`;
    console.log(`| ${b} | ${lim(g['human|plain'][0]).length} | ${pair('human', (r) => r.clean)} | ${pair('human', (r) => r.vias)} | ${pair('human', ok)} | ${pair('human', cv)} | ${pair('tool', (r) => r.clean, 1)} | ${pair('tool', (r) => r.vias)} | ${pair('tool', ok, 1)} | ${pair('tool', cv, 1)} |`); }
  process.exit(0);
}

const done = new Set(rows().map((r) => `${r.board}|${r.label}|${r.mode}`)), tasks = [];
for (const board of (arg('boards') ?? ALL.join(',')).split(',')) {
  if (!fs.existsSync(path.join(cdir, `${board}.json`))) continue;
  const list = [{ label: 'human', kind: 'human', file: 'human' }, ...[1000, 8919, 16838].map((s) => ({ label: `tool-${s}`, kind: 'tool', file: path.join(tools, `${board}-${s}.json`) })).filter((t) => fs.existsSync(t.file))];
  for (const t of list) for (const mode of ['plain', 'rules']) if (!done.has(`${board}|${t.label}|${mode}`)) tasks.push({ board, mode, ...t });
}
console.log('tasks', tasks.length);
const cache = new Map();
const worker = async () => { for (let t; (t = tasks.shift());) {
  if (!cache.has(t.board)) { const b = loadBoard(t.board), C = loadConstraints(b, { file: path.join(cdir, `${t.board}.json`) }); cache.set(t.board, { b, C, rules: routerRules(b, C) }); }
  const { b, C, rules } = cache.get(t.board), L = t.file === 'human' ? b.a.originalLayout : (j => Array.isArray(j) ? j : j.layout)(JSON.parse(fs.readFileSync(t.file, 'utf8')));
  const m = await evaluateRobust(b, L, { detail: true, ...(needsFastRouting(b) ? toolRouting(b) : exactRouting()), ...(t.mode === 'rules' ? { netRules: rules } : {}) });
  const ruled = new Set(rules.map((r) => r.net)), ce = evalConstraints(b, L, C, m.perNet);
  ce.critical = ce.critical.map((c, k) => ({ ...c, limited: C.critical[k].nets.some((n) => ruled.has(n)) }));
  fs.appendFileSync(out, JSON.stringify({ board: t.board, label: t.label, kind: t.kind, mode: t.mode, clean: m.clean, vias: m.vias, c: { critical: ce.critical } }) + '\n'); console.log(t.board, t.label, t.mode, m.clean, m.vias);
} };
await Promise.all(Array.from({ length: Number(arg('jobs', 3)) }, worker));
