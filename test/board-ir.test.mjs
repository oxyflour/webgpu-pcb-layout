import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeProblem, worldPin, irToProblem, placementResult, validateBoardIR, rotateQuarter } from '../src/index.js';

const minimal = JSON.parse(fs.readFileSync(new URL('../examples/board-ir/minimal.board.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Board-space position of pad `padId` of footprint `fpId` after irToProblem. */
function padWorld(ir, adapted, layout, fpId, padId) {
  const problem = normalizeProblem(adapted.input);
  const fi = ir.footprints.findIndex((f) => f.id === fpId);
  const frame = adapted.bodyFrame[fi], pad = ir.footprints[fi].pads.find((p) => p.id === padId);
  const [lx, ly] = frame.pinOf(ir.yAxis === 'up' ? { ...pad, at: [pad.at[0], -pad.at[1]] } : pad);
  const pl = layout[fi], [mx, my] = pl.side ? [-lx, ly] : [lx, ly], [rx, ry] = rotateQuarter(mx, my, pl.rotation);
  void problem;
  return [pl.x + rx + adapted.origin.x, pl.y + ry + adapted.origin.y];
}

function tinyBoard(yAxis, placement, extra = {}) {
  return {
    format: 'webgpu-pin-layout/board@1', yAxis,
    board: { outline: [{ outer: [[0, 0], [40, 0], [40, yAxis === 'up' ? -40 : 40], [0, yAxis === 'up' ? -40 : 40]] }] },
    nets: [{ name: 'A' }],
    footprints: [
      { id: 'P', pads: [{ id: '1', at: [1, 0], size: [0.2, 0.2], net: 'A' }, { id: '2', at: [-2, 0.5], size: [0.2, 0.2], net: null }], placement, allowedSides: ['top', 'bottom'], ...extra },
      { id: 'Q', pads: [{ id: '1', at: [0, 0], size: [0.2, 0.2], net: 'A' }], placement: { x: 30, y: yAxis === 'up' ? -30 : 30 }, fixed: true },
    ],
  };
}

test('the minimal example is valid and warns about reserved fields only', () => {
  const { errors, warnings } = validateBoardIR(minimal);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /holes/.test(w)));
  assert.ok(warnings.some((w) => /keepouts/.test(w)));
  assert.ok(warnings.some((w) => /R1.*no placement/.test(w)));
});

test('validation lists every error at once', () => {
  const bad = clone(minimal);
  bad.footprints[1].pads[0].net = 'NOPE';
  bad.footprints.push(clone(bad.footprints[2]));
  bad.footprints[0].placement = undefined;
  bad.footprints[3].allowedSides = ['top'];
  bad.modules[0].footprints.push('GHOST');
  bad.nets[2].priority = 150;
  const { errors } = validateBoardIR(bad);
  for (const re of [/unknown net "NOPE"/, /duplicate footprint "Y1"/, /fixed footprints need a placement/, /placement.side "bottom" is not in allowedSides/, /unknown footprint "GHOST"/, /priority must be within/]) {
    assert.ok(errors.some((e) => re.test(e)), `missing ${re}: ${errors.join(' | ')}`);
  }
});

test('local -> board transform follows docs section 1.4', () => {
  // (1, 0) on a footprint at (10, 20) rotated 90° on top lands at (10, 19) (y-down).
  let ir = tinyBoard('down', { x: 10, y: 20, rotation: 90, side: 'top' });
  let a = irToProblem(ir);
  let [x, y] = padWorld(ir, a, a.originalLayout, 'P', '1');
  assert.ok(close(x, 10) && close(y, 19), `${x},${y}`);
  // Same footprint on the bottom at 0°: mirrored to (9, 20).
  ir = tinyBoard('down', { x: 10, y: 20, rotation: 0, side: 'bottom' });
  a = irToProblem(ir);
  [x, y] = padWorld(ir, a, a.originalLayout, 'P', '1');
  assert.ok(close(x, 9) && close(y, 20), `${x},${y}`);
});

test('a y-up board gives the mirror image of the same y-down board', () => {
  for (const [rotation, side] of [[0, 'top'], [90, 'top'], [270, 'bottom'], [180, 'bottom']]) {
    const down = irToProblem(tinyBoard('down', { x: 12, y: 17, rotation, side }));
    const up = irToProblem(tinyBoard('up', { x: 12, y: -17, rotation, side }));
    const pd = normalizeProblem(down.input), pu = normalizeProblem(up.input);
    pd.pins.forEach((_, k) => {
      const [dx, dy] = worldPin(pd, down.originalLayout, k), [ux, uy] = worldPin(pu, up.originalLayout, k);
      // Internal coordinates are y-down relative to each board's own origin.
      assert.ok(close(dx + down.origin.x, ux + up.origin.x) && close(dy + down.origin.y, -(-(uy + up.origin.y))), `rotation ${rotation} ${side}`);
    });
  }
  // Physical check for y-up: (1, 0) rotated 90° counter-clockwise points to +y (up).
  const ir = tinyBoard('up', { x: 10, y: 20, rotation: 90, side: 'top' });
  const a = irToProblem(ir), [x, y] = padWorld(ir, a, a.originalLayout, 'P', '1');
  assert.ok(close(x, 10) && close(-y, 21), `${x},${-y}`);
});

test('fixed footprints at off-quarter angles keep exact pad positions', () => {
  const ir = tinyBoard('down', { x: 20, y: 20, rotation: 45, side: 'top' }, { fixed: true });
  const a = irToProblem(ir), p = normalizeProblem(a.input);
  const c = Math.SQRT1_2;
  const expect = [[20 + c, 20 - c], [20 - 2 * c + 0.5 * c, 20 + 2 * c + 0.5 * c]];
  const fi = 0, pins = p.components[fi].pins;
  // Only pad 1 is on a signal net; check it, and pad 2 through the routing pads.
  const [x, y] = worldPin(p, a.originalLayout, pins[0]);
  assert.ok(close(x + a.origin.x, expect[0][0]) && close(y + a.origin.y, expect[0][1]), `${x},${y}`);
  const rp = a.routing.pads.filter((q) => q.comp === fi)[1], pl = a.originalLayout[fi];
  assert.ok(close(pl.x + rp.lx + a.origin.x, expect[1][0]) && close(pl.y + rp.ly + a.origin.y, expect[1][1]));
  assert.equal(p.components[fi].rotatable, false);
});

test('placementResult round-trips engine layouts through the IR', () => {
  for (const yAxis of ['down', 'up']) {
    const ir = clone(minimal); ir.yAxis = yAxis;
    if (yAxis === 'up') {
      // Same board expressed with y up.
      for (const o of ir.board.outline) { o.outer = o.outer.map(([x, y]) => [x, -y]); o.holes = o.holes?.map((h) => h.map(([x, y]) => [x, -y])); }
      for (const f of ir.footprints) { f.pads.forEach((p) => { p.at = [p.at[0], -p.at[1]]; }); if (f.placement) f.placement.y = -f.placement.y; if (f.courtyard?.type === 'rect') f.courtyard.y = -(f.courtyard.y + f.courtyard.height); }
      for (const r of ir.regions) r.shape.y = -(r.shape.y + r.shape.height);
      ir.keepouts = [];
    }
    ir.footprints.find((f) => f.id === 'R1').placement = { x: 5, y: yAxis === 'up' ? -5 : 5 };
    const a = irToProblem(ir);
    const layout = a.originalLayout.map((p, i) => a.input.components[i].fixed ? p : { x: p.x + 3, y: p.y + 2, rotation: (p.rotation + i) & 3, side: i % 2 });
    const result = placementResult(a, layout);
    assert.equal(result.yAxis, yAxis);
    const again = clone(ir);
    for (const r of result.placements) Object.assign(again.footprints.find((f) => f.id === r.footprint), { placement: { x: r.x, y: r.y, rotation: r.rotation, side: r.side } });
    const b = irToProblem(again);
    b.originalLayout.forEach((p, i) => {
      assert.ok(close(p.x, layout[i].x, 1e-5) && close(p.y, layout[i].y, 1e-5), `${yAxis} ${ir.footprints[i].id}: ${p.x},${p.y} vs ${layout[i].x},${layout[i].y}`);
      assert.equal(p.rotation, layout[i].rotation);
      assert.equal(p.side ?? 0, layout[i].side ?? 0);
    });
    // Fixed footprints come back exactly as given.
    assert.deepEqual(result.placements.find((r) => r.footprint === 'J1'), { footprint: 'J1', ...ir.footprints[0].placement });
  }
});

test('IR modules, priorities and allowed sides reach the engine problem', () => {
  const a = irToProblem(minimal);
  const byId = (id) => a.input.components.find((c) => c.id === id);
  assert.equal(byId('J1').twoSided, true);
  assert.equal(byId('C1').sides, 'any');
  assert.equal(byId('U1').sides, 'top');
  assert.ok(byId('J1').fixed && byId('H1').fixed);
  assert.deepEqual(a.policy, { CLK: { priority: 90 } });
  assert.equal(a.plan.modules.length, 1);
  assert.deepEqual(a.plan.modules[0].region, { x: 14, y: 4, width: 14, height: 14 });
  assert.deepEqual(a.power.map((n) => n.name).sort(), ['+3V3', 'GND']);
  // Pads with no net still obstruct routing; the hole pad is a hole.
  assert.ok(a.routing.pads.some((p) => p.hole));
});
