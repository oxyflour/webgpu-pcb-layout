// Shared KiCad placement pipeline used by kicad-boards.mjs (benchmark over many boards)
// and place-board.mjs (one board, with editable module JSON).
import { performance } from 'node:perf_hooks';
import { normalizeProblem, rotatedSize, sharesSide, clampToRegion } from '../src/problem.js';
import { PriorityCpuBatchScorer } from '../src/cpu/priority-batch-scorer.js';
import { PriorityGpuBatchScorer } from '../src/gpu/batch-scorer.js';
import { MultiStartGlobalPlacer } from '../src/optimizer/multistart-global.js';
import { AnalyticalGlobalPlacer } from '../src/optimizer/global-placement.js';
import { FastDeltaLnsOptimizer } from '../src/optimizer/fast-delta-lns.js';
import { GpuLnsOptimizer } from '../src/optimizer/lns.js';
import { GpuAnalyticalGlobalPlacer } from '../src/gpu/global-placer.js';
import { legalizeLayout } from '../src/optimizer/legalizer.js';
import { moduleProblem, expandModules, withModuleNets, isModuleNet, splitModuleSides, MODULE_NET_PREFIX } from '../src/optimizer/modules.js';
import { withPowerEdges, isPowerEdge } from './power-edges.mjs';
import { routeBoard } from './pcb-router.mjs';

/** Command-line options shared by the KiCad scripts (see kicad-boards.mjs for docs). */
export function parseOptions(argv, defaults = {}) {
  const args = [...argv];
  if (args.includes('--quality')) args.push('--preplace', '--power', '--legalize', '--sides', 'free', '--density', '3', '--congestion', '3');
  const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const has = (name) => args.includes(`--${name}`);
  const o = {
    args, arg, has,
    backend: arg('backend', defaults.backend ?? 'cpu'),
    budget: arg('budget', defaults.budget ?? 'same'),
    preplace: has('preplace'),
    power: has('power'),
    route: has('route'),
    routeCell: Number(arg('route-cell', 0.4)),
    // Evaluation routing layers: 'board' (the board's signal layers) or a number (e.g. 2).
    routeLayers: arg('route-layers', 'board'),
    sides: arg('sides', 'single'),
    density: Number(arg('density', 0)),
    densityTarget: Number(arg('density-target', 0.65)),
    pinArea: Number(arg('pin-area', 0.6)),
    legalize: has('legalize'),
    noLns: has('no-lns'),
    congestion: Number(arg('congestion', 0.5)),
    modules: arg('modules', null),
    cohesion: Number(arg('cohesion', 0.4)),
    moduleResolution: Number(arg('module-resolution', 1)),
    // Split modules across both sides (small parts under the ICs); --no-split disables.
    split: !has('no-split'),
    // Bottom-side cost, HPWL-mm per mm² of part area: a number or 'auto' (see backsideCost).
    backside: arg('backside', 'auto'),
    // Global iterations scale with the part count unless given; parts moved per LNS candidate.
    globalScale: arg('global-scale', null) === null ? null : Number(arg('global-scale')),
    lnsMoves: arg('lns-moves', null) === null ? null : Number(arg('lns-moves')),
  };
  o.mode = [o.preplace && 'preplace', o.power && 'power', o.sides !== 'single' && `sides-${o.sides}`, o.density > 0 && `density${o.density}`,
    o.noLns && 'nolns', o.congestion !== 0.5 && `cong${o.congestion}`, o.modules && `modules-${o.modules === 'auto' ? 'auto' : 'file'}`,
    o.modules && !o.split && 'nosplit', o.backside !== 'auto' && `backside${o.backside}`, o.legalize && 'legal'].filter(Boolean).join('+') || 'plain';
  return o;
}

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/**
 * Bottom-side cost for a board: explicit option, IR rules.backsideCost, or 'auto' =
 * single-sided (20) when the input placement has fewer than 10% of parts on the bottom.
 */
