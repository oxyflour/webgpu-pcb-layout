// One Cypress global-placement job: export Bookshelf (+ warm-start hints), solve in the
// CUDA container under a hard timeout, import the raw placement and verify pin geometry.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { lib, CONTAINER, HARNESS_ROOT } from './env.mjs';
import { worldPin } from './board.mjs';

const { exportBookshelf, importCypressPlacement } = await lib('bench/cypress/bookshelf.mjs');
const { randomLayout } = await lib('bench/pipeline.mjs');

// Verified single-board configuration from bench/cypress/compare.mjs (prepare phase).
export const BASE_CONFIG = {
  gpu: 1, gpu_id: 0, num_threads: 8, dtype: 'float32', num_bins_x: 128, num_bins_y: 128,
  global_place_stages: [{ num_bins_x: 128, num_bins_y: 128, iteration: 1000, learning_rate: 0.01, wirelength: 'logsumexp', optimizer: 'adam', Llambda_density_weight_iteration: 5, Lsub_iteration: 2, learning_rate_decay: 0.995 }],
  target_density: 0.65, density_weight: 0.001, gamma: 1, random_seed: 1000, scale_factor: 1, ignore_net_degree: 10000, enable_fillers: 1, gp_noise_ratio: 0.025,
  global_place_flag: 1, legalize_flag: 0, detailed_place_flag: 0, stop_overflow: 0.1, net_crossing_flag: 1, net_crossing_weight: 0.001, enable_rotation: 1,
  random_center_init_flag: 0, macro_overlap_flag: false, plot_flag: 0, get_congestion_map: 0, sort_nets_by_degree: 0, deterministic_flag: 1, macro_halo_x: 0, macro_halo_y: 0,
};

// Knobs an agent may change. Stage keys go into global_place_stages[0].
export const KNOBS = {
  iterations: { stage: 'iteration', min: 50, max: 2000 },
  learning_rate: { stage: 'learning_rate', min: 1e-4, max: 0.05 },
  learning_rate_decay: { stage: 'learning_rate_decay', min: 0.9, max: 1 },
  target_density: { key: 'target_density', min: 0.3, max: 1 },
  density_weight: { key: 'density_weight', min: 1e-6, max: 1 },
  net_crossing_weight: { key: 'net_crossing_weight', min: 0, max: 1 },
  gamma: { key: 'gamma', min: 0.1, max: 10 },
  stop_overflow: { key: 'stop_overflow', min: 0.03, max: 0.5 },
  bins: { key: 'bins', min: 32, max: 256, integer: true },
  deterministic: { key: 'deterministic_flag', min: 0, max: 1, integer: true },
};

// Harness defaults on top of the benchmark config: crossing term off (acc: the term alone
// pushes 600 iterations past 150 s) with orientations frozen at the warm start (run.py);
// orientations come from the plan and init. Agents may set net_crossing_weight > 0 to let
// Cypress optimise rotations (k60 ICs-only: 307/528 vs 293/580, but 3-4x slower).
export const HARNESS_DEFAULTS = { iterations: 600, learning_rate: 0.002, deterministic: 0, net_crossing_weight: 0 };

