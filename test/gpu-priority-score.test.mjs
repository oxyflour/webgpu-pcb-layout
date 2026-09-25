import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, scoreLayoutCpu, GpuBatchScorer, PriorityGpuBatchScorer, PriorityCpuBatchScorer } from '../src/index.js';
import { getGpuOrSkip } from './gpu-helper.mjs';

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/** Random problem with many 2-5 pin nets plus a few nets larger than one lane handles. */
function randomProblem(seed, components = 60) {
  const rnd = rng32(seed), canvas = { width: 120, height: 90 }, comps = [], free = [];
  for (let i = 0; i < components; i++) {
    const w = 1 + rnd() * 9, h = 1 + rnd() * 7, pins = [];
    for (let k = 0; k < 12; k++) { pins.push({ id: `p${k}`, x: (rnd() - .5) * w, y: (rnd() - .5) * h }); free.push([`C${i}`, `p${k}`]); }
    comps.push({ id: `C${i}`, width: w, height: h, pins });
  }
  for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [free[i], free[j]] = [free[j], free[i]]; }
  const nets = []; let q = 0;
  for (const size of [70, 45, 33]) nets.push({ id: `BIG${size}`, pins: free.slice(q, q += size).map(([componentId, pinId]) => ({ componentId, pinId })) });
  while (q + 5 < free.length) { const size = 2 + Math.floor(rnd() * 4); nets.push({ id: `N${nets.length}`, pins: free.slice(q, q += size).map(([componentId, pinId]) => ({ componentId, pinId })) }); }
  return normalizeProblem({ canvas, components: comps, nets });
}

function randomLayouts(problem, seed, count) {
  const rnd = rng32(seed);
  return Array.from({ length: count }, (_, k) => problem.components.map(() => ({
    // Some candidates deliberately stray outside the canvas and pile up in one corner.
    x: k % 3 === 2 ? rnd() * 20 - 5 : rnd() * problem.canvas.width,
    y: k % 3 === 2 ? rnd() * 20 - 5 : rnd() * problem.canvas.height,
    rotation: Math.floor(rnd() * 4),
  })));
}

function assertClose(gpu, cpu, keys, label) {
  for (const k of keys) {
    const tol = 2e-4 * Math.max(1, Math.abs(cpu[k]));
    assert.ok(Math.abs(gpu[k] - cpu[k]) <= tol, `${label} ${k}: gpu ${gpu[k]} vs cpu ${cpu[k]}`);
  }
}

test('priority GPU scorer matches PriorityCpuBatchScorer, including large nets', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const problem = randomProblem(11);
  const policy = {};
  problem.nets.forEach((n, i) => { policy[n.id] = { priority: (i * 37) % 101, topLocked: i % 9 === 0 }; });
  const options = { policy, weights: { hpwl: 1, overlap: 300, bounds: 200, congestion: 0.7 }, coarse: { gridWidth: 30, gridHeight: 20, capacity: 1.7 }, priorityScale: 40, minNetWeight: 0.15, topLockedBoost: 2.5 };
  const cpu = new PriorityCpuBatchScorer(problem, options);
  const gpu = new PriorityGpuBatchScorer(device, problem, options);
  const layouts = randomLayouts(problem, 5, 24);
  const got = await gpu.scoreLayouts(layouts);
  layouts.forEach((l, i) => assertClose(got[i], cpu.scoreLayout(l), ['total', 'hpwl', 'weightedHpwl', 'overlap', 'bounds', 'congestion'], `layout ${i}`));
  gpu.destroy(); device.destroy();
});

test('global-memory congestion grid (large grids) matches the CPU scorer', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const problem = randomProblem(17);
  for (const [coarse, forced] of [[{ gridWidth: 30, gridHeight: 20, capacity: 1.5 }, true], [{ gridWidth: 40, gridHeight: 110, capacity: 1.5 }, undefined]]) {
    const options = { coarse, weights: { congestion: 1 }, globalCongestionGrid: forced };
    const gpu = new PriorityGpuBatchScorer(device, problem, options);
    assert.equal(gpu.globalGrid, true);
    const cpu = new PriorityCpuBatchScorer(problem, options);
    const layouts = randomLayouts(problem, 8, 9);
    const got = await gpu.scoreLayouts(layouts);
    layouts.forEach((l, i) => assertClose(got[i], cpu.scoreLayout(l), ['total', 'weightedHpwl', 'overlap', 'bounds', 'congestion'], `${coarse.gridWidth}x${coarse.gridHeight} layout ${i}`));
    gpu.destroy();
  }
  device.destroy();
});

test('GPU scorer default mode matches scoreLayoutCpu on a larger problem', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const problem = randomProblem(23, 90);
  const gpu = new GpuBatchScorer(device, problem, { coarseCongestion: { gridWidth: 24, gridHeight: 18, capacity: 2 } });
  const layouts = randomLayouts(problem, 9, 12);
  const got = await gpu.scoreLayouts(layouts);
  layouts.forEach((l, i) => assertClose(got[i], scoreLayoutCpu(problem, l, {}, { gridWidth: 24, gridHeight: 18, capacity: 2 }), ['total', 'hpwl', 'overlap', 'bounds', 'congestion'], `layout ${i}`));
  gpu.destroy(); device.destroy();
});

test('scoreSlabs agrees with scoreLayouts and concurrent calls are serialized', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const problem = randomProblem(3, 40), n = problem.components.length;
  const gpu = new PriorityGpuBatchScorer(device, problem, {});
  const layouts = randomLayouts(problem, 4, 7);
  const x = new Float64Array(7 * n), y = new Float64Array(7 * n), r = new Uint8Array(7 * n);
  layouts.forEach((l, k) => l.forEach((p, i) => { x[k * n + i] = p.x; y[k * n + i] = p.y; r[k * n + i] = p.rotation; }));
  const [a, b] = await Promise.all([gpu.scoreLayouts(layouts), gpu.scoreSlabs(x, y, r, 7)]);
  a.forEach((s, i) => assert.deepEqual(b[i], s));
  gpu.destroy(); device.destroy();
});