export function backsideCost(adapted, o) {
  if (o.backside !== 'auto' && o.backside !== undefined) return Number(o.backside);
  if (adapted.ir?.rules?.backsideCost !== undefined) return adapted.ir.rules.backsideCost;
  const bottom = adapted.sides.filter((s) => s < 0).length / Math.max(1, adapted.sides.length);
  return bottom < 0.1 ? 20 : 0;
}
const SINGLE_SIDED = 2; // backside costs at or above this keep free parts on top

export function randomLayout(problem, seed, backside = 0) {
  const rnd = rng32(seed);
  return problem.components.map((c) => {
    if (c.fixed) return { ...c.fixed };
    const [w, h] = rotatedSize(c, 0);
    const p = { x: w / 2 + rnd() * Math.max(0, problem.canvas.width - w), y: h / 2 + rnd() * Math.max(0, problem.canvas.height - h), rotation: 0 };
    // Free parts: ICs start on top, small parts on a random side.
    if (c.sides === 'any') p.side = c.pins.length >= 8 || backside >= SINGLE_SIDED ? 0 : rnd() < 0.5 ? 1 : 0;
    else if (c.sides === 'bottom') p.side = 1;
    return p;
  });
}

/** Same-side pairs whose bodies overlap by more than 0.01 mm², and parts outside the canvas. */
export function legality(problem, layout) {
  const n = problem.components.length, box = [];
  for (let i = 0; i < n; i++) {
    const [w, h] = rotatedSize(problem.components[i], layout[i].rotation);
    box.push([layout[i].x - w / 2, layout[i].y - h / 2, layout[i].x + w / 2, layout[i].y + h / 2]);
  }
  let pairs = 0, outside = 0; const bad = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = box[i];
    if (a[0] < -1e-6 || a[1] < -1e-6 || a[2] > problem.canvas.width + 1e-6 || a[3] > problem.canvas.height + 1e-6) outside++;
    for (let j = i + 1; j < n; j++) {
      if (!sharesSide(problem, i, layout[i], j, layout[j])) continue;
      const b = box[j];
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (ox > 0 && oy > 0 && ox * oy > 0.01) { pairs++; bad[i] = bad[j] = 1; }
    }
  }
  return { overlapPairs: pairs, overlappingComponents: bad.reduce((s, v) => s + v, 0), outside };
}

/** Optimizer budget and length scales derived from board size and footprint count. */
export function configFor(problem, seed, o) {
  const n = problem.components.length, W = problem.canvas.width, H = problem.canvas.height, L = Math.sqrt(W * H);
  const big = n > 1000, mid = n > 300;
  const gw = 40, gh = Math.max(8, Math.round(gw * H / W));
  // Two signal layers, 0.5 mm track pitch, expressed in default-priority net weights (~1.11).
  const capacity = 2 * Math.min(W / gw, H / gh) / 0.5 / 1.11;
  const scorerOptions = { weights: { hpwl: 1, overlap: 200, bounds: 200, congestion: o.congestion }, coarse: { gridWidth: gw, gridHeight: gh, capacity } };
  const approximate = { ...scorerOptions, coarse: { gridWidth: Math.ceil(gw / 2), gridHeight: Math.ceil(gh / 2), capacity: capacity * 4 } };
  const placer = {
    wireStrength: .92, densityStrength: .86, overlapStrength: 4.0, macroStrength: 7.4, boundaryStrength: 2.6,
    clearance: 0.2, macroClearance: 0.5, egressGap: 1.0, fixedAnchorBoost: 4.8, movableNetScale: .72,
    damping: .66, step: .58, maxMove: 0.012 * L, cooling: .9986,
    gridDensity: { strength: o.density, bins: 64, target: o.densityTarget, pinArea: o.pinArea },
  };
  const lnsScale = o.noLns ? 0 : 1;
  // Larger boards need more global iterations (x3 measured +90 clean nets on ppc-n3, +43 on k60).
  const globalScale = o.globalScale ?? Math.min(3, Math.max(1, Math.sqrt(n / 50)));
  if (o.budget === 'large') return {
    scorerOptions, L,
    optimizer: {
      seed, approximate,
      global: { starts: 32, coarseIterations: Math.round(150 * globalScale), finalists: 4, fineIterations: Math.round(220 * globalScale), placer }, globalScale,
      fastLns: { iterations: 400 * lnsScale, population: 1024, movesPerCandidate: o.lnsMoves ?? 2, translationScale: 0.015 * L, rotationProbability: 0.1, temperature: .025, cooling: .992 },
      polish: { iterations: 200 * lnsScale, population: 1024, movesPerCandidate: 1, translationScale: 0.008 * L, rotationProbability: 0.05, temperature: .012, cooling: .985 },
    },
  };
  return {
    scorerOptions, L,
    optimizer: {
      seed, approximate,
      global: { starts: big ? 3 : mid ? 6 : 12, coarseIterations: 150, finalists: big ? 1 : mid ? 2 : 3, fineIterations: 220, placer },
      fastLns: { iterations: 52 * lnsScale, population: big ? 64 : mid ? 128 : 256, topK: big ? 4 : 10, movesPerCandidate: 2, translationScale: 0.015 * L, rotationProbability: 0.1, temperature: .025, cooling: .975 },
      polish: { iterations: 28 * lnsScale, population: big ? 32 : mid ? 64 : 128, movesPerCandidate: 1, translationScale: 0.008 * L, rotationProbability: 0.05, temperature: .012, cooling: .965 },
    },
  };
}