export function buildConfig(seed, knobs = {}) {
  const c = structuredClone(BASE_CONFIG); c.random_seed = seed;
  knobs = { ...HARNESS_DEFAULTS, ...knobs };
  for (const [k, v] of Object.entries(knobs)) {
    const spec = KNOBS[k];
    if (!spec) throw new Error(`Unknown Cypress knob ${k}; allowed: ${Object.keys(KNOBS).join(', ')}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < spec.min || v > spec.max || (spec.integer && !Number.isInteger(v))) throw new Error(`Knob ${k}=${v} outside [${spec.min}, ${spec.max}]`);
    if (k === 'bins') { c.num_bins_x = c.num_bins_y = v; c.global_place_stages[0].num_bins_x = c.global_place_stages[0].num_bins_y = v; }
    else if (spec.stage) c.global_place_stages[0][spec.stage] = v;
    else c[spec.key] = v;
  }
  if (c.net_crossing_weight === 0) c.net_crossing_flag = 0;
  return c;
}

// Concurrent Cypress jobs on this machine (12 cores, one GPU): each job runs THREADS CPU
// threads; more than SLOTS jobs at once pushed k60 solves past the timeout.
const SLOTS = Number(process.env.CYPRESS_SLOTS ?? 3), THREADS = Number(process.env.CYPRESS_THREADS ?? 6);
const SLOT_DIR = path.join(HARNESS_ROOT, 'results', '.cypress-slots');
async function acquireSlot(maxWaitS) {
  fs.mkdirSync(SLOT_DIR, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    for (let k = 0; k < SLOTS; k++) {
      const d = path.join(SLOT_DIR, `slot${k}`);
      try { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'owner'), String(process.pid)); return { release: () => fs.rmSync(d, { recursive: true, force: true }), waitedS: (Date.now() - t0) / 1000 }; }
      catch { try { if (Date.now() - fs.statSync(d).mtimeMs > 200000) fs.rmSync(d, { recursive: true, force: true }); } catch {} } // stale lock
    }
    if ((Date.now() - t0) / 1000 > maxWaitS) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });

// init: full layout (array aligned with components) used as Cypress starting positions and
// orientations for movable parts; null = seeded random start like the benchmark.
// netWeights: {netId: weight}. Rotation stays enabled: frozen orientations (enable_rotation=0
// or -inf logits) were measured to make warm-started parts drift ~9 mm on pico.
// budgetS: wall time allowed for waiting + solving, so that a whole tool call stays < 3 min.
export async function runCypress(b, { jobDir, seed = 1000, init = null, knobs = {}, netWeights = {}, budgetS = 155 }) {
  fs.mkdirSync(jobDir, { recursive: true });
  // The exporter reads fixed pin positions from the start layout: keep fixed poses exact.
  const start = (init ?? randomLayout(b.p, seed)).map((q, i) => b.p.components[i].fixed ? { ...b.p.components[i].fixed } : q);
  exportBookshelf(b.a, start, jobDir);
  const config = buildConfig(seed, knobs); config.num_threads = THREADS;
  fs.writeFileSync(path.join(jobDir, 'config.json'), JSON.stringify(config, null, 2));
  const netIndex = new Map(b.p.nets.map((n, i) => [n.id, i]));
  const hints = { init_choice: {}, net_weights: {} };
  b.p.components.forEach((c, i) => { if (!c.fixed && init) hints.init_choice[`c${i}`] = ((-(init[i].rotation ?? 0)) % 4 + 4) % 4; });
  for (const [id, w] of Object.entries(netWeights)) {
    if (!netIndex.has(id)) throw new Error(`netWeights: unknown net ${id}`);
    if (!(w >= 0 && w <= 20)) throw new Error(`netWeights: ${id}=${w} outside [0, 20]`);
    hints.net_weights[`n${netIndex.get(id)}`] = w;
  }
  fs.writeFileSync(path.join(jobDir, 'hints.json'), JSON.stringify(hints));
  const remote = `/work/harness/${path.basename(path.dirname(jobDir))}-${path.basename(jobDir)}-${process.pid}-${Date.now()}`;
  let r = docker(['exec', CONTAINER, 'mkdir', '-p', remote]);
  if (r.status !== 0) throw new Error(`docker mkdir failed: ${r.stderr}`);
  docker(['cp', `${jobDir}/.`, `${CONTAINER}:${remote}`]);
  docker(['cp', path.join(HARNESS_ROOT, 'cypress/run.py'), `${CONTAINER}:${remote}/run.py`]);
  const slot = await acquireSlot(budgetS - 60);
  if (!slot) { docker(['exec', CONTAINER, 'rm', '-rf', remote]); return { status: 'timeout', wallS: budgetS - 60, error: 'machine busy (all Cypress slots taken); retry, it does not use up the budget' }; }
  const timeoutS = Math.floor(budgetS - slot.waitedS);
  const t0 = performance.now();
  const log = fs.openSync(path.join(jobDir, 'cypress.log'), 'w');
  const code = await new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-e', `CYPRESS_THREADS=${THREADS}`, '-w', remote, CONTAINER, 'timeout', '--signal=TERM', '--kill-after=5s', `${timeoutS}s`, 'python3', `${remote}/run.py`, remote], { stdio: ['ignore', log, log], windowsHide: true });
    child.on('close', resolve); child.on('error', () => resolve(-1));
  });
  fs.closeSync(log); slot.release();
  const wall = (performance.now() - t0) / 1000;
  if (code !== 0) {
    docker(['cp', `${CONTAINER}:${remote}/DREAMPlace.log`, path.join(jobDir, 'engine.log')]);
    docker(['exec', CONTAINER, 'rm', '-rf', remote]);
    const timedOut = code === 124 || (code === 137 && wall >= timeoutS);
    const lines = fs.readFileSync(path.join(jobDir, 'cypress.log'), 'utf8').split('\n').filter((l) => /Error|Exception|Traceback/.test(l));
    return { status: timedOut ? 'timeout' : 'error', exitCode: code, wallS: wall,
      error: timedOut ? `Cypress exceeded ${timeoutS} s (machine busy); retry, it does not use up the budget` : (lines.slice(-3).join(' | ') || `exit code ${code}`) };
  }
  for (const f of ['output.json', 'engine-metrics.json', 'engine.log']) docker(['cp', `${CONTAINER}:${remote}/${f}`, path.join(jobDir, f)]);
  docker(['exec', CONTAINER, 'rm', '-rf', remote]);
  const output = JSON.parse(fs.readFileSync(path.join(jobDir, 'output.json'), 'utf8'));
  output.process_wall_s = wall;
  fs.writeFileSync(path.join(jobDir, 'output.json'), JSON.stringify(output));
  return { ...loadCypressResult(b, jobDir), wallS: wall, slotWaitS: slot.waitedS };
}

// Import a finished job's output.json (e.g. to re-evaluate without re-running Cypress).
export function loadCypressResult(b, jobDir) {
  const output = JSON.parse(fs.readFileSync(path.join(jobDir, 'output.json'), 'utf8'));
  const layout = importCypressPlacement(b.a, output);
  const pinErr = finalPinError(b, layout, output);
  if (!(pinErr <= 0.025)) throw new Error(`Cypress pin geometry mismatch ${pinErr} mm (rotation/side mapping broken)`);
  return { status: output.engine_converged ? 'converged' : 'unconverged', layout, wallS: output.process_wall_s ?? null, solveS: output.solve_s, iterations: output.iterations, finalOverflow: output.final_overflow, pinErrorMm: pinErr };
}

// Same check as compare.mjs evaluate: engine pins vs our world pins, nearest-consumed.
function finalPinError(b, layout, output) {
  const pins = new Map();
  for (const pin of output.engine_pins) { const k = `${pin.id}/${pin.net}`; if (!pins.has(k)) pins.set(k, []); pins.get(k).push(pin); }
  let err = 0;
  b.p.nets.forEach((net, ni) => net.pins.forEach((pi) => {
    const [x, y] = worldPin(b.p, layout, pi), id = b.p.components[b.p.pins[pi].componentIndex].id, pts = pins.get(`${id}/n${ni}`);
    const d = pts.map((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y))), k = d.indexOf(Math.min(...d));
    err = Math.max(err, d[k]); pts.splice(k, 1);
  }));
  return err;
}
