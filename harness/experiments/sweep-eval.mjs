// Final scoring of a v9 sweep: per board the 3 submitted agent layouts (results/v9s-<board> or
// v9b-<board>), the no-agent tool layouts (start + Cypress, 3 seeds, results/sweep-eval/tool) and
// the human layout. Boards <= 1000 parts: exact native routing at 8 independent grid offsets
// (experiments/why-stable.mjs, child processes); larger boards: evaluateRobust with the tool routing
// (3 phases). Resumable, rows to results/sweep-eval/rows.jsonl; --summary prints the table.
// node harness/experiments/sweep-eval.mjs [--boards a,b] [--jobs 10] | --summary
// --prefixes p,q --out FILE: agent sessions of results/<p>-<board> for every prefix, labelled <p>-rep<r>
// (A/B of tool versions, e.g. uncross-eval).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HARNESS_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const R = path.join(HARNESS_ROOT, 'results'), OUT = arg('out') ? path.resolve(arg('out')) : path.join(R, 'sweep-eval', 'rows.jsonl'), PREFIXES = arg('prefixes')?.split(',');
const OFFSETS = ['0,0', '0.05,0.31', '0.13,0.07', '0.21,0.26', '0.29,0.14', '0.37,0.33', '0.09,0.19', '0.25,0.02'];
const BIG = new Set(['ppc-n3', 'ppc-n1']);
const ALL = ['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp', 'safety', 'pic', 'nxp', 'rx', 'k60', 'acc', 'ppc-n3'];

function layouts(board) {
  const out = [{ label: 'human', file: 'human' }];
  for (const pre of PREFIXES ?? ['v9s', 'v9b']) {
    const d = path.join(R, `${pre}-${board}`); if (!fs.existsSync(d)) continue;
    for (const r of [1, 2, 3]) { const sf = path.join(d, `rep${r}`, 'session', 'session.json'); if (!fs.existsSync(sf) || !fs.existsSync(path.join(d, `rep${r}`, 'summary.json'))) continue; // finished sessions only
      const s = JSON.parse(fs.readFileSync(sf, 'utf8')), id = s.submitted ?? s.best; if (id) out.push({ label: PREFIXES ? `${pre}-rep${r}` : `agent-rep${r}`, file: path.join(d, `rep${r}`, 'session', 'candidates', `${id}.json`) }); }
    if (!PREFIXES) break;
  }
  if (PREFIXES) return out;
  for (const seed of [1000, 8919, 16838]) { const f = path.join(R, 'sweep-eval', 'tool', `${board}-${seed}.json`); if (fs.existsSync(f)) out.push({ label: `tool-${seed}`, file: f }); }
  return out;
}

const rows = () => fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const run = (args) => new Promise((resolve) => { let o = ''; const c = spawn(process.execPath, args, { cwd: path.dirname(HARNESS_ROOT), windowsHide: true }); c.stdout.on('data', (d) => { o += d; }); c.on('close', () => resolve(o.split('\n').filter((l) => l.startsWith('{')))); });

if (argv.includes('--summary')) {
  const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[(s.length - 1) >> 1]; }, mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const by = {}; for (const r of rows()) ((by[r.board] ??= {})[r.label] ??= []).push(r);
  console.log('| Board | Signal nets (count) | Human: clean nets / vias (count) | No agent (start + Cypress): clean nets, mean of 3 seeds (count) | No agent: vias, mean (count) | Agent v9: clean nets per session (count) | Agent v9: clean nets, mean (count) | Agent v9: vias per session (count) | Agent v9: vias, mean (count) | Agent v9: vias / human (x) | Agent v9: sessions converged at every phase (count of 3) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const b of ALL) {
    const g = by[b]; if (!g?.human) continue;
    const per = (lab) => ({ clean: med(g[lab].map((r) => r.clean)), vias: med(g[lab].map((r) => r.vias)), conv: g[lab].every((r) => r.converged) });
    const h = per('human'), A = Object.keys(g).filter((k) => k.startsWith('agent')).sort().map(per), T = Object.keys(g).filter((k) => k.startsWith('tool')).map(per);
    const f1 = (v) => v.toFixed(1), f0 = (v) => v.toFixed(0);
    console.log(`| ${b} | ${g.human[0].nets} | ${h.clean} / ${h.vias} | ${T.length ? f1(mean(T.map((x) => x.clean))) : '-'} | ${T.length ? f0(mean(T.map((x) => x.vias))) : '-'} | ${A.map((x) => x.clean).join(' / ')} | ${A.length ? f1(mean(A.map((x) => x.clean))) : '-'} | ${A.map((x) => x.vias).join(' / ')} | ${A.length ? f0(mean(A.map((x) => x.vias))) : '-'} | ${A.length ? (mean(A.map((x) => x.vias)) / h.vias).toFixed(2) : '-'} | ${A.filter((x) => x.conv).length} |`);
  }
  process.exit(0);
}

const boards = (arg('boards') ?? ALL.join(',')).split(','), done = new Set(rows().map((r) => `${r.board}|${r.label}|${r.offset ?? ''}`));
const tasks = [];
for (const board of boards) for (const { label, file } of layouts(board)) {
  if (BIG.has(board)) { if (!done.has(`${board}|${label}|`)) tasks.push({ board, label, args: [path.join(HARNESS_ROOT, 'experiments', 'sweep-eval-big.mjs'), board, file] }); }
  else for (const o of OFFSETS) if (!done.has(`${board}|${label}|${o}`)) tasks.push({ board, label, offset: o, args: [path.join(HARNESS_ROOT, 'experiments', 'why-stable.mjs'), '--board', board, '--layout', file, '--offset', o] });
}
console.log('tasks', tasks.length);
const worker = async () => { for (let t; (t = tasks.shift());) {
  for (const l of await run(t.args)) { const j = JSON.parse(l); const row = { board: t.board, label: t.label, offset: t.offset, clean: j.clean, nets: j.nets, vias: j.vias, hpwlMm: j.hpwlMm, overflowRound1: j.overflowR1 ?? j.overflowRound1, converged: j.zeroAtRound != null ? true : j.converged ?? false }; fs.appendFileSync(OUT, JSON.stringify(row) + '\n'); }
} };
await Promise.all(Array.from({ length: Number(arg('jobs', 10)) }, worker));
