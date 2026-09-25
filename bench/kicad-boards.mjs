// Placement benchmark on real KiCad boards from webgpu_pcb_placer/benchmark.
//
//   node bench/kicad-boards.mjs [--placer ../webgpu_pcb_placer] [--only name,name] [--seeds 1]
//                               [--backend cpu|gpu] [--budget same|large] [--out file.json] [--save-layouts]
//                               [--preplace] [--power] [--route]
//
// --preplace  fix connector/mechanical/edge footprints at their original position
// --power     pull small parts toward the nearest IC pin of their supply nets (see
//             power-edges.mjs); the global stage runs on signals first, then the
//             supply edges are assigned, refined and re-assigned before LNS
// --route     route original and optimized placements with the two-layer PathFinder
//             router (pcb-router.mjs) and report clean nets
// Every board starts from a uniform random placement (locked footprints stay put) and is
// optimized with HighPerformancePlacementOptimizer. `--backend gpu` runs the multi-start
// global stage on GpuAnalyticalGlobalPlacer and scores LNS candidates with
// PriorityGpuBatchScorer (Dawn); `--budget large` spends the GPU headroom on more global
// starts, bigger LNS populations and more iterations. The original human layout is scored with the same
// CPU objective as a reference point, and every reported score is recomputed on the CPU.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { normalizeProblem, rotatedSize } from '../src/problem.js';
import { PriorityCpuBatchScorer } from '../src/cpu/priority-batch-scorer.js';
import { HighPerformancePlacementOptimizer } from '../src/optimizer/high-performance-placement.js';
import { PriorityGpuBatchScorer } from '../src/gpu/batch-scorer.js';
import { MultiStartGlobalPlacer } from '../src/optimizer/multistart-global.js';
import { AnalyticalGlobalPlacer } from '../src/optimizer/global-placement.js';
import { FastDeltaLnsOptimizer } from '../src/optimizer/fast-delta-lns.js';
import { GpuLnsOptimizer } from '../src/optimizer/lns.js';
import { GpuAnalyticalGlobalPlacer } from '../src/gpu/global-placer.js';
import { loadKicadParser, designToProblem } from './kicad-adapter.mjs';
import { withPowerEdges, isPowerEdge } from './power-edges.mjs';
import { routeBoard } from './pcb-router.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const placerRoot = path.resolve(arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const only = arg('only', '')?.split(',').filter(Boolean) ?? [];
const seeds = Number(arg('seeds', 1));
const outFile = arg('out', null);
const saveLayouts = args.includes('--save-layouts');
const backend = arg('backend', 'cpu');
const budget = arg('budget', 'same');
const preplace = args.includes('--preplace');
const powerMode = args.includes('--power');
const routeEval = args.includes('--route');
const routeCell = Number(arg('route-cell', 0.4));
const mode = [preplace && 'preplace', powerMode && 'power'].filter(Boolean).join('+') || 'plain';
const device = backend === 'gpu' ? await (await import('../src/node.js')).createNodeWebGpuDevice() : null;

const CIAA = 'benchmark/ciaa-Hardware/PCB';
const PPC = 'benchmark/powerpc-laptop-mobo/KiCAD/openPPCnotebook';
const CASES = [
  ['z3r0', `${CIAA}/Z3R0/ciaa-z3r0.kicad_pcb`],
  ['pico', `${CIAA}/pico/picociaa.kicad_pcb`],
  ['edk', `${CIAA}/EDU-INTEL/edk.kicad_pcb`],
  ['edu-fpga', `${CIAA}/EDU-FPGA/Schematic/FPGA para todos.kicad_pcb`],
  ['fsl-mini', `${CIAA}/FSL-MINI/CIAA_FSL_MINI.kicad_pcb`],
  ['edu-k60', `${CIAA}/EDU-FSL/EDU_CIAA_K60/EDU_CIAA_K60.kicad_pcb`],
  ['edu-nxp', `${CIAA}/EDU-NXP/edu-ciaa-nxp.kicad_pcb`],
  ['safety', `${CIAA}/Safety/CIAA_Safety_VTI_1.0.kicad_pcb`],
  ['pic', `${CIAA}/PIC/ciaa-pic.kicad_pcb`],
  ['nxp', `${CIAA}/NXP/ciaa-nxp.kicad_pcb`],
  ['rx', `${CIAA}/RX/hw/ciaa-rx.kicad_pcb`],
  ['k60', `${CIAA}/FSL/CIAA_K60/CIAA_K60.kicad_pcb`],
  ['acc', `${CIAA}/ACC/CIAA_ACC/ciaa_acc.kicad_pcb`],
  ['ppc-n3', `${PPC}/Mas100n3 ACB_0001_2.kicad_pcb`],
  ['ppc-n1', `${PPC}/Mas100n1 ACUBE_PORTABILE R_0.kicad_pcb`],
];

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

