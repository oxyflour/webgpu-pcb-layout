// Harness regression tests on the IR fixtures (test/fixtures): no other checkout, no Cypress, no GPU.
// The KiCad comparison runs only when boardsRoot is configured (harness/local.json / PCB_BOARDS_ROOT).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerBoard, loadBoard, evaluate, legalize, placementMetrics, BOARDS } from '../harness/lib/board.mjs';
import { nativeAvailable } from '../harness/lib/native-router.mjs';
import { detailPlace, nativeDetailAvailable } from '../harness/lib/detail.mjs';
import { loadConstraints, constraintsTemplate, routerRules, evalConstraints } from '../harness/lib/constraints.mjs';
import { startLayout } from '../harness/lib/init.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures');
registerBoard('t-z3r0', path.join(FIX, 'z3r0.ir.json'));
registerBoard('t-pico', path.join(FIX, 'pico.ir.json'));
const noNative = !nativeAvailable() && 'native router not built (cmd /c harness\\native\\build.cmd)';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));

test('IR fixture loads as a board with the human layout', () => {
  const b = loadBoard('t-pico');
  assert.equal(b.format, 'ir');
  assert.equal(b.p.components.length, 67);
  assert.equal(b.p.nets.length, 86);
  assert.equal(b.a.originalLayout.length, b.p.components.length);
});

test('IR and KiCad load the same problem', { skip: !BOARDS.pico && 'boardsRoot not set' }, () => {
  // JSON-normalized: the IR file stores -0 as 0 (pin / pad coordinates and angles), otherwise equal.
  const a = loadBoard('pico'), b = loadBoard('t-pico'), j = (v) => JSON.parse(JSON.stringify(v));
  for (const k of ['components', 'pins', 'nets', 'canvas']) assert.deepEqual(j(b.p[k]), j(a.p[k]), k);
  assert.deepEqual(j(b.a.originalLayout), j(a.a.originalLayout));
  assert.deepEqual(j(b.a.routing), j(a.a.routing));
});

test('native router is bit-identical to the JS router; empty rules change nothing', { skip: noNative }, () => {
  const b = loadBoard('t-pico'), H = b.a.originalLayout;
  const js = evaluate(b, H, { detail: true }), nat = evaluate(b, H, { router: 'native', detail: true }), none = evaluate(b, H, { router: 'native', detail: true, netRules: [] });
  for (const k of ['clean', 'vias', 'routedLengthMm', 'routeRounds']) assert.equal(nat[k], js[k], k);
  assert.deepEqual(nat.perNet, js.perNet);
  assert.deepEqual(none.perNet, nat.perNet);
  assert.equal(js.clean, 86);
});

test('detail pass: legal, fixed parts untouched, deterministic when greedy, lower HPWL', () => {
  const b = loadBoard('t-z3r0'), L0 = legalize(b, startLayout(b, {}, { seed: 1 })).layout;
  const run = () => detailPlace(b, L0, { T0: 0, evals: 4000, budgetS: 1e9, seed: 3, engine: 'js' });
  const d = run(), g = placementMetrics(b, d.layout).geometry;
  assert.equal(g.overlaps, 0); assert.equal(g.outside, 0); assert.equal(g.keepout, 0); assert.equal(g.fixedChanged, 0); assert.equal(g.sideChanged, 0);
  b.p.components.forEach((c, i) => { if (c.fixed || c.pins.length >= 8) assert.deepEqual(d.layout[i], L0[i], `${c.id} not moved`); });
  assert.deepEqual(run().layout, d.layout);
  assert.ok(placementMetrics(b, d.layout).hpwlMm < placementMetrics(b, L0).hpwlMm, 'HPWL drops');
});

test('native detail pass is identical to the JS one (greedy and annealed, fixed tries)', { skip: !nativeDetailAvailable() && 'native detail pass not built' }, () => {
  for (const name of ['t-z3r0', 't-pico']) { const b = loadBoard(name), L0 = legalize(b, startLayout(b, {}, { seed: 1 })).layout;
    for (const [T0, lam, mu, relocateEnd] of [[0, 0, 0, 0], [3, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0.5]]) { const o = { T0, lam, mu, relocateEnd, evals: 5000, budgetS: 1e9, seed: 2 };
      const js = detailPlace(b, L0, { ...o, engine: 'js' }), na = detailPlace(b, L0, { ...o, engine: 'native' });
      assert.equal(na.engine, 'native'); assert.equal(na.accepted, js.accepted); assert.deepEqual(na.layout, js.layout, `${name} T0 ${T0} lam ${lam} mu ${mu} end ${relocateEnd}`); } }
  // Critical-net terms: pairs with keepout, length and mismatch limits.
  for (const name of ['t-z3r0', 't-pico']) { const b = loadBoard(name), L0 = legalize(b, startLayout(b, {}, { seed: 1 })).layout, f = path.join(tmp(), 'c.json');
    const pairs = loadConstraints(b, { file: f }).critical.filter((c) => c.kind === 'pair'); assert.ok(pairs.length, name);
    fs.writeFileSync(f, JSON.stringify({ critical: pairs.map((c) => ({ pair: c.nets.map((ni) => b.p.nets[ni].id), keepoutMm: 0.4, maxLengthMm: 5, maxMismatchMm: 0.5 })) }));
    const constraints = loadConstraints(b, { file: f }), o = { T0: 3, evals: 3000, budgetS: 1e9, seed: 3, constraints };
    const js = detailPlace(b, L0, { ...o, engine: 'js' }), na = detailPlace(b, L0, { ...o, engine: 'native' });
    assert.equal(na.accepted, js.accepted); assert.equal(na.costDelta, js.costDelta); assert.deepEqual(na.layout, js.layout, `${name} critical`); }
});

