import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.CYPRESS_RUNTIME ??= path.resolve('results/runtime-cypress-v1');
const { buildSelectionProblem, summarize } = await import('../harness/ui-cypress.mjs');
const { exportIncremental } = await import('../harness/bridge.mjs');
const { normalizeProblem, worldPin, runtimeRoot } = await import('../harness/runtime.mjs');
const { irToProblem } = await import(pathToFileURL(path.join(runtimeRoot, 'src/ir/to-problem.js')).href);
// The editor's sample boards (web/boards of webgpu-layout); override with UI_BOARDS.
const boardFile = path.join(process.env.UI_BOARDS ?? 'C:/Projects/webgpu-layout/web/boards', 'edk.board.json');

// What the editor worker sends: irToProblem(ir, {preplace: true, sides: 'ir'}) and its layout.
function editorRequest() {
  const adapted = irToProblem(JSON.parse(fs.readFileSync(boardFile, 'utf8')), { preplace: true, sides: 'ir' });
  const layout = adapted.originalLayout.map(p => ({ ...p }));
  const free = adapted.input.components.map((c, i) => i).filter(i => !adapted.input.components[i].fixed);
  // Mix of sides and rotations among the selected parts.
  const selected = [...free.filter(i => layout[i].side).slice(0, 3), ...free.filter(i => !layout[i].side && layout[i].rotation).slice(0, 3)];
  return { input: adapted.input, power: adapted.power, layout, selected };
}

test('selection problem fixes unselected parts at their poses and keeps every pin through the Cypress export', { skip: !fs.existsSync(boardFile) && 'sample board missing' }, () => {
  const request = editorRequest(), before = structuredClone(request), built = buildSelectionProblem(request);
  assert.deepEqual(request, before, 'request is not mutated');
  const { components, nets } = built.adapted.input, selected = new Set(request.selected);
  assert.ok(request.selected.some(i => request.layout[i].side) && request.selected.some(i => !request.layout[i].side));
  components.forEach((c, i) => {
    if (selected.has(i)) { assert.equal(c.fixed, undefined); assert.equal(c.sides, request.layout[i].side ? 'bottom' : 'top'); }
    else assert.deepEqual(c.fixed, { x: request.layout[i].x, y: request.layout[i].y, rotation: request.layout[i].rotation & 3, side: request.layout[i].side ? 1 : 0 });
  });
  const index = new Map(components.map((c, i) => [c.id, i]));
  assert.ok(nets.length && nets.every(n => n.pins.some(p => selected.has(index.get(p.componentId)))));
  assert.ok(nets.some(n => request.power.some(r => r.name === n.id)), 'power rails touching the selection are in the objective');
  // World pins of the built problem equal the editor's for the same layout.
  const original = normalizeProblem(request.input), p = normalizeProblem(built.adapted.input);
  for (const [pi, pin] of original.pins.entries()) {
    const q = p.pinIndexByKey.get(`${pin.componentId}\u0000${pin.pinId}`), [x, y] = worldPin(original, request.layout, pi), [x2, y2] = worldPin(p, built.initial, q);
    assert.ok(Math.abs(x - x2) < 1e-9 && Math.abs(y - y2) < 1e-9, pin.componentId);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-cypress-'));
  try { assert.ok(exportIncremental(built.adapted, built.initial, dir).inputPinErrorMm <= .011); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const solved = { layout: built.initial.map((q, i) => i === request.selected[0] ? { ...q, x: q.x + 1, rotation: (q.rotation + 1) & 3 } : q) };
  const out = summarize(built, solved);
  assert.equal(out.placements.length, request.selected.length);
  assert.deepEqual(out.placements[0], [request.selected[0], solved.layout[request.selected[0]].x, solved.layout[request.selected[0]].y, solved.layout[request.selected[0]].rotation, solved.layout[request.selected[0]].side]);
  assert.equal(out.metrics.rotated, 1);
});

test('selection validation rejects empty, board-fixed and mismatched requests', { skip: !fs.existsSync(boardFile) && 'sample board missing' }, () => {
  const request = editorRequest(), fixed = request.input.components.findIndex(c => c.fixed);
  assert.throws(() => buildSelectionProblem({ ...request, selected: [] }), /Select/);
  assert.throws(() => buildSelectionProblem({ ...request, selected: [fixed] }), /fixed/);
  assert.throws(() => buildSelectionProblem({ ...request, layout: request.layout.slice(1) }), /layout/);
  const built = buildSelectionProblem({ ...request, allowRotation: false });
  assert.ok(request.selected.every(i => built.adapted.input.components[i].rotatable === false));
});