const POWER_EDGE_WEIGHT = 0.25;

/**
 * Module sides. Explicit 'top'/'bottom' win. 'auto' modules stay on top unless the top
 * side is full: modules without through-hole or large ICs then move to the bottom,
 * largest first, until the top load fits its capacity.
 */
export function assignModuleSides(problem, modules, o, backside = 0) {
  const target = o.densityTarget, W = problem.canvas.width, H = problem.canvas.height;
  if (o.sides !== 'free') return modules.map((m) => ({ ...m, side: m.side === 'bottom' || (o.sides === 'original' && problem.components[m.members[0]].sides === 'bottom') ? 1 : 0 }));
  const areaOf = (i) => { const c = problem.components[i]; return c.width * c.height + o.pinArea * c.pins.length; };
  const fixedTop = problem.components.reduce((s, c, i) => s + (c.fixed && (!c.fixed.side || c.twoSided) ? areaOf(i) : 0), 0);
  let topLoad = fixedTop + modules.reduce((s, m) => s + m.members.reduce((t, i) => t + areaOf(i), 0), 0);
  // A costly bottom side is only used when a module asks for it explicitly.
  const capacity = backside >= SINGLE_SIDED ? Infinity : target * W * H;
  const out = modules.map((m) => ({ ...m, side: m.side === 'bottom' ? 1 : 0 }));
  for (const m of out) if (m.side === 1) topLoad -= m.members.reduce((t, i) => t + areaOf(i), 0);
  const movable = out.map((m, k) => k).filter((k) => {
    const m = out[k];
    return modules[k].side !== 'top' && modules[k].side !== 'bottom' && m.members.every((i) => problem.components[i].sides === 'any' && !problem.components[i].twoSided && problem.components[i].pins.length < 20);
  }).sort((a, b) => out[b].members.length - out[a].members.length);
  for (const k of movable) {
    if (topLoad <= capacity) break;
    out[k].side = 1; topLoad -= out[k].members.reduce((t, i) => t + areaOf(i), 0);
  }
  return out;
}

function scorerFor(device, problem, options) {
  return device ? new PriorityGpuBatchScorer(device, problem, options) : new PriorityCpuBatchScorer(problem, options);
}
const lowPriority = (problem) => Object.fromEntries(problem.nets.filter((n) => isPowerEdge(n.id) || isModuleNet(n.id)).map((n) => [n.id, { priority: 0 }]));
// Scorer policy: net priorities from the IR plus low-priority supply/module edges.
const policyFor = (adapted, problem) => ({ ...(adapted.policy ?? {}), ...lowPriority(problem) });
// Global-placer weight of a signal net relative to a default-priority (50) net.
const priorityWeight = (adapted, net) => { const p = adapted.policy?.[net.id]?.priority; return p === undefined ? 1 : (0.2 + p / 55) / (0.2 + 50 / 55); };