test('constraints: decaps by schematic sheet, template round trip, file overrides, bad refs rejected', () => {
  const b = loadBoard('t-pico'), C = loadConstraints(b, { file: path.join(tmp(), 'none.json') });
  assert.ok(C.decaps.length > 0 && C.decaps.every((d) => d.source === 'sheet'), 'every pico decap assigned by its sheet');
  const dir = tmp(), f = path.join(dir, 't-pico.json');
  fs.writeFileSync(f, JSON.stringify(constraintsTemplate(b, C)));
  const R = loadConstraints(b, { file: f });
  assert.deepEqual(R.decaps.map((d) => d.ics), C.decaps.map((d) => d.ics));
  assert.deepEqual(R.critical.map((c) => c.nets), C.critical.map((c) => c.nets));
  const d0 = C.decaps[0], ic = b.p.components[C.decaps[0].ics[0]].id;
  fs.writeFileSync(f, JSON.stringify({ decaps: { [d0.ref]: { ic, maxMm: 1.5 } }, critical: [{ pair: C.critical.find((c) => c.kind === 'pair').nets.map((n) => b.p.nets[n].id), maxVias: 0, priority: 1 }] }));
  const U = loadConstraints(b, { file: f });
  assert.equal(U.decaps[0].source, 'file'); assert.equal(U.decaps[0].maxMm, 1.5);
  assert.ok(U.critical.some((c) => c.kind === 'pair' && c.maxVias === 0 && c.source === 'file'));
  fs.writeFileSync(f, JSON.stringify({ decaps: { [d0.ref]: 'NOPE' } }));
  assert.throws(() => loadConstraints(b, { file: f }), /unknown IC/);
  fs.writeFileSync(f, JSON.stringify({ critical: [{ nets: ['/no/such/net'] }] }));
  assert.throws(() => loadConstraints(b, { file: f }), /unknown net/);
});

test('router rules: a maxVias 0 pair routes without vias when feasible, clean nets kept', { skip: noNative }, () => {
  const b = loadBoard('t-z3r0'), H = b.a.originalLayout, dir = tmp(), f = path.join(dir, 'c.json');
  const C0 = loadConstraints(b, { file: f }), pairs = C0.critical.filter((c) => c.kind === 'pair');
  fs.writeFileSync(f, JSON.stringify({ critical: pairs.map((c) => ({ pair: c.nets.map((n) => b.p.nets[n].id), maxVias: 0, priority: 1, keepoutMm: 0.4 })) }));
  const C = loadConstraints(b, { file: f }), rules = routerRules(b, C);
  assert.equal(rules.length, pairs.length * 2);
  const plain = evaluate(b, H, { router: 'native', detail: true }), ruled = evaluate(b, H, { router: 'native', detail: true, netRules: rules });
  const ev = evalConstraints(b, H, C, ruled.perNet).critical.filter((c) => c.kind === 'pair');
  assert.ok(ev.every((c) => c.pass || c.fails.some((x) => x.startsWith('infeasible'))), JSON.stringify(ev.map((c) => [c.name, c.vias, c.fails])));
  assert.equal(ruled.clean, plain.clean);
});

test('tool place runs without Cypress (start layout, legalizer, detail pass, routing)', { skip: noNative }, async () => {
  process.env.PCB_DETAIL_BUDGET = '2';
  const { initSession, callTool } = await import('../harness/agent/session.mjs');
  const dir = tmp(); await initSession(dir, { board: 't-z3r0', seed: 1 });
  const r = await callTool(dir, 'place', {});
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.candidate, 'c000');
  assert.equal(r.metrics.nets, 46);
  assert.ok(r.metrics.clean >= 40);
  assert.ok(r.constraints.decap.count > 0);
  const e = await callTool(dir, 'place', { knobs: {} });
  assert.match(e.error, /knobs \/ netWeights no longer exist/);
});
