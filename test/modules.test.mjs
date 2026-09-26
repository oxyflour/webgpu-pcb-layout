import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProblem, autoModules, moduleProblem, expandModules, withModuleNets, moduleStats } from '../src/index.js';

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/** Three dense 8-part clusters joined by a single net each, plus two unconnected parts. */
function clustered() {
  const rnd = rng32(5), components = [], nets = [];
  for (let c = 0; c < 3; c++) for (let k = 0; k < 8; k++) {
    components.push({ id: `C${c}_${k}`, width: 2, height: 1.5, sides: 'any', pins: Array.from({ length: 10 }, (_, p) => ({ id: `p${p}`, x: rnd() - .5, y: rnd() - .5 })) });
  }
  components.push({ id: 'DECAP1', width: 1, height: .5, pins: [] }, { id: 'DECAP2', width: 1, height: .5, pins: [] });
  components.push({ id: 'J1', width: 6, height: 3, fixed: { x: 5, y: 5, rotation: 0 }, pins: [{ id: 'a', x: 0, y: 0 }] });
  const used = new Map(); const pin = (comp) => { const k = used.get(comp) ?? 0; used.set(comp, k + 1); return { componentId: comp, pinId: `p${k}` }; };
  for (let c = 0; c < 3; c++) for (let k = 0; k < 8; k++) for (let j = k + 1; j < 8; j += 3) nets.push({ id: `N${c}_${k}_${j}`, pins: [pin(`C${c}_${k}`), pin(`C${c}_${j}`)] });
  nets.push({ id: 'X01', pins: [pin('C0_0'), pin('C1_0')] }, { id: 'X12', pins: [pin('C1_1'), pin('C2_1')] }, { id: 'XJ', pins: [pin('C2_2'), { componentId: 'J1', pinId: 'a' }] });
  return normalizeProblem({ canvas: { width: 60, height: 40 }, components, nets });
}

test('autoModules recovers the clusters and leaves unconnected and fixed parts out', () => {
  const problem = clustered();
  const { modules, unassigned } = autoModules(problem, { seed: 3 });
  assert.equal(modules.length, 3);
  const cluster = (i) => problem.components[i].id.slice(0, 2);
  for (const m of modules) assert.equal(new Set(m.members.map(cluster)).size, 1, `mixed module ${m.members.map((i) => problem.components[i].id)}`);
  assert.deepEqual(unassigned.map((i) => problem.components[i].id).sort(), ['DECAP1', 'DECAP2']);
  const { stats, links } = moduleStats(problem, modules);
  assert.equal(stats.reduce((s, x) => s + x.parts, 0), 24);
  assert.equal(links.reduce((s, l) => s + l.nets, 0), 2);
});

test('large modules are split to respect maxAreaFraction', () => {
  const problem = clustered();
  const { modules } = autoModules(problem, { seed: 3, resolution: 0.05, maxAreaFraction: 0.02 });
  for (const m of modules) assert.ok(m.members.reduce((s, i) => s + problem.components[i].width * problem.components[i].height, 0) <= 0.02 * 60 * 40 + 1e-9 || m.members.length === 1);
});

test('module problem, expansion and cohesion nets are consistent', () => {
  const problem = clustered();
  const { modules } = autoModules(problem, { seed: 3 });
  const sided = modules.map((m, k) => ({ ...m, side: k === 1 ? 1 : 0 }));
  const layout = problem.components.map((c) => c.fixed ? { ...c.fixed } : { x: 30, y: 20, rotation: 0 });
  const mp = moduleProblem(problem, layout, sided, { target: 0.6, pinArea: 0 });
  const mprob = normalizeProblem(mp.input);
  // 3 modules + 2 decaps + fixed connector; module nets only between different owners.
  assert.equal(mprob.components.length, 6);
  assert.equal(mprob.nets.length, 3);
  assert.equal(mprob.components[1].sides, 'bottom');
  const modLayout = mp.initial.map((p, k) => p ?? { x: 15 + 15 * k, y: 20, rotation: 0, side: sided[k]?.side ?? 0 });
  const expanded = expandModules(problem, mp, modLayout, sided, 7);
  sided.forEach((m, k) => {
    const half = 0.45 * mp.input.components[k].width + 1e-9;
    for (const i of m.members) {
      assert.ok(Math.abs(expanded[i].x - modLayout[k].x) <= half + problem.components[i].width && Math.abs(expanded[i].y - modLayout[k].y) <= half + problem.components[i].height);
      assert.equal(expanded[i].side, m.side);
    }
  });
  assert.deepEqual(expanded[problem.components.length - 1], problem.components[problem.components.length - 1].fixed);
  const withNets = normalizeProblem(withModuleNets({ canvas: problem.canvas, components: problem.components.map((c) => ({ id: c.id, width: c.width, height: c.height, pins: c.pins.map((p) => ({ id: problem.pins[p].pinId, x: problem.pins[p].x, y: problem.pins[p].y })) })), nets: problem.nets.map((n) => ({ id: n.id, pins: n.pins.map((p) => ({ componentId: problem.pins[p].componentId, pinId: problem.pins[p].pinId })) })) }, modules));
  assert.equal(withNets.nets.length, problem.nets.length + 3);
});

test('module JSON round-trips and reports editing mistakes', async () => {
  const { exportModules, importModules } = await import('../bench/modules-json.mjs');
  const problem = clustered();
  const adapted = { origin: { x: 100, y: 50 } };
  const plan = autoModules(problem, { seed: 3 });
  plan.modules[0].region = { x: 10, y: 5, width: 20, height: 10 };
  plan.modules[1].side = 'bottom';
  const json = JSON.parse(JSON.stringify(exportModules(adapted, problem, plan, { board: 't.kicad_pcb' })));
  assert.deepEqual(json.modules[0].region, { x: 110, y: 55, width: 20, height: 10 });
  const back = importModules(json, adapted, problem);
  assert.deepEqual(back.modules.map((m) => m.members), plan.modules.map((m) => m.members));
  assert.deepEqual(back.modules[0].region, { x: 10, y: 5, width: 20, height: 10 });
  assert.equal(back.modules[1].side, 'bottom');
  assert.deepEqual(back.unassigned.sort(), plan.unassigned.sort());

  // Moving a part between modules is just editing the lists.
  const moved = JSON.parse(JSON.stringify(json));
  moved.modules[1].components.push(moved.modules[0].components.pop());
  const edited = importModules(moved, adapted, problem);
  assert.equal(edited.modules[1].members.length, plan.modules[1].members.length + 1);

  const bad = JSON.parse(JSON.stringify(json));
  bad.modules[0].components.push('NOPE', bad.modules[1].components[0]);
  bad.modules[1].side = 'left';
  bad.modules[2].region = { x: 0, y: 0, width: 5, height: 5 };
  assert.throws(() => importModules(bad, adapted, problem), (e) => /unknown component "NOPE"/.test(e.message) && /already in/.test(e.message) && /side must be/.test(e.message) && /outside the board/.test(e.message));
});
