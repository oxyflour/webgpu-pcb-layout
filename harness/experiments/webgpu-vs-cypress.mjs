// WebGPU placer vs Cypress on the registered KiCad cases (ppc excluded), same protocol for both:
//   webgpu : adapter bench/pipeline.mjs placeBoard, options of bench/cypress/compare.mjs
//            (--preplace --power --legalize --sides original --density 3 --congestion 3, budget large)
//   cypress: Cypress benchmark config (random start, crossing on, deterministic, 1000 it, lr 0.01)
//   tool   : harness tool start layout (lib/init.mjs startLayout, empty plan = agent place from
//            'centroid') refined by Cypress with the harness defaults (600 it, lr 0.002, no crossing)
//   tool-init         : the same start layout alone (legalized, no placer)
//   tool-webgpu-global: WebGPU pipeline, global stage starts from the tool start layout (no multi-start)
//   tool-webgpu-lns   : WebGPU pipeline without global stage: LNS + polish + legalization from it
//   all    : shared 0.1 mm legalizer, then evaluateRobust (exact routing, median of grid phases)
//   human  : the input layout, raw (target) and after the same legalizer
// node harness/experiments/webgpu-vs-cypress.mjs --phase webgpu|cypress|tool|evaluate|report
//      [--boards a,b] [--seeds 1000,8919,16838] [--out harness/results/webgpu-vs-cypress] [--jobs 3]
// Resumable: every stage writes DIR/<board>-<seed>/<method>-layout.json and DIR/rows.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { lib } from '../lib/env.mjs';
import { BOARDS, loadBoard, legalize, evaluateRobust, exactRouting, placementMetrics } from '../lib/board.mjs';
import { runCypress, loadCypressResult } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';

const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const phase = arg('phase', 'report'), out = path.resolve(arg('out', 'harness/results/webgpu-vs-cypress'));
const boards = arg('boards', Object.keys(BOARDS).filter((n) => !n.startsWith('ppc')).join(',')).split(',');
const seeds = arg('seeds', '1000,8919,16838').split(',').map(Number), jobs = Number(arg('jobs', 3));
const CYPRESS_KNOBS = { iterations: 1000, learning_rate: 0.01, net_crossing_weight: 0.001, deterministic: 1 };
const METHODS = ['webgpu', 'cypress', 'tool-init', 'tool', 'tool-webgpu-global', 'tool-webgpu-lns'];
const dir = (board, seed) => path.join(out, `${board}-${seed}`);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
fs.mkdirSync(out, { recursive: true });

async function webgpu() {
  const { parseOptions, placeBoard } = await lib('bench/pipeline.mjs');
  const { createNodeWebGpuDevice } = await lib('src/node.js');
  const o = parseOptions(['--preplace', '--power', '--legalize', '--sides', 'original', '--density', '3', '--congestion', '3'], { backend: 'gpu', budget: 'large' });
  const device = await createNodeWebGpuDevice();
  for (const board of boards) {
    const b = loadBoard(board);
    for (const seed of seeds) {
      fs.mkdirSync(dir(board, seed), { recursive: true });
      const save = (method, layout, placementS, extra = {}) => { fs.writeFileSync(path.join(dir(board, seed), `${method}-layout.json`), JSON.stringify({ layout, placementS, ...extra })); log(`${method} ${board}/${seed} ${placementS.toFixed(1)} s`); };
      const has = (method) => fs.existsSync(path.join(dir(board, seed), `${method}-layout.json`));
      // Same start layout as the 'tool' Cypress run (startLayout is deterministic for a seed).
      const t0 = performance.now(), init = startLayout(b, {}, { seed }), initS = (performance.now() - t0) / 1000;
      if (!has('tool-init')) save('tool-init', init, initS);
      for (const [method, opts] of [['webgpu', {}], ['tool-webgpu-global', { initLayout: init, initMode: 'global' }], ['tool-webgpu-lns', { initLayout: init, initMode: 'lns' }]]) {
        if (has(method)) continue;
        const r = await placeBoard(b.a, o, { device, seed, ...opts });
        save(method, r.layout, r.timing.totalMs / 1000 + (opts.initLayout ? initS : 0), { legalFailed: r.legal?.failed ?? null });
      }
    }
  }
}

