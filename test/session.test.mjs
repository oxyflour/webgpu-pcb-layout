import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { irToProblem } from '../core/src/ir/to-problem.js';
import { normalizeProblem, rotatedSize, sharesSide } from '../core/src/problem.js';
import { PlacementSession } from '../core/src/session.js';

// Editor drag (ui/editor-worker.js 'move'): a part dropped onto another module re-places that module too.
test('session: a drop onto another module re-places the overlapped module, not only the own one', async () => {
  const ir = JSON.parse(fs.readFileSync(new URL('./fixtures/pico.ir.json', import.meta.url), 'utf8'));
  const a = irToProblem(ir, { preplace: true, sides: 'original' }), p = normalizeProblem(a.input);
  const s = new PlacementSession(p, a.originalLayout, { seed: 1 });
  const C = p.components, small = (i) => !C[i].fixed && C[i].pins.length < 8;
  // Part i of one module dropped exactly onto a small part j of another module (same side).
  let i = -1, j = -1;
  for (let x = 0; x < C.length && j < 0; x++) for (let y = 0; y < C.length; y++) {
    if (!small(x) || !small(y) || s.moduleOf(x) < 0 || s.moduleOf(y) < 0 || s.moduleOf(x) === s.moduleOf(y) || !sharesSide(p, x, s.state[x], y, s.state[y])) continue;
    i = x; j = y; break;
  }
  assert.ok(i >= 0, 'two small parts in different modules');
  const drop = { x: s.state[j].x, y: s.state[j].y };
  s.move(i, drop); s.lock([i]);
  const own = await s.relayout({ around: i, budgetMs: 2000, seed: 1, apply: false });
  assert.ok(!own.changed.includes(j), 'without moved: only the own module is re-placed');
  const r = await s.relayout({ around: i, moved: [i], budgetMs: 2000, seed: 1 });
  assert.ok(r.applied, 'result applied');
  assert.ok(r.changed.includes(j), 'the overlapped part is re-placed');
  assert.ok(r.changed.some((k) => k !== j && s.moduleOf(k) === s.moduleOf(j)), 'and members of its module');
  assert.deepEqual([s.state[i].x, s.state[i].y], [drop.x, drop.y], 'the dropped (locked) part stays where it was dropped');
  const box = (k) => { const q = s.state[k], [w, h] = rotatedSize(C[k], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
  const [A, B] = [box(i), box(j)];
  assert.ok(Math.min(A[2], B[2]) <= Math.max(A[0], B[0]) || Math.min(A[3], B[3]) <= Math.max(A[1], B[1]) || !sharesSide(p, i, s.state[i], j, s.state[j]), 'the dropped part no longer overlaps the part it landed on');
});
