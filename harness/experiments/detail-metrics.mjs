// Detail-pass variants scored on routing and on the human-practice metrics: start layout (empty
// plan, seeds 1000 / 8919 / 16838) -> legalizer -> detail pass with each variant's options ->
// legalizer -> evaluateRobust (native exact; tool routing > 1000 parts) + lib/human-metrics.mjs.
// Resumable rows in --out; --summary prints per variant the totals over boards and seeds.
// node harness/experiments/detail-metrics.mjs --out F --variants '{"base":{},"k1":{"kappa":1}}' [--boards a,b] [--jobs 3] [--summary]
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust, toolRouting, exactRouting, needsFastRouting } from '../lib/board.mjs';
import { startLayout } from '../lib/init.mjs';
import { detailPlace } from '../lib/detail.mjs';
import { boardAnalysis, humanMetrics } from '../lib/human-metrics.mjs';
import { loadConstraints, evalConstraints } from '../lib/constraints.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const out = arg('out'), seeds = [1000, 8919, 16838];
const BOARDS = ['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp', 'safety', 'pic', 'nxp', 'rx', 'k60', 'acc'];
const rows = () => fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

if (argv.includes('--summary')) {
  const rs = rows(), vars0 = [...new Set(rs.map((r) => r.variant))], base = vars0.includes('base') ? 'base' : vars0[0], vars = [base, ...vars0.filter((v) => v !== base)], key = (r) => `${r.board}|${r.seed}`;
  const B = Object.fromEntries(rs.filter((r) => r.variant === base).map((r) => [key(r), r]));
  const gm = (v) => Math.exp(v.reduce((a, c) => a + Math.log(c), 0) / v.length);
  console.log(`| Detail-pass variant | Layouts (count) | Clean nets, sum (count) | Vias vs ${base}, geometric mean (x) | HPWL vs ${base} (x) | Decap distance median vs ${base}, geometric mean (x) | Decaps within 3 mm, mean over layouts (share) | Decaps on the human's IC, mean (share) | Crystal nets routed length vs ${base}, geometric mean over layouts with crystals (x) | Vias on critical nets, sum (count) |`);
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const v of vars) { const x = rs.filter((r) => r.variant === v && B[key(r)]), pair = (f) => x.map((r) => f(r) / f(B[key(r)]));
    const cx = x.filter((r) => r.m.crystal.nets && B[key(r)].m.crystal.routedMm > 0), crit = (r) => ['crystal', 'clock', 'reset', 'diffPairs'].reduce((a, g) => a + (r.m[g].vias ?? 0), 0);
    console.log(`| ${v} ${JSON.stringify(x[0]?.options ?? {})} | ${x.length} | ${x.reduce((a, r) => a + r.clean, 0)} | ${gm(pair((r) => r.vias)).toFixed(3)} | ${gm(pair((r) => r.hpwlMm)).toFixed(3)} | ${gm(x.filter((r) => r.m.decap.count).map((r) => r.m.decap.medianMm / B[key(r)].m.decap.medianMm)).toFixed(3)} | ${(x.reduce((a, r) => a + (r.m.decap.within3mm ?? 0), 0) / x.length).toFixed(2)} | ${(x.reduce((a, r) => a + (r.m.decap.sameIcAsHuman ?? 0), 0) / x.length).toFixed(2)} | ${cx.length ? gm(cx.map((r) => Math.max(1, r.m.crystal.routedMm) / B[key(r)].m.crystal.routedMm)).toFixed(3) : '-'} | ${x.reduce((a, r) => a + crit(r), 0)} |`); }
  process.exit(0);
}

const variants = JSON.parse(arg('variants')), done = new Set(rows().map((r) => `${r.board}|${r.seed}|${r.variant}`));
const tasks = (arg('boards') ?? BOARDS.join(',')).split(',').flatMap((board) => seeds.flatMap((seed) => Object.keys(variants).map((variant) => ({ board, seed, variant })))).filter((t) => !done.has(`${t.board}|${t.seed}|${t.variant}`));
console.log('tasks', tasks.length);
const worker = async () => { for (let t; (t = tasks.shift());) {
  const b = loadBoard(t.board), A = boardAnalysis(b), opts = variants[t.variant];
  const L0 = legalize(b, startLayout(b, {}, { seed: t.seed })).layout, d = detailPlace(b, L0, { budgetS: needsFastRouting(b) ? 60 : 30, seed: t.seed, ...opts }), L = legalize(b, d.layout).layout;
  const m = await evaluateRobust(b, L, { detail: true, ...(needsFastRouting(b) ? toolRouting(b) : exactRouting()) });
  const row = { ...t, options: opts, clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, m: humanMetrics(b, L, A, { human: b.a.originalLayout, perNet: m.perNet }), c: evalConstraints(b, L, loadConstraints(b), m.perNet) };
  fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(t.board, t.seed, t.variant, row.clean, row.vias, row.m.decap.medianMm);
} };
await Promise.all(Array.from({ length: Number(arg('jobs', 3)) }, worker));
