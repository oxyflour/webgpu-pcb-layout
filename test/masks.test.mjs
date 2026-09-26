import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeProblem, scoreLayoutCpu, PriorityCpuBatchScorer, PriorityGpuBatchScorer, AnalyticalGlobalPlacer, GpuAnalyticalGlobalPlacer, legalizeLayout, rotatedSize, irToProblem } from '../src/index.js';
import { blockedArea, placementMasks } from '../src/geometry/mask.js';
import { getGpuOrSkip } from './gpu-helper.mjs';

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/** 60 x 40 board: notched outline, a 10 x 10 hole, a top keepout and a 2 mm height limit. */
function maskedProblem(count = 50, seed = 1) {
  const rnd = rng32(seed), components = [], nets = [];
  for (let i = 0; i < count; i++) {
    components.push({ id: `C${i}`, width: 1 + rnd() * 4, height: 1 + rnd() * 3, sides: 'any', twoSided: i % 11 === 0, bodyHeight: i % 4 === 0 ? 5 : 1, pins: [{ id: 'a', x: 0.3, y: 0 }, { id: 'b', x: -0.3, y: 0.2 }] });
  }
  for (let i = 0; i + 1 < count; i += 2) nets.push({ id: `N${i}`, pins: [{ componentId: `C${i}`, pinId: 'a' }, { componentId: `C${i + 1}`, pinId: 'b' }] });
  const canvas = {
    width: 60, height: 40,
    outline: [{ outer: [[0, 0], [60, 0], [60, 40], [20, 40], [20, 32], [0, 32]], holes: [[[30, 10], [40, 10], [40, 20], [30, 20]]] }],
    blocked: [
      { shape: { type: 'rect', x: 45, y: 25, width: 10, height: 10 }, sides: [0] },
      { shape: { type: 'circle', center: [10, 10], radius: 6 }, sides: [0, 1], maxHeight: 2 },
    ],
  };
  return normalizeProblem({ canvas, components, nets });
}

test('blocked area follows the outline, holes, side-specific and height-limited keepouts', () => {
  const p = maskedProblem();
  const m = placementMasks(p), area = (i, pl) => blockedArea(m, p, i, pl);
  const tall = 0, short = 1; // bodyHeight 5 and 1
  const cA = (w, h) => normalizeProblem({ canvas: p.canvas, components: [{ id: 'X', width: w, height: h, bodyHeight: 5 }], nets: [] });
  const one = cA(4, 4), mOne = placementMasks(one);
  assert.ok(Math.abs(blockedArea(mOne, one, 0, { x: 30, y: 15, rotation: 0 }) - 8) < 0.5, 'half inside the hole');
  assert.ok(Math.abs(blockedArea(mOne, one, 0, { x: 10, y: 34, rotation: 0 }) - 16) < 0.5, 'in the notch outside the outline');
  assert.ok(blockedArea(mOne, one, 0, { x: 50, y: 30, rotation: 0 }) > 15, 'top keepout on top');
  assert.equal(blockedArea(mOne, one, 0, { x: 50, y: 30, rotation: 0, side: 1 }), 0, 'top keepout not on bottom');
  // Height limit: only tall parts are blocked by the circle.
  assert.ok(area(tall, { x: 10, y: 10, rotation: 0 }) > 0);
  assert.equal(area(short, { x: 10, y: 10, rotation: 0 }), 0);
  assert.equal(scoreLayoutCpu(one, [{ x: 50, y: 5, rotation: 0 }]).bounds, 0);
});

test('GPU scorer adds the same masked area as the CPU scorer', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const p = maskedProblem(80, 4), rnd = rng32(9);
  const options = { weights: { hpwl: 1, overlap: 100, bounds: 300, congestion: 0 } };
  const layouts = Array.from({ length: 16 }, () => p.components.map(() => ({ x: rnd() * 60, y: rnd() * 40, rotation: Math.floor(rnd() * 4), side: rnd() < 0.4 ? 1 : 0 })));
  const gpu = new PriorityGpuBatchScorer(device, p, options), cpu = new PriorityCpuBatchScorer(p, options);
  const got = await gpu.scoreLayouts(layouts);
  layouts.forEach((l, i) => {
    const want = cpu.scoreLayout(l);
    // Cell-edge rounding differs between f32 and f64 by at most a cell row per part.
    assert.ok(Math.abs(got[i].bounds - want.bounds) <= 1e-3 * want.bounds + 2, `layout ${i}: ${got[i].bounds} vs ${want.bounds}`);
  });
  gpu.destroy(); device.destroy();
});