function randomLayout(problem, seed) {
  const rnd = rng32(seed);
  return problem.components.map((c) => {
    if (c.fixed) return { ...c.fixed };
    const [w, h] = rotatedSize(c, 0);
    return { x: w / 2 + rnd() * Math.max(0, problem.canvas.width - w), y: h / 2 + rnd() * Math.max(0, problem.canvas.height - h), rotation: 0 };
  });
}

/** Pairs whose bodies overlap by more than 0.01 mm², and components sticking out of the canvas. */
function legality(problem, layout) {
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
      const b = box[j];
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (ox > 0 && oy > 0 && ox * oy > 0.01) { pairs++; bad[i] = bad[j] = 1; }
    }
  }
  return { overlapPairs: pairs, overlappingComponents: bad.reduce((s, v) => s + v, 0), outside };
}

/** Optimizer budget and length scales derived from board size and footprint count. */
function configFor(problem, seed, budget) {
  const n = problem.components.length, W = problem.canvas.width, H = problem.canvas.height, L = Math.sqrt(W * H);
  const big = n > 1000, mid = n > 300;
  const gw = 40, gh = Math.max(8, Math.round(gw * H / W));
  // Two signal layers, 0.5 mm track pitch, expressed in default-priority net weights (~1.11).
  const capacity = 2 * Math.min(W / gw, H / gh) / 0.5 / 1.11;
  const scorerOptions = { weights: { hpwl: 1, overlap: 200, bounds: 200, congestion: 0.5 }, coarse: { gridWidth: gw, gridHeight: gh, capacity } };
  const approximate = { ...scorerOptions, coarse: { gridWidth: Math.ceil(gw / 2), gridHeight: Math.ceil(gh / 2), capacity: capacity * 4 } };
  const placer = {
    wireStrength: .92, densityStrength: .86, overlapStrength: 4.0, macroStrength: 7.4, boundaryStrength: 2.6,
    clearance: 0.2, macroClearance: 0.5, egressGap: 1.0, fixedAnchorBoost: 4.8, movableNetScale: .72,
    damping: .66, step: .58, maxMove: 0.012 * L, cooling: .9986,
  };
  if (budget === 'large') return {
    scorerOptions,
    optimizer: {
      seed,
      approximate,
      global: { starts: 32, coarseIterations: 150, finalists: 4, fineIterations: 220, placer },
      fastLns: { iterations: 400, population: 1024, movesPerCandidate: 2, translationScale: 0.015 * L, rotationProbability: 0.1, temperature: .025, cooling: .992 },
      polish: { iterations: 200, population: 1024, movesPerCandidate: 1, translationScale: 0.008 * L, rotationProbability: 0.05, temperature: .012, cooling: .985 },
    },
  };
  return {
    scorerOptions,
    optimizer: {
      seed,
      approximate,
      global: { starts: big ? 3 : mid ? 6 : 12, coarseIterations: 150, finalists: big ? 1 : mid ? 2 : 3, fineIterations: 220, placer },
      fastLns: { iterations: 52, population: big ? 64 : mid ? 128 : 256, topK: big ? 4 : 10, movesPerCandidate: 2, translationScale: 0.015 * L, rotationProbability: 0.1, temperature: .025, cooling: .975 },
      polish: { iterations: 28, population: big ? 32 : mid ? 64 : 128, movesPerCandidate: 1, translationScale: 0.008 * L, rotationProbability: 0.05, temperature: .012, cooling: .965 },
    },
  };
}

const POWER_EDGE_WEIGHT = 0.25;
const policyFor = (problem) => Object.fromEntries(problem.nets.filter((n) => isPowerEdge(n.id)).map((n) => [n.id, { priority: 0 }]));

/**
 * Staged pipeline with supply edges: signal-only multi-start global placement, supply
 * edges assigned from that result and refined by another global pass, then re-assigned
 * once more for LNS + polish. Component order never changes, so layouts carry over.
 */
async function placeWithPower(adapted, init, cfg) {
  const o = cfg.optimizer, placer = { ...o.global.placer, netWeight: (net) => isPowerEdge(net.id) ? POWER_EDGE_WEIGHT : 1 };
  const t0 = performance.now();
  const p0 = normalizeProblem(adapted.input);
  const scorer0 = device ? new PriorityGpuBatchScorer(device, p0, cfg.scorerOptions) : new PriorityCpuBatchScorer(p0, cfg.scorerOptions);
  const global = await new MultiStartGlobalPlacer(p0, scorer0, { seed: o.seed ^ 0xA511, device, ...o.global }).optimize(init);
  scorer0.destroy?.();
  const p1 = normalizeProblem(withPowerEdges(adapted.input, adapted.power, global.layout));
  let refined;
  if (device) { const g = new GpuAnalyticalGlobalPlacer(device, p1, placer); [refined] = await g.optimizeBatch([global.layout], o.global.fineIterations); g.destroy(); }
  else refined = (await new AnalyticalGlobalPlacer(p1, { ...placer, iterations: o.global.fineIterations, recordEvery: 1e9 }).optimize(global.layout)).layout;
  const t1 = performance.now();
  const p2 = normalizeProblem(withPowerEdges(adapted.input, adapted.power, refined));
  const scorerOptions = { ...cfg.scorerOptions, policy: policyFor(p2) };
  const scorer = device ? new PriorityGpuBatchScorer(device, p2, scorerOptions) : new PriorityCpuBatchScorer(p2, scorerOptions);
  const fast = await new FastDeltaLnsOptimizer(p2, scorer, { seed: o.seed ^ 0x51A2, approximate: { ...o.approximate, policy: scorerOptions.policy }, ...o.fastLns }).optimize(refined);
  const t2 = performance.now();
  const polish = await new GpuLnsOptimizer(p2, scorer, { seed: o.seed ^ 0x9E37, ...o.polish }).optimize(fast.layout);
  const t3 = performance.now();
  scorer.destroy?.();
  return { layout: polish.layout, score: polish.score, global, fast, timing: { globalMs: t1 - t0, fastLnsMs: t2 - t1, polishMs: t3 - t2 } };
}