// method 'cypress': benchmark config from a random start; 'tool': harness init + harness defaults.
async function cypressJobs(method) {
  const todo = boards.flatMap((board) => seeds.map((seed) => ({ board, seed }))).filter(({ board, seed }) => !fs.existsSync(path.join(dir(board, seed), `${method}-layout.json`)));
  const worker = async () => {
    for (let t; (t = todo.shift());) {
      const b = loadBoard(t.board), job = path.join(dir(t.board, t.seed), method);
      const opts = method === 'tool' ? { init: startLayout(b, {}, { seed: t.seed }), knobs: {}, budgetS: 150 + 600 } : { knobs: CYPRESS_KNOBS, budgetS: 900 };
      // budgetS includes up to 10 min waiting for a Cypress slot (lib/cypress.mjs acquireSlot).
      const r = fs.existsSync(path.join(job, 'output.json')) ? loadCypressResult(b, job) : await runCypress(b, { jobDir: job, seed: t.seed, ...opts });
      if (!r.layout) { log(`${method} ${t.board}/${t.seed} FAILED ${r.status} ${r.error ?? ''}`); continue; }
      fs.writeFileSync(path.join(dir(t.board, t.seed), `${method}-layout.json`), JSON.stringify({ layout: r.layout, placementS: r.wallS, solveS: r.solveS, status: r.status, finalOverflow: r.finalOverflow }));
      log(`${method} ${t.board}/${t.seed} ${r.status} ${r.wallS?.toFixed(0)} s`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
}

async function evaluateAll() {
  const rowsFile = path.join(out, 'rows.jsonl');
  const done = new Set(fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.board}|${r.seed}|${r.method}`; }) : []);
  const add = (row) => { fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n'); log(`${row.board}/${row.seed ?? '-'} ${row.method}: ${row.clean}/${row.nets} clean, ${row.vias} vias, HPWL ${row.hpwlMm} mm, overlaps ${row.geometry.overlaps}`); };
  const score = async (b, layout) => { const m = await evaluateRobust(b, layout, exactRouting()); delete m.perNet; return m; };
  for (const board of boards) {
    const b = loadBoard(board);
    if (!done.has(`${board}|null|human-raw`)) add({ board, seed: null, method: 'human-raw', ...(await score(b, b.a.originalLayout)) });
    if (!done.has(`${board}|null|human-legal`)) { const leg = legalize(b, b.a.originalLayout); add({ board, seed: null, method: 'human-legal', legalFailed: leg.failed, ...(await score(b, leg.layout)) }); }
    for (const seed of seeds) for (const method of METHODS) {
      const f = path.join(dir(board, seed), `${method}-layout.json`);
      if (done.has(`${board}|${seed}|${method}`) || !fs.existsSync(f)) continue;
      const placed = read(f), raw = placementMetrics(b, placed.layout), leg = legalize(b, placed.layout);
      const { layout, ...info } = placed;
      add({ board, seed, method, ...info, rawOverlaps: raw.geometry.overlaps, rawHpwlMm: raw.hpwlMm, legalMoved: leg.moved, legalFailedShared: leg.failed, ...(await score(b, leg.layout)) });
    }
  }
}

const NAMES = { webgpu: 'WebGPU', cypress: 'Cypress alone (random start)', 'tool-init': 'Tool init alone', tool: 'Tool init + Cypress', 'tool-webgpu-global': 'Tool init + WebGPU (global from init)', 'tool-webgpu-lns': 'Tool init + WebGPU (LNS only)' };
function report() {
  const rows = fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = new Map(rows.map((r) => [`${r.board}|${r.seed}|${r.method}`, r]));
  const get = (board, method) => [...last.values()].filter((r) => r.board === board && r.method === method).sort((x, y) => x.seed - y.seed);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : null; };
  const trio = (a) => a.length ? ['clean', 'vias', 'hpwlMm'].map((k) => Math.round(med(a.map((r) => r[k])))).join(' / ') : '-';
  const lines = ['## Medians of 3 seeds', '', `| Board | Parts (count) | Signal nets (count) | Human, legalized: clean nets / vias / HPWL (mm) | ${METHODS.map((m) => `${NAMES[m]}: clean nets / vias / HPWL (mm)`).join(' | ')} | ${METHODS.map((m) => `${NAMES[m]}: placement time, median (s)`).join(' | ')} | Cypress converged, random start / tool init (runs, of 3) |`, '|' + '---|'.repeat(5 + 2 * METHODS.length)];
  const per = ['', '## Per seed (1000 / 8919 / 16838)', '', `| Board | ${METHODS.map((m) => `${NAMES[m]}: clean nets per seed (count)`).join(' | ')} | ${METHODS.map((m) => `${NAMES[m]}: vias per seed (count)`).join(' | ')} | ${METHODS.map((m) => `${NAMES[m]}: HPWL per seed (mm)`).join(' | ')} |`, '|' + '---|'.repeat(1 + 3 * METHODS.length)];
  const pairs = [['tool-webgpu-global', 'tool'], ['tool-webgpu-lns', 'tool'], ['tool-webgpu-global', 'webgpu'], ['tool-webgpu-lns', 'webgpu'], ['tool', 'tool-init'], ['tool-webgpu-lns', 'tool-init'], ['tool', 'webgpu'], ['webgpu', 'cypress']], tally = new Map();
  for (const board of boards) {
    const h = get(board, 'human-legal')[0], by = Object.fromEntries(METHODS.map((m) => [m, get(board, m)]));
    if (!h) continue;
    const t = (a) => a.length ? med(a.map((r) => r.placementS)).toFixed(0) : '-', conv = (a) => a.filter((r) => r.status === 'converged').length;
    lines.push(`| ${board} | ${loadBoardSize(board)} | ${h.nets} | ${h.clean} / ${h.vias} / ${Math.round(h.hpwlMm)} | ${METHODS.map((m) => trio(by[m])).join(' | ')} | ${METHODS.map((m) => t(by[m])).join(' | ')} | ${conv(by.cypress)} / ${conv(by.tool)} |`);
    const ps = (a, k) => a.length ? a.map((r) => Math.round(r[k])).join(' / ') : '-';
    per.push(`| ${board} | ${['clean', 'vias', 'hpwlMm'].flatMap((k) => METHODS.map((m) => ps(by[m], k))).join(' | ')} |`);
    for (const [a, b] of pairs) if (by[a].length && by[b].length) for (const [k, sign] of [['clean', 1], ['vias', -1], ['hpwlMm', -1]]) {
      const d = sign * (med(by[a].map((r) => r[k])) - med(by[b].map((r) => r[k]))), key = `${a}|${b}|${k}`;
      const c = tally.get(key) ?? [0, 0, 0]; c[d > 0 ? 0 : d < 0 ? 1 : 2]++; tally.set(key, c);
    }
  }
  const wins = ['', '## Board-by-board wins (medians of 3 seeds)', '', '| Comparison (A vs B) | Metric | Boards where A is better (count) | Boards where B is better (count) | Ties (count) |', '|---|---|---|---|---|'];
  for (const [a, b] of pairs) for (const [k, name] of [['clean', 'Clean signal nets (more is better)'], ['vias', 'Vias (fewer is better)'], ['hpwlMm', 'Signal HPWL (shorter is better)']]) {
    const c = tally.get(`${a}|${b}|${k}`); if (c) wins.push(`| ${NAMES[a]} vs ${NAMES[b]} | ${name} | ${c[0]} | ${c[1]} | ${c[2]} |`);
  }
  const text = [...lines, ...per, ...wins].join('\n');
  fs.writeFileSync(path.join(out, 'summary.md'), text + '\n');
  console.log(text);
}
const sizes = new Map();
function loadBoardSize(board) { if (!sizes.has(board)) sizes.set(board, loadBoard(board).p.components.length); return sizes.get(board); }

const phases = { webgpu, cypress: () => cypressJobs('cypress'), tool: () => cypressJobs('tool'), evaluate: evaluateAll, report };
if (!phases[phase]) throw new Error(`Unknown phase ${phase}`);
await phases[phase]();
process.exit(0);