/**
 * Module-level placement: soft macros placed by the (GPU) multi-start global placer,
 * then expanded into `starts` component-level starting layouts.
 */
async function placeModules(problem, modules, o, cfg, device, seed, starts, alternatives = 4) {
  const t0 = performance.now();
  const mp = moduleProblem(problem, randomLayout(problem, seed), modules, { target: o.densityTarget, pinArea: o.pinArea });
  const p = normalizeProblem(mp.input);
  const scorer = scorerFor(device, p, cfg.scorerOptions);
  const placer = { ...cfg.optimizer.global.placer, gridDensity: { ...cfg.optimizer.global.placer.gridDensity, strength: Math.max(3, o.density), pinArea: 0 } };
  // Several module-level structures, each expanded into starts/alternatives component layouts;
  // the component-level multi-start then picks among them with the full objective.
  const gs = cfg.optimizer.globalScale ?? 1;
  const res = await new MultiStartGlobalPlacer(p, scorer, { seed: seed ^ 0x3D17, device, starts: 64, coarseIterations: Math.round(200 * gs), finalists: alternatives, fineIterations: Math.round(300 * gs), placer }).optimize();
  scorer.destroy?.();
  const order = res.fineScores.map((_, k) => k).sort((a, b) => res.fineScores[a].total - res.fineScores[b].total);
  const initials = Array.from({ length: starts }, (_, k) => expandModules(problem, mp, res.fineLayouts[order[k % order.length]], modules, seed + 101 * k));
  return { initials, moduleLayout: res.layout, moduleProblem: mp, ms: performance.now() - t0 };
}

/**
 * Full placement of an adapted board.
 * @param plan optional {modules:[{members, side:'auto'|'top'|'bottom', region?, cohesion?}]}
 */
