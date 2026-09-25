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
