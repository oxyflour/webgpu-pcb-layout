// Interactive session benchmark: drag-and-relayout and module re-placement within a time budget.
//
//   node bench/session-bench.mjs [--only edk,safety] [--budgets 50,100,200] [--drags 20] [--out results.json]
//
// Starting from the human placement: "drag" moves a random module part by 3-8 mm, locks
// it and re-places the nearest parts of its module; "redo" scatters a whole module
// (up to 60 parts) and re-places it. Reports wall time and what the re-placement left behind.
// The scenarios live in session-scenarios.js; web/latency.html runs the same ones in a browser.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProblem } from '../src/problem.js';
import { loadKicadParser, designToProblem } from './kicad-adapter.mjs';
import { runSessionScenarios, gpuRoundTrip, cpuProbe } from './session-scenarios.js';
import { SESSION_BOARDS } from './session-boards.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const placerRoot = path.resolve(arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const only = arg('only', Object.keys(SESSION_BOARDS).join(',')).split(',');
const budgets = arg('budgets', '50,100,200').split(',').map(Number);
const drags = Number(arg('drags', 20));
const device = await (await import('../src/node.js')).createNodeWebGpuDevice();
const parse = await loadKicadParser(placerRoot);
const roundTrip = await gpuRoundTrip(device), cpuProbeMs = cpuProbe();
console.error(`GPU dispatch round trip p50 / p90: ${roundTrip.p50.toFixed(2)} / ${roundTrip.p90.toFixed(2)} ms; CPU probe ${cpuProbeMs.toFixed(0)} ms`);
const rows = [];
for (const name of only) {
  const text = fs.readFileSync(path.join(placerRoot, 'benchmark', SESSION_BOARDS[name]), 'utf8');
  const adapted = designToProblem(parse(text, name), { sides: 'free', preplace: true });
  const problem = normalizeProblem(adapted.input);
  const r = await runSessionScenarios({ name, problem, layout: adapted.originalLayout, device, budgets, drags, debug: args.includes('--debug'), onRow: (row) => console.error(JSON.stringify(row)) });
  rows.push(...r.rows);
}
device.destroy();
console.table(rows);
const out = arg('out', null);
if (out) fs.writeFileSync(out, JSON.stringify({ environment: 'node-dawn', roundTrip, cpuProbeMs, rows }, null, 1));
