// Placement benchmark on real KiCad boards from webgpu_pcb_placer/benchmark.
//
//   node bench/kicad-boards.mjs [--placer ../webgpu_pcb_placer] [--only name,name] [--seeds 1]
//                               [--backend cpu|gpu] [--budget same|large] [--out file.json] [--save-layouts]
//                               [--preplace] [--power] [--route] [--sides single|original|free]
//                               [--density s] [--density-target t] [--pin-area a] [--congestion w]
//                               [--legalize] [--no-lns] [--modules auto] [--quality]
//
// --preplace  fix connector/mechanical/edge footprints at their original position
// --power     pull small parts toward the nearest IC pin of their supply nets (see
//             power-edges.mjs); the global stage runs on signals first, then the
//             supply edges are assigned, refined and re-assigned before LNS
// --sides     'single' puts every footprint on one plane; 'original' keeps KiCad sides;
//             'free' lets SMD parts use either side (LNS flip moves)
// --density   long-range bin density force of strength s in the global placer (target
//             coverage t, `a` mm² routing area reserved per pin)
// --legalize  greedy overlap legalization after LNS (src/optimizer/legalizer.js)
// --modules   'auto': Louvain modules placed as soft macros first, then expanded (see
//             place-board.mjs for editable module plans)
// --quality   --preplace --power --sides free --density 3 --congestion 3 --legalize
// --route     route original and optimized placements with the two-layer PathFinder
//             router (pcb-router.mjs) and report clean nets
// Every board starts from a uniform random placement (locked footprints stay put).
// `--backend gpu` runs the global stages on GpuAnalyticalGlobalPlacer and scores LNS
// candidates with PriorityGpuBatchScorer (Dawn); `--budget large` spends the GPU headroom
// on more global starts, bigger LNS populations and more iterations. The original human
// layout is scored with the same CPU objective, and every reported score is recomputed on
// the CPU.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProblem } from '../src/problem.js';
import { PriorityCpuBatchScorer } from '../src/cpu/priority-batch-scorer.js';
import { autoModules } from '../src/optimizer/modules.js';
import { loadKicadParser, designToProblem } from './kicad-adapter.mjs';
import { parseOptions, placeBoard, routeStats, legality } from './pipeline.mjs';

const o = parseOptions(process.argv.slice(2));
const placerRoot = path.resolve(o.arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const only = o.arg('only', '')?.split(',').filter(Boolean) ?? [];
const seeds = Number(o.arg('seeds', 1));
const outFile = o.arg('out', null);
const saveLayouts = o.has('save-layouts');
if (o.modules && o.modules !== 'auto') throw new Error('kicad-boards.mjs supports --modules auto only; use place-board.mjs for module files');
const device = o.backend === 'gpu' ? await (await import('../src/node.js')).createNodeWebGpuDevice() : null;

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
  const adapt = { preplace: o.preplace, sides: o.sides };
  const adapted = designToProblem(design, adapt);
  const { originalLayout, stats } = adapted;
  const problem = normalizeProblem(adapted.input);
  const origRoute = o.route ? routeStats(adapted, originalLayout, o.routeCell, o.routeLayers) : null;

  for (let s = 0; s < seeds; s++) {
    const seed = 20260925 + 7919 * s;
    let plan = null;
    if (o.modules === 'auto') {
      plan = autoModules(problem, { resolution: o.moduleResolution, seed });
      plan.modules.forEach((m, k) => { m.side = 'auto'; m.cohesion = o.cohesion; m.name = `M${k + 1} ${problem.components[m.members[0]].id}`; });
    }
    const out = await placeBoard(adapted, o, { device, seed, plan });
    const scorer = new PriorityCpuBatchScorer(problem, out.cfg.scorerOptions);
    const orig = scorer.scoreLayout(originalLayout), origLegal = legality(problem, originalLayout);
    const start = scorer.scoreLayout(out.init);
    const fin = scorer.scoreLayout(out.layout), finLegal = legality(problem, out.layout);
    const newRoute = o.route ? routeStats(adapted, out.layout, o.routeCell, o.routeLayers) : null;
    const t = out.timing;
    // Side usage: bottom-side share and modules spread over both sides (>= 20% and >= 2 parts on the minority side).
    const bottomPct = (L) => Math.round(100 * L.filter((q, i) => (q.side ?? (adapted.sides[i] < 0 ? 1 : 0)) === 1).length / L.length);
    const mixedPct = (L) => { if (!plan) return null; const big = plan.modules.filter((m) => m.members.length >= 4); if (!big.length) return 0; return Math.round(100 * big.filter((m) => { const b = m.members.filter((i) => (L[i].side ?? 0) === 1).length, mn = Math.min(b, m.members.length - b); return mn >= Math.max(2, 0.2 * m.members.length); }).length / big.length); };
    const row = {
      case: name, backend: o.backend, budget: o.budget, mode: o.mode, n: stats.footprints, fixed: stats.locked, nets: stats.nets, density: +stats.density.toFixed(2), seed,
      'orig hpwl': Math.round(orig.hpwl), 'orig ovl': r1(orig.overlap),
      'rand hpwl': Math.round(start.hpwl),
      'hpwl': Math.round(fin.hpwl), 'hpwl/orig': +(fin.hpwl / orig.hpwl).toFixed(2),
      'ovl mm2': r1(fin.overlap), 'ovl pairs': finLegal.overlapPairs, 'bounds': +fin.bounds.toFixed(2),
      ...(plan ? { modules: plan.modules.length, 'modules s': r1(t.modulesMs / 1000) } : {}),
      backside: out.backside, 'orig bottom %': bottomPct(originalLayout), 'bottom %': bottomPct(out.layout),
      ...(plan ? { 'orig mixed %': mixedPct(originalLayout), 'mixed %': mixedPct(out.layout) } : {}),
      'global s': r1(t.globalMs / 1000), 'lns s': r1(t.fastLnsMs / 1000), 'polish s': r1(t.polishMs / 1000), 'total s': r1(t.totalMs / 1000),
      ...(out.legal ? { 'legal fail': out.legal.failed, 'legal disp': r1(out.legal.meanDisplacement) } : {}),
      ...(o.route ? { 'orig clean': `${origRoute.clean}/${origRoute.nets}`, 'clean': `${newRoute.clean}/${newRoute.nets}`, 'orig ovf': origRoute.overflow, 'ovf': newRoute.overflow } : {}),
    };
    rows.push(row);
    const moduleOf = plan ? new Array(problem.components.length).fill(-1) : null;
    plan?.modules.forEach((m, k) => m.members.forEach((i) => { moduleOf[i] = k; }));
    details.push({
      ...row, file: rel, adapt, stats, original: { score: orig, legality: origLegal }, random: start,
      result: { score: fin, legality: finLegal, globalScore: out.global.score, fastScore: out.fast.score }, config: out.cfg,
      route: o.route ? { original: origRoute, result: newRoute } : undefined,
      ...(saveLayouts ? { layouts: { original: originalLayout, random: out.init, result: out.layout } } : {}),
      ...(plan ? { moduleOf, moduleNames: plan.modules.map((m) => m.name), moduleSides: out.modules.sides } : {}),
    });
    console.error(JSON.stringify(row));
  }
}
console.table(rows);
device?.destroy();
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ date: new Date().toISOString(), node: process.version, placerRoot, rows: details }, null, 2));
