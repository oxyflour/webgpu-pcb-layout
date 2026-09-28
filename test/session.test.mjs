import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, PlacementSession } from '../src/index.js';
import { getGpuOrSkip } from './gpu-helper.mjs';

function board() {
  const components = [], nets = [];
  for (let i = 0; i < 24; i++) components.push({ id: `C${i}`, width: 2, height: 1.2, sides: 'any', pins: [{ id: 'a', x: 0.6, y: 0 }, { id: 'b', x: -0.6, y: 0 }] });
  for (let i = 0; i + 1 < 24; i++) nets.push({ id: `N${i}`, pins: [{ componentId: `C${i}`, pinId: 'a' }, { componentId: `C${i + 1}`, pinId: 'b' }] });
  const problem = normalizeProblem({ canvas: { width: 40, height: 30 }, components, nets });
  const layout = problem.components.map((c, i) => ({ x: 4 + (i % 6) * 6, y: 4 + Math.floor(i / 6) * 6, rotation: 0, side: 0 }));
  return { problem, layout };
}

test('session keeps locked parts and only changes the re-placed members', async (t) => {
  const device = await getGpuOrSkip(t);
  const { problem, layout } = board();
  const modules = [{ members: [0, 1, 2, 3, 4, 5, 6, 7] }, { members: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] }];
  const s = await PlacementSession.create(problem, layout, { device, modules });
  s.move(3, { x: 20, y: 20 }); s.lock([3]);
  const r = await s.relayout({ around: 3, budgetMs: 150 });
  assert.ok(!r.changed.includes(3));
  assert.deepEqual(s.layout[3], { ...layout[3], x: 20, y: 20 });
  s.layout.forEach((p, i) => { if (!modules[0].members.includes(i)) assert.deepEqual(p, layout[i]); });
  assert.ok(r.timing.totalMs < 150 + 250, `took ${r.timing.totalMs} ms`);
  assert.equal(r.after.overlaps, 0);
  // Unlocked parts are pulled toward the moved, locked part.
  assert.ok(r.after.hpwl < r.before.hpwl);
  device?.destroy();
});

test('assignModule moves joining parts next to the module and keeps locked ones', async () => {
  const { problem, layout } = board();
  const modules = [{ members: [0, 1, 2, 3] }, { members: [20, 21, 22, 23] }];
  const s = await PlacementSession.create(problem, layout, { modules });
  s.lock([21]);
  const r = s.assignModule([20, 21], 0);
  assert.equal(r.module, 0);
  assert.deepEqual(r.moved, [20]);
  assert.deepEqual(s.modules[0].members, [0, 1, 2, 3, 20, 21]);
  assert.deepEqual(s.modules[1].members, [22, 23]);
  assert.equal(s.moduleOf(20), 0);
  assert.deepEqual(s.layout[21], layout[21]);
  const cx = [0, 1, 2, 3].reduce((a, i) => a + layout[i].x, 0) / 4, cy = [0, 1, 2, 3].reduce((a, i) => a + layout[i].y, 0) / 4;
  assert.ok(Math.hypot(s.layout[20].x - cx, s.layout[20].y - cy) < 1);
  // A new module takes the parts as they are; -1 removes them from every module.
  assert.equal(s.assignModule([22], 'new').module, 2);
  assert.deepEqual(s.modules[2].members, [22]);
  s.assignModule([22], -1);
  assert.equal(s.moduleOf(22), -1);
  assert.deepEqual(s.modules[2].members, []);
  // The CPU path re-places the joined part inside the module region without overlaps.
  const rr = await s.relayout({ around: 20, budgetMs: 200 });
  assert.equal(rr.after.overlaps, 0);
});
