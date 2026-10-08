// Regression check of a start-layout change on the 13 non-ppc boards: the old tool layouts
// (webgpu-vs-cypress/<board>-<seed>/tool-layout.json: old start + Cypress) against the current
// start + Cypress (same seeds, same knobs), both legalized and scored with the current
// evaluateRobust (native exact routing). Resumable: one row per (board, seed, variant) in --out.
// node harness/experiments/start-regression.mjs --out FILE [--boards a,b] [--jobs 2] [--variants old,new]
// (every variant other than 'old' runs the CURRENT start layout; name it after the change)
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';
import { HARNESS_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const out = arg('out'), D = path.join(HARNESS_ROOT, 'results', 'webgpu-vs-cypress'), seeds = [1000, 8919, 16838];
const boards = (arg('boards') ?? [...new Set(fs.readdirSync(D).filter((d) => /-\d+$/.test(d)).map((d) => d.replace(/-\d+$/, '')))].join(',')).split(',');
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.board}|${r.seed}|${r.variant}`; }) : []);
const tasks = boards.flatMap((board) => seeds.flatMap((seed) => arg('variants', 'old,new').split(',').map((variant) => ({ board, seed, variant })))).filter((t) => !done.has(`${t.board}|${t.seed}|${t.variant}`));
const pick = (m) => ({ clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, noiseClean: m.noise.clean, overflowRound1: m.margin?.overflowRound1, converged: m.margin?.phasesConverged });
const worker = async () => {
  for (let t; (t = tasks.shift());) {
    const b = loadBoard(t.board); let L, extra = {};
    if (t.variant === 'old') { const j = JSON.parse(fs.readFileSync(path.join(D, `${t.board}-${t.seed}`, 'tool-layout.json'), 'utf8')); L = j.layout; }
    else { const job = path.join(path.dirname(out), 'start-regression-jobs', `${t.board}-${t.seed}${t.variant === 'new' ? '' : '-' + t.variant}`); const r = await runCypress(b, { jobDir: job, seed: t.seed, init: startLayout(b, {}, { seed: t.seed }), knobs: {}, budgetS: 750 });
      if (!r.layout) { console.log('FAILED', t.board, t.seed, r.status); continue; } L = r.layout; extra = { cypress: r.status, cypressS: Math.round(r.wallS) }; }
    const m = await evaluateRobust(b, legalize(b, L).layout, { router: 'native' });
    const row = { ...t, ...extra, ...pick(m) }; fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
  }
};
await Promise.all(Array.from({ length: Number(arg('jobs', 2)) }, worker));