function routeStats(adapted, layout) {
  const t = performance.now();
  const r = routeBoard(adapted.routing, layout, adapted.sides, { cell: routeCell });
  return { nets: r.nets, clean: r.clean, complete: r.complete, overflow: r.overflow, vias: r.vias, length: Math.round(r.length), rounds: r.rounds, ms: performance.now() - t };
}

const r1 = (v) => +v.toFixed(1);
const parse = await loadKicadParser(placerRoot);
const rows = [], details = [];
for (const [name, rel] of CASES) {
  if (only.length && !only.includes(name)) continue;
  const file = path.join(placerRoot, rel);
  if (!fs.existsSync(file)) { console.error(`skip ${name}: ${file} not found`); continue; }
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('(footprint') && !text.includes('(module')) { console.error(`skip ${name}: no footprints (LFS stub?)`); continue; }
  const design = parse(text, path.basename(file));
  const adapted = designToProblem(design, { preplace });
  const { input, originalLayout, stats } = adapted;
  const problem = normalizeProblem(input);
  const origRoute = routeEval ? routeStats(adapted, originalLayout) : null;

  for (let s = 0; s < seeds; s++) {
    const seed = 20260925 + 7919 * s;
    const cfg = configFor(problem, seed, budget);
    const scorer = new PriorityCpuBatchScorer(problem, cfg.scorerOptions);
    const searchScorer = device ? new PriorityGpuBatchScorer(device, problem, cfg.scorerOptions) : scorer;
    const orig = scorer.scoreLayout(originalLayout), origLegal = legality(problem, originalLayout);
    const init = randomLayout(problem, seed);
    const start = scorer.scoreLayout(init);
    const t0 = performance.now();
    const out = powerMode
      ? await placeWithPower(adapted, init, cfg)
      : await new HighPerformancePlacementOptimizer(problem, searchScorer, { ...cfg.optimizer, device }).optimize(init);
    const wall = performance.now() - t0;
    if (searchScorer !== scorer) searchScorer.destroy();
    const fin = scorer.scoreLayout(out.layout), finLegal = legality(problem, out.layout);
    const newRoute = routeEval ? routeStats(adapted, out.layout) : null;
    const row = {
      case: name, backend, budget, mode, n: stats.footprints, fixed: stats.locked, nets: stats.nets, density: +stats.density.toFixed(2), seed,
      'orig hpwl': Math.round(orig.hpwl), 'orig ovl': r1(orig.overlap),
      'rand hpwl': Math.round(start.hpwl),
      'hpwl': Math.round(fin.hpwl), 'hpwl/orig': +(fin.hpwl / orig.hpwl).toFixed(2),
      'ovl mm2': r1(fin.overlap), 'ovl pairs': finLegal.overlapPairs, 'bounds': +fin.bounds.toFixed(2),
      'global s': r1(out.timing.globalMs / 1000), 'lns s': r1(out.timing.fastLnsMs / 1000), 'polish s': r1(out.timing.polishMs / 1000), 'total s': r1(wall / 1000),
      ...(routeEval ? { 'orig clean': `${origRoute.clean}/${origRoute.nets}`, 'clean': `${newRoute.clean}/${newRoute.nets}`, 'orig ovf': origRoute.overflow, 'ovf': newRoute.overflow } : {}),
    };
    rows.push(row);
    details.push({ ...row, file: rel, stats, original: { score: orig, legality: origLegal }, random: start, result: { score: fin, searchScore: out.score, legality: finLegal, globalScore: out.global.score, fastScore: out.fast.score }, config: cfg, route: routeEval ? { original: origRoute, result: newRoute } : undefined, ...(saveLayouts ? { layouts: { original: originalLayout, random: init, result: out.layout } } : {}) });
    console.error(JSON.stringify(row));
  }
}
console.table(rows);
device?.destroy();
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), node: process.version, placerRoot, rows: details }, null, 2));
