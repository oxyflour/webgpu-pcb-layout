// Ablation: current tool init + Cypress (harness defaults), no agent, no human information.
// node harness/experiments/ablation.mjs --board acc --seed 1 --out DIR [--cap-s 180]
// One run (Cypress + legalize + routing) is capped at --cap-s; routing stops after the round
// that passes the cap and is reported as not converged. Every stage is saved in
// DIR/<board>-<seed>/ (start-layout.json, Cypress output.json, legal-layout.json, route.json)
// and reused on rerun. Boards > 1000 parts use the in-tool routing (a).
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluate, needsFastRouting, legalOk } from '../lib/board.mjs';
import { runCypress, loadCypressResult } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';

const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board', 'pico'), seed = Number(arg('seed', 1)), capS = Number(arg('cap-s', 180));
const out = path.resolve(arg('out', 'harness/results/ablation-current')), job = path.join(out, `${board}-${seed}`), file = (f) => path.join(job, f);
const t0 = performance.now(), elapsed = () => (performance.now() - t0) / 1000;
const log = (msg) => console.log(`[${elapsed().toFixed(0).padStart(3)}s] ${board}/${seed} ${msg}`);
fs.mkdirSync(job, { recursive: true });
const b = loadBoard(board);

let init;
if (fs.existsSync(file('start-layout.json'))) init = JSON.parse(fs.readFileSync(file('start-layout.json'), 'utf8'));
else { init = startLayout(b, {}, { seed }); fs.writeFileSync(file('start-layout.json'), JSON.stringify(init)); }

let cy;
if (fs.existsSync(file('output.json'))) { cy = loadCypressResult(b, job); log('reusing Cypress output'); }
else {
  cy = await runCypress(b, { jobDir: job, seed: 1000 + seed, init, budgetS: Math.min(150, capS - 20) });
  if (!cy.layout) { fs.writeFileSync(file('stage-error.json'), JSON.stringify(cy)); log(`Cypress ${cy.status}: ${cy.error}`); process.exit(1); }
  log(`Cypress ${cy.status} in ${cy.wallS.toFixed(0)} s`);
}

let legal;
if (fs.existsSync(file('legal-layout.json'))) legal = JSON.parse(fs.readFileSync(file('legal-layout.json'), 'utf8'));
else { const leg = legalize(b, cy.layout); legal = { layout: leg.layout, failed: leg.failed, nudged: leg.nudged }; fs.writeFileSync(file('legal-layout.json'), JSON.stringify(legal)); log('legalized'); }

let m;
if (fs.existsSync(file('route.json'))) { m = JSON.parse(fs.readFileSync(file('route.json'), 'utf8')); log('reusing routing result'); }
else {
  const left = Math.max(5, capS - elapsed()), tr = performance.now();
  fs.writeFileSync(file('route-progress.jsonl'), '');
  m = evaluate(b, legal.layout, { fast: needsFastRouting(b), deadlineS: left,
    onRound: ({ round, overflow }) => fs.appendFileSync(file('route-progress.jsonl'), JSON.stringify({ round, overflow, s: +((performance.now() - tr) / 1000).toFixed(1) }) + '\n') });
  m.routeSeconds = (performance.now() - tr) / 1000;
  fs.writeFileSync(file('route.json'), JSON.stringify(m));
  log(`routed in ${m.routeSeconds.toFixed(0)} s, ${m.routeRounds} rounds${m.routeConverged ? '' : ' (not converged at the cap)'}`);
}

const row = { board, seed, method: 'tool-init+cypress, no agent', cypress: cy.status, totalS: +elapsed().toFixed(1), legal: legalOk(m), clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, routing: m.routing, routeRounds: m.routeRounds, routeConverged: m.routeConverged };
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
