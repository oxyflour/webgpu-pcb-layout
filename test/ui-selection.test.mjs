import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lib } from '../harness/lib/env.mjs';
import { buildSelection, summarize } from '../harness/ui/selection.mjs';

const { irToProblem } = await lib('src/ir/to-problem.js');
const { exportBookshelf } = await lib('bench/cypress/bookshelf.mjs');
const { normalizeProblem, worldPin } = await lib('src/problem.js');
// The editor's sample boards (webgpu-layout web/boards); override with UI_BOARDS.
const boardFile = path.join(process.env.UI_BOARDS ?? 'C:/Projects/webgpu-layout/web/boards', 'edk.board.json');
const skip = !fs.existsSync(boardFile) && 'sample board missing';

// What the editor worker sends: irToProblem(ir, {preplace: true, sides: 'ir'}) and its layout.
function editorRequest() {
  const adapted = irToProblem(JSON.parse(fs.readFileSync(boardFile, 'utf8')), { preplace: true, sides: 'ir' });
  const layout = adapted.originalLayout.map((p) => ({ ...p })), comps = adapted.input.components;
  const free = comps.map((_, i) => i).filter((i) => !comps[i].fixed);
  // Both sides and every quarter turn among the selected parts where the board has them.
  const selected = [...free.filter((i) => layout[i].side).slice(0, 3), ...[0, 1, 2, 3].map((r) => free.find((i) => !layout[i].side && layout[i].rotation === r)).filter((i) => i !== undefined)];
  return { input: adapted.input, layout, selected };
}

test('selection keeps unselected parts fixed at their poses and their pins through the Bookshelf export', { skip }, () => {
  const request = editorRequest(), before = structuredClone(request), b = buildSelection(request);
  assert.deepEqual(request, before, 'request is not mutated');
  const sel = new Set(request.selected), comps = b.a.input.components;
  assert.ok(request.selected.some((i) => request.layout[i].side) && request.selected.some((i) => !request.layout[i].side));
  comps.forEach((c, i) => {
    if (sel.has(i)) { assert.equal(c.fixed, undefined); assert.equal(c.sides, request.layout[i].side ? 'bottom' : 'top'); }
    else assert.deepEqual(c.fixed, { x: request.layout[i].x, y: request.layout[i].y, rotation: request.layout[i].rotation & 3, side: request.layout[i].side ? 1 : 0 });
  });
  const index = new Map(comps.map((c, i) => [c.id, i]));
  assert.ok(b.a.input.nets.length && b.a.input.nets.every((n) => n.pins.some((p) => sel.has(index.get(p.componentId)))));
  // Same world pins as the editor's problem for the same layout.
  const original = normalizeProblem(request.input);
  for (const [pi, pin] of original.pins.entries()) {
    const q = b.p.pinIndexByKey.get(`${pin.componentId}\u0000${pin.pinId}`), u = worldPin(original, request.layout, pi), v = worldPin(b.p, b.initial, q);
    assert.ok(Math.abs(u[0] - v[0]) < 1e-9 && Math.abs(u[1] - v[1]) < 1e-9, pin.componentId);
  }
  // What lib/cypress.mjs hands to Cypress: exported pins at their world position (y-up, 0.01 mm
  // grid). Movable parts are exported in their rotation-0 frame and turned by hints.json
  // init_choice inside Cypress (checked after the solve by loadCypressResult), so only fixed and
  // unrotated movable parts can be checked here.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-selection-'));
  try {
    const bridge = exportBookshelf(b.a, b.initial, dir);
    let k = 0, err = 0, checked = 0;
    for (const net of b.p.nets) for (const pi of net.pins) {
      const ci = b.p.pins[pi].componentIndex, e = bridge.expectedPins[k++];
      if (!b.p.components[ci].fixed && b.initial[ci].rotation) continue;
      const [x, y] = worldPin(b.p, b.initial, pi); checked++;
      err = Math.max(err, Math.abs(e.x - x), Math.abs(bridge.height - e.y - y));
    }
    assert.equal(k, bridge.expectedPins.length);
    assert.ok(checked > 0);
    assert.ok(err <= 0.011, `export pin error ${err} mm`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const moved = b.initial.map((q, i) => (i === request.selected[0] ? { ...q, x: q.x + 1, rotation: (q.rotation + 1) & 3 } : q));
  const out = summarize(b, moved);
  assert.deepEqual(out.placements[0], [request.selected[0], moved[request.selected[0]].x, moved[request.selected[0]].y, moved[request.selected[0]].rotation, moved[request.selected[0]].side]);
  assert.equal(out.metrics.rotated, 1);
});

test('selection rejects empty, board-fixed and mismatched requests', { skip }, () => {
  const request = editorRequest(), fixed = request.input.components.findIndex((c) => c.fixed);
  assert.throws(() => buildSelection({ ...request, selected: [] }), /Select/);
  assert.throws(() => buildSelection({ ...request, selected: [fixed] }), /fixed/);
  assert.throws(() => buildSelection({ ...request, layout: request.layout.slice(1) }), /layout/);
});