test('global density treats masked bins as occupied on both backends', async (t) => {
  const device = await getGpuOrSkip(t); if (!device) return;
  const p = maskedProblem(60, 7), rnd = rng32(3);
  const layout = p.components.map(() => ({ x: 25 + rnd() * 20, y: 8 + rnd() * 14, rotation: 0, side: rnd() < 0.5 ? 1 : 0 }));
  const options = { clearance: 0.2, maxMove: 1.5, gridDensity: { strength: 3, bins: 40, target: 0.6, pinArea: 0.5, scales: [1, 2, 4, 8] } };
  const gpu = new GpuAnalyticalGlobalPlacer(device, p, options);
  const cpu = await new AnalyticalGlobalPlacer(p, { ...options, iterations: 3, recordEvery: 1e9 }).optimize(layout);
  const [got] = await gpu.optimizeBatch([layout], 3);
  let worst = 0;
  got.forEach((q, i) => { worst = Math.max(worst, Math.abs(q.x - cpu.layout[i].x), Math.abs(q.y - cpu.layout[i].y)); });
  assert.ok(worst < 2e-3, `max position error ${worst}`);
  // Parts dropped into the hole are pushed out of it.
  const inHole = (l) => l.filter((q) => q.x > 31 && q.x < 39 && q.y > 11 && q.y < 19).length;
  const [spread] = await gpu.optimizeBatch([layout], 200);
  assert.ok(inHole(spread) < inHole(layout) / 3, `${inHole(layout)} -> ${inHole(spread)} parts in the hole`);
  gpu.destroy(); device.destroy();
});

test('legalizer keeps parts off masked cells', () => {
  const p = maskedProblem(70, 11), rnd = rng32(5);
  const layout = p.components.map(() => ({ x: 5 + rnd() * 50, y: 5 + rnd() * 30, rotation: 0, side: rnd() < 0.5 ? 1 : 0 }));
  const out = legalizeLayout(p, layout, { clearance: 0.1 });
  assert.equal(out.failed, 0);
  const m = placementMasks(p);
  out.layout.forEach((q, i) => assert.equal(blockedArea(m, p, i, q), 0, `part ${i} on a masked cell`));
});

test('the minimal IR example routes around its hole and antenna keepout', async () => {
  const ir = JSON.parse(fs.readFileSync(new URL('../examples/board-ir/minimal.board.json', import.meta.url), 'utf8'));
  const a = irToProblem(ir);
  const p = normalizeProblem(a.input);
  assert.ok(p.canvas.outline && p.canvas.blocked.length === 1);
  const m = placementMasks(p);
  // Drop every movable part into the hole, then legalize.
  const layout = a.originalLayout.map((q, i) => p.components[i].fixed ? q : { x: 33, y: 23, rotation: 0, side: 0 });
  const out = legalizeLayout(p, layout);
  assert.equal(out.failed, 0);
  out.layout.forEach((q, i) => {
    assert.equal(blockedArea(m, p, i, q), 0, `${p.components[i].id} on a masked cell`);
    const [w, h] = rotatedSize(p.components[i], q.rotation);
    const e = 1e-6; // touching the hole edge is allowed
    assert.ok(!(q.x + w / 2 > 30 + e && q.x - w / 2 < 36 - e && q.y + h / 2 > 20 + e && q.y - h / 2 < 26 - e) || p.components[i].fixed, `${p.components[i].id} in the hole`);
  });
});

test('evaluation router uses inner layers when the board has them', async () => {
  const { routeBoard } = await import('../bench/pcb-router.mjs');
  // 12 nets from the left edge to the right edge, SMD pads on the top.
  const pads = [], layout = [], sides = [], n = 12;
  for (let k = 0; k < n; k++) {
    const y = 2 + k * 1.4;
    layout.push({ x: 1, y, rotation: 0 }, { x: 19, y, rotation: 0 }); sides.push(1, 1);
    pads.push({ comp: 2 * k, lx: 0, ly: 0, w: 0.4, h: 0.4, rot: 0, tht: false, hole: false, net: k }, { comp: 2 * k + 1, lx: 0, ly: 0, w: 0.4, h: 0.4, rot: 0, tht: false, hole: false, net: k });
  }
  // SMD walls at x = 10 on the top and on the bottom, each with a single one-cell gap:
  // two layers give two channels, inner layers are open.
  for (const side of [1, -1]) for (let y = 0.2; y < 20; y += 0.4) {
    if (Math.abs(y - 10.2) < 0.1) continue;
    pads.push({ comp: layout.length, lx: 0, ly: 0, w: 0.4, h: 0.4, rot: 0, tht: false, hole: false, net: -1 });
    layout.push({ x: 10.2, y, rotation: 0 }); sides.push(side);
  }
  const board = { canvas: { width: 20, height: 20 }, pads, netCount: n };
  const two = routeBoard({ ...board, layers: 2 }, layout, sides, { cell: 0.4, maxRounds: 8 });
  const four = routeBoard({ ...board, layers: 4 }, layout, sides, { cell: 0.4, maxRounds: 8 });
  assert.equal(four.grid.layers, 4);
  assert.ok(two.clean <= 2, `${two.clean} clean nets through two one-cell gaps`);
  assert.equal(four.clean, n, `${four.clean} clean nets with open inner layers`);
});
