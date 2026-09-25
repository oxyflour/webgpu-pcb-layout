import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, AnalyticalGlobalPlacer, GpuAnalyticalGlobalPlacer } from '../src/index.js';
import { getGpuOrSkip } from './gpu-helper.mjs';

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/** Fixed macro with normal pins, two-pin and multi-pin nets, a zero-weight net. */
function problemAndLayout(seed, count = 150) {
  const rnd = rng32(seed), canvas = { width: 140, height: 100 };
  const macroPins = [];
  for (let k = 0; k < 8; k++) macroPins.push({ id: `m${k}`, x: -10 + k * 20 / 7, y: -8, normal: [0, -1] });
  for (let k = 0; k < 8; k++) macroPins.push({ id: `r${k}`, x: 12, y: -6 + k * 12 / 7, normal: [1, 0] });
  const components = [{ id: 'U', width: 24, height: 16, rotatable: false, fixed: { x: 70, y: 50, rotation: 0 }, pins: macroPins }];
  const free = macroPins.map((p) => ['U', p.id]);
  for (let i = 0; i < count; i++) {
    const w = 1 + rnd() * 6, h = 1 + rnd() * 4, pins = [];
    for (let k = 0; k < 4; k++) { pins.push({ id: `p${k}`, x: (rnd() - .5) * w, y: (rnd() - .5) * h }); free.push([`C${i}`, `p${k}`]); }
    components.push({ id: `C${i}`, width: w, height: h, pins, sides: 'any', twoSided: i % 9 === 0 });
  }
  for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [free[i], free[j]] = [free[j], free[i]]; }
  const nets = []; let q = 0;
  while (q + 6 < free.length) { const size = 2 + Math.floor(rnd() * 5); nets.push({ id: `N${nets.length}`, pins: free.slice(q, q += size).map(([componentId, pinId]) => ({ componentId, pinId })) }); }
  const problem = normalizeProblem({ canvas, components, nets });
  const layout = problem.components.map((c, i) => c.fixed ? { ...c.fixed } : {
    // A few coincident components exercise the deterministic separation direction,
    // and some start outside the canvas to exercise the boundary force.
    x: i % 25 === 3 ? 30 : rnd() * 150 - 5, y: i % 25 === 3 ? 30 : rnd() * 110 - 5, rotation: Math.floor(rnd() * 4), side: i % 3 === 1 ? 1 : 0,
  });
  return { problem, layout };
}

const options = {
  clearance: 0.4, macroClearance: 1.5, egressGap: 2, maxMove: 1.8, cooling: .996,
  netWeight: (net) => net.id === 'N5' ? 0 : 1 + (net.pins.length % 3) * 0.4,
};

test('WebGPU global placer tracks the CPU placer step by step', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const { problem, layout } = problemAndLayout(7);
  const gpu = new GpuAnalyticalGlobalPlacer(device, problem, options);
  for (const iterations of [1, 4]) {
    const cpu = await new AnalyticalGlobalPlacer(problem, { ...options, iterations, recordEvery: 1e9 }).optimize(layout);
    const [got] = await gpu.optimizeBatch([layout], iterations);
    let worst = 0;
    got.forEach((p, i) => { worst = Math.max(worst, Math.abs(p.x - cpu.layout[i].x), Math.abs(p.y - cpu.layout[i].y)); assert.equal(p.rotation, cpu.layout[i].rotation); assert.equal(p.side, cpu.layout[i].side ?? 0); });
    assert.ok(worst < 2e-3, `${iterations} iterations: max position error ${worst}`);
  }
  gpu.destroy(); device.destroy();
});

test('grid density potential matches the CPU placer', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const { problem, layout } = problemAndLayout(13, 120);
  const withGrid = { ...options, gridDensity: { strength: 3, bins: 40, target: 0.6, pinArea: 0.8, scales: [1, 2, 4, 8] } };
  const gpu = new GpuAnalyticalGlobalPlacer(device, problem, withGrid);
  for (const iterations of [1, 3]) {
    const cpu = await new AnalyticalGlobalPlacer(problem, { ...withGrid, iterations, recordEvery: 1e9 }).optimize(layout);
    const [got] = await gpu.optimizeBatch([layout], iterations);
    let worst = 0;
    got.forEach((p, i) => { worst = Math.max(worst, Math.abs(p.x - cpu.layout[i].x), Math.abs(p.y - cpu.layout[i].y)); });
    assert.ok(worst < 2e-3, `${iterations} iterations: max position error ${worst}`);
  }
  // The grid force actually moves parts compared with the plain model.
  const [plain] = await new GpuAnalyticalGlobalPlacer(device, problem, options).optimizeBatch([layout], 3);
  const [grid] = await gpu.optimizeBatch([layout], 3);
  assert.ok(grid.some((p, i) => Math.abs(p.x - plain[i].x) > 1e-3));
  gpu.destroy(); device.destroy();
});

test('batched starts equal individual runs', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const { problem, layout } = problemAndLayout(9, 60);
  const other = layout.map((p, i) => problem.components[i].fixed ? p : { ...p, x: problem.canvas.width - p.x });
  const gpu = new GpuAnalyticalGlobalPlacer(device, problem, options);
  const batch = await gpu.optimizeBatch([layout, other], 40);
  const single = [(await gpu.optimizeBatch([layout], 40))[0], (await gpu.optimizeBatch([other], 40))[0]];
  batch.forEach((l, s) => l.forEach((p, i) => { assert.equal(p.x, single[s][i].x); assert.equal(p.y, single[s][i].y); }));
  // Fixed components never move.
  assert.deepEqual(batch[0][0], problem.components[0].fixed);
  gpu.destroy(); device.destroy();
});
