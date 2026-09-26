import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, legalizeLayout, rotatedSize, sharesSide } from '../src/index.js';

function overlaps(problem, layout) {
  let n = 0;
  for (let i = 0; i < layout.length; i++) for (let j = i + 1; j < layout.length; j++) {
    if (!sharesSide(problem, i, layout[i], j, layout[j])) continue;
    const [aw, ah] = rotatedSize(problem.components[i], layout[i].rotation), [bw, bh] = rotatedSize(problem.components[j], layout[j].rotation);
    const ox = Math.min(layout[i].x + aw / 2, layout[j].x + bw / 2) - Math.max(layout[i].x - aw / 2, layout[j].x - bw / 2);
    const oy = Math.min(layout[i].y + ah / 2, layout[j].y + bh / 2) - Math.max(layout[i].y - ah / 2, layout[j].y - bh / 2);
    if (ox > 1e-9 && oy > 1e-9) n++;
  }
  return n;
}

test('legalizer removes overlaps on both sides and keeps fixed parts', () => {
  const components = [{ id: 'F', width: 10, height: 10, fixed: { x: 20, y: 20, rotation: 0 } }];
  for (let i = 0; i < 40; i++) components.push({ id: `C${i}`, width: 2 + (i % 3), height: 1.5, sides: 'any', twoSided: i % 10 === 0 });
  const problem = normalizeProblem({ canvas: { width: 40, height: 40 }, components, nets: [] });
  // Everything piled on the fixed part, split across the two sides.
  const layout = problem.components.map((c, i) => c.fixed ? { ...c.fixed } : { x: 20 + (i % 5) * 0.3, y: 20, rotation: i % 2, side: i % 3 === 0 ? 1 : 0 });
  assert.ok(overlaps(problem, layout) > 0);
  const out = legalizeLayout(problem, layout, { clearance: 0.1 });
  assert.equal(out.failed, 0);
  assert.equal(overlaps(problem, out.layout), 0);
  assert.deepEqual(out.layout[0], layout[0]);
  out.layout.forEach((p, i) => {
    const [w, h] = rotatedSize(problem.components[i], p.rotation);
    assert.ok(p.x - w / 2 >= -1e-9 && p.x + w / 2 <= 40 + 1e-9 && p.y - h / 2 >= -1e-9 && p.y + h / 2 <= 40 + 1e-9, `part ${i} inside canvas`);
    assert.equal(p.side, layout[i].side);
  });
  // Bottom-side parts may sit under the fixed top-side part.
  assert.ok(out.layout.some((p, i) => i > 0 && p.side === 1 && !problem.components[i].twoSided && Math.abs(p.x - 20) < 5 && Math.abs(p.y - 20) < 5));
});

test('regions keep parts inside during LNS and legalization', async () => {
  const { FastDeltaLnsOptimizer, GpuLnsOptimizer, PriorityCpuBatchScorer } = await import('../src/index.js');
  const components = [{ id: 'J', width: 2, height: 2, fixed: { x: 2, y: 2, rotation: 0 }, pins: [{ id: 'a', x: 0, y: 0 }] }];
  for (let i = 0; i < 6; i++) components.push({ id: `P${i}`, width: 1.5, height: 1, pins: [{ id: 'a', x: 0, y: 0 }] });
  const nets = components.slice(1).map((c) => ({ id: `N${c.id}`, pins: [{ componentId: 'J', pinId: 'a' }, { componentId: c.id, pinId: 'a' }] }));
  // One pin per net on J is not allowed; give J one pin per net instead.
  components[0].pins = nets.map((n, k) => ({ id: `a${k}`, x: 0, y: 0 }));
  nets.forEach((n, k) => { n.pins[0].pinId = `a${k}`; });
  const problem = normalizeProblem({ canvas: { width: 40, height: 40 }, components, nets });
  const region = { x: 25, y: 25, width: 8, height: 8 };
  const regions = problem.components.map((c) => c.fixed ? null : region);
  const start = problem.components.map((c, i) => c.fixed ? { ...c.fixed } : { x: 29, y: 29, rotation: 0 });
  const scorer = new PriorityCpuBatchScorer(problem, { weights: { congestion: 0 } });
  const inRegion = (layout) => layout.every((p, i) => {
    if (!regions[i]) return true;
    const [w, h] = rotatedSize(problem.components[i], p.rotation);
    return p.x - w / 2 >= region.x - 1e-9 && p.x + w / 2 <= region.x + region.width + 1e-9 && p.y - h / 2 >= region.y - 1e-9 && p.y + h / 2 <= region.y + region.height + 1e-9;
  });
  const fast = await new FastDeltaLnsOptimizer(problem, scorer, { iterations: 40, population: 64, translationScale: 6, regions, seed: 2 }).optimize(start);
  assert.ok(inRegion(fast.layout), 'FastDeltaLns left the region');
  const polish = await new GpuLnsOptimizer(problem, scorer, { iterations: 30, population: 64, translationScale: 6, regions, seed: 3 }).optimize(fast.layout);
  assert.ok(inRegion(polish.layout), 'GpuLns left the region');
  const legal = legalizeLayout(problem, polish.layout, { regions });
  assert.equal(legal.failed, 0);
  assert.equal(legal.outsideRegion, 0);
  assert.ok(inRegion(legal.layout), 'legalizer left the region');
  assert.equal(overlaps(problem, legal.layout), 0);
});
