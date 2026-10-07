// Standalone Cypress baseline: the repository benchmark configuration (crossing on,
// deterministic, 1000 iterations, lr 0.01), seeded random start, no agent, no harness init;
// then the same legalizer and routing as every other row.
// node harness/experiments/standalone.mjs --board acc --seed 1000 --out DIR [--fast] [--route-cap-min 30]
//
// Staged and resumable: every stage writes its artifact into DIR/<board>-<seed>/ and a rerun
// reuses what exists (Cypress output.json -> legal-layout.json -> route.json). Routing logs
// every round to route-progress.jsonl and stops at --route-cap-min (reported, not hidden).
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluate, needsFastRouting } from '../lib/board.mjs';
import { runCypress, loadCypressResult } from '../lib/cypress.mjs';

const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board', 'acc'), seed = Number(arg('seed', 1000)), out = path.resolve(arg('out', 'harness/results/standalone'));
const job = path.join(out, `${board}-${seed}`), capMin = Number(arg('route-cap-min', 30)), fast = argv.includes('--fast');
const b = loadBoard(board), file = (f) => path.join(job, f), log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${board}/${seed} ${msg}`);
fs.mkdirSync(job, { recursive: true });

// Stage 1: Cypress (exact benchmark values, not the harness defaults).
let cy;
if (fs.existsSync(file('output.json'))) { cy = loadCypressResult(b, job); log(`reusing Cypress output (${cy.status})`); }
else {
  const knobs = { iterations: 1000, learning_rate: 0.01, net_crossing_weight: 0.001, deterministic: 1 };
  cy = await runCypress(b, { jobDir: job, seed, init: null, knobs, budgetS: Number(arg('budget', 900)) });
  log(`Cypress ${cy.status} in ${cy.wallS?.toFixed(0)} s`);
  if (!cy.layout) { fs.writeFileSync(file('stage-error.json'), JSON.stringify(cy)); process.exit(1); }
}

// Stage 2: legalization.
let legal;
if (fs.existsSync(file('legal-layout.json'))) { legal = JSON.parse(fs.readFileSync(file('legal-layout.json'), 'utf8')); log('reusing legal layout'); }
else {
  const t = performance.now(), leg = legalize(b, cy.layout);
  legal = { layout: leg.layout, failed: leg.failed, nudged: leg.nudged, seconds: (performance.now() - t) / 1000 };
  fs.writeFileSync(file('legal-layout.json'), JSON.stringify(legal));
  log(`legalized in ${legal.seconds.toFixed(1)} s (failed ${legal.failed})`);
}

// Stage 3: routing evaluation, progress per round, wall-time cap.
let m;
if (fs.existsSync(file('route.json'))) { m = JSON.parse(fs.readFileSync(file('route.json'), 'utf8')); log('reusing routing result'); }
else {
  const t0 = performance.now();
  fs.writeFileSync(file('route-progress.jsonl'), '');
  m = evaluate(b, legal.layout, { fast: fast && needsFastRouting(b), deadlineS: capMin * 60,
    onRound: ({ round, overflow }) => fs.appendFileSync(file('route-progress.jsonl'), JSON.stringify({ round, overflow, s: +((performance.now() - t0) / 1000).toFixed(1) }) + '\n') });
  m.routeSeconds = (performance.now() - t0) / 1000;
  m.routeCapped = !m.routeConverged && m.routeSeconds >= capMin * 60;
  fs.writeFileSync(file('route.json'), JSON.stringify(m));
  log(`routed in ${m.routeSeconds.toFixed(0)} s, ${m.routeRounds} rounds${m.routeCapped ? ' (stopped at the time cap)' : ''}: ${m.clean}/${m.nets} clean, ${m.vias} vias`);
}

const row = { board, seed, method: 'cypress-standalone', status: cy.status, wallS: cy.wallS, solveS: cy.solveS, legalFailed: legal.failed, ...m };
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row).slice(0, 300));