export async function placeBoard(adapted, o, { device = null, seed = 1, plan = null } = {}) {
  let input = adapted.input;
  let problem = normalizeProblem(input);
  const cfg = configFor(problem, seed, o), g = cfg.optimizer;
  // Board IR rules.componentClearance drives the placer and legalizer spacing.
  const clearance = adapted.ir?.rules?.componentClearance;
  if (clearance !== undefined) g.global.placer.clearance = clearance;
  const backside = backsideCost(adapted, o);
  cfg.scorerOptions.weights.backside = backside; g.approximate.weights = { ...g.approximate.weights, backside };
  const init = randomLayout(problem, seed, backside);
  const timing = {};
  const t0 = performance.now();

  let initials = null, modules = null, moduleInfo = null, regions = null;
  if (plan?.modules?.length) {
    // Explicit module sides restrict the SMD members to that side.
    if (o.sides === 'free') {
      input = { ...input, components: input.components.map((c) => ({ ...c })) };
      for (const m of plan.modules) if (m.side === 'top' || m.side === 'bottom') for (const i of m.members) if (input.components[i].sides === 'any') input.components[i].sides = m.side;
      problem = normalizeProblem(input);
    }
    modules = assignModuleSides(problem, plan.modules, o, backside);
    // Small parts under the ICs on the opposite side, unless the bottom side is costly or
    // the module's side was set explicitly.
    if (o.split && o.sides === 'free' && backside < SINGLE_SIDED) {
      modules = modules.map((m, k) => plan.modules[k].side === 'top' || plan.modules[k].side === 'bottom' ? m : { ...m, memberSide: splitModuleSides(problem, m) });
    }
    const placed = await placeModules(problem, modules, o, cfg, device, seed, 8);
    initials = placed.initials; moduleInfo = { sides: modules.map((m) => m.side), layout: placed.moduleLayout, ms: placed.ms };
    input = withModuleNets(input, modules);
    timing.modulesMs = placed.ms;
    // Members of a module with a region must stay inside it in every later stage.
    if (modules.some((m) => m.region)) {
      regions = new Array(problem.components.length).fill(null);
      for (const m of modules) if (m.region) for (const i of m.members) regions[i] = m.region;
    }
  }
  const cohesion = (net) => { const k = Number(net.id.slice(MODULE_NET_PREFIX.length)); return (plan.modules[k].cohesion ?? o.cohesion) * Math.max(1, net.pins.length - 1); };
  const placer = { ...g.global.placer, netWeight: (net) => isPowerEdge(net.id) ? POWER_EDGE_WEIGHT : isModuleNet(net.id) ? cohesion(net) : priorityWeight(adapted, net) };

  // Stage A: multi-start global placement (signals + module cohesion).
  const tA = performance.now();
  const p0 = normalizeProblem(input);
  const scorer0 = scorerFor(device, p0, { ...cfg.scorerOptions, policy: policyFor(adapted, p0) });
  const global = await new MultiStartGlobalPlacer(p0, scorer0, { seed: seed ^ 0xA511, device, ...g.global, placer, initials }).optimize(init);
  scorer0.destroy?.();
  const project = (l) => regions ? l.map((p, i) => regions[i] ? (([x, y]) => ({ ...p, x, y }))(clampToRegion(problem.components[i], p, regions[i])) : p) : l;
  let layout = project(global.layout);

  // Stage B: supply edges assigned from stage A and refined.
  if (o.power) {
    const p1 = normalizeProblem(withPowerEdges(input, adapted.power, layout));
    if (device) { const gp = new GpuAnalyticalGlobalPlacer(device, p1, placer); [layout] = await gp.optimizeBatch([layout], g.global.fineIterations); gp.destroy(); }
    else layout = (await new AnalyticalGlobalPlacer(p1, { ...placer, iterations: g.global.fineIterations, recordEvery: 1e9 }).optimize(layout)).layout;
    layout = project(layout);
  }
  timing.globalMs = performance.now() - tA;

  // Stage C: LNS + polish (supply edges re-assigned once more).
  const tC = performance.now();
  const p2 = o.power ? normalizeProblem(withPowerEdges(input, adapted.power, layout)) : p0;
  const scorerOptions = { ...cfg.scorerOptions, policy: policyFor(adapted, p2) };
  const scorer = scorerFor(device, p2, scorerOptions);
  const fast = await new FastDeltaLnsOptimizer(p2, scorer, { seed: seed ^ 0x51A2, approximate: { ...g.approximate, policy: scorerOptions.policy }, ...g.fastLns, regions }).optimize(layout);
  timing.fastLnsMs = performance.now() - tC;
  const tP = performance.now();
  const polish = await new GpuLnsOptimizer(p2, scorer, { seed: seed ^ 0x9E37, ...g.polish, regions }).optimize(fast.layout);
  timing.polishMs = performance.now() - tP;
  scorer.destroy?.();
  layout = polish.layout;

  let legal = null;
  if (o.legalize) { const tl = performance.now(); legal = legalizeLayout(problem, layout, { clearance: clearance ?? 0.1, regions }); layout = legal.layout; timing.legalizeMs = performance.now() - tl; }
  timing.totalMs = performance.now() - t0;
  return { layout, init, cfg, timing, global, fast, legal, modules: moduleInfo, backside };
}

export function routeStats(adapted, layout, cell = 0.4, layers = 'board') {
  const t = performance.now();
  const board = layers === 'board' ? adapted.routing : { ...adapted.routing, layers: Number(layers) };
  const r = routeBoard(board, layout, adapted.sides, { cell });
  return { layers: r.grid.layers, nets: r.nets, clean: r.clean, complete: r.complete, overflow: r.overflow, vias: r.vias, length: Math.round(r.length), rounds: r.rounds, ms: performance.now() - t };
}
