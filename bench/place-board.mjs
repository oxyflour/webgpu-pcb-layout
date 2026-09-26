// Place one board (KiCad .kicad_pcb or Board IR .board.json, see docs/board-ir.md),
// optionally with an editable module plan.
//
//   # 1. automatic modules: place, write the plan and an HTML report
//   node bench/place-board.mjs board.kicad_pcb --modules auto --export-modules board.modules.json --render board.html
//   # 2. edit board.modules.json (move references between modules, set side/region/cohesion)
//   # 3. re-run with the edited plan
//   node bench/place-board.mjs board.kicad_pcb --modules board.modules.json --render board.html
//
// Defaults to the tuned setup (--quality, GPU backend, large budget); pass --plain to
// disable the quality options, and any kicad-boards.mjs option to override them.
// Other options:
//   --modules auto|<file>   module plan (none by default)
//   --export-modules <file> write the plan that was used (auto or edited) as JSON
//   --module-resolution r   Louvain resolution for --modules auto (higher = smaller modules)
//   --cohesion c            default pull toward the module centroid
//   --out <file>            result JSON (layouts, scores, timings)
//   --placement <file>      placement@1 result (footprint anchors in the input's coordinates)
//   --render <file>         HTML report with routed original/optimized placements and module maps
//   --seed n                random seed
//   --placer <dir>          webgpu_pcb_placer checkout (for its KiCad parser)
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProblem } from '../src/problem.js';
import { PriorityCpuBatchScorer } from '../src/cpu/priority-batch-scorer.js';
import { autoModules } from '../src/optimizer/modules.js';
import { loadKicadParser, designToProblem } from './kicad-adapter.mjs';
import { irToProblem, placementResult } from '../src/ir/to-problem.js';
import { assertValidBoardIR } from '../src/ir/validate.js';
import { parseOptions, placeBoard, routeStats, legality } from './pipeline.mjs';
import { exportModules, importModules } from './modules-json.mjs';
import { renderReport } from './render-kicad.mjs';

const argv = process.argv.slice(2);
const file = argv.find((a) => a.endsWith('.kicad_pcb') || a.endsWith('.board.json'));
if (!file) { console.error('usage: node bench/place-board.mjs <board.kicad_pcb | board.board.json> [--modules auto|plan.json] [--export-modules plan.json] [--render report.html] [--placement result.json]'); process.exit(2); }
const isIR = file.endsWith('.board.json');
const o = parseOptions(argv.includes('--plain') ? argv : ['--quality', ...argv], { backend: 'gpu', budget: 'large' });
const placerRoot = path.resolve(o.arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const seed = Number(o.arg('seed', 20260925));
const device = o.backend === 'gpu' ? await (await import('../src/node.js')).createNodeWebGpuDevice() : null;

const text = fs.readFileSync(file, 'utf8');
const adapt = { preplace: o.preplace, sides: o.sides };
let adapted;
if (isIR) {
  const ir = JSON.parse(text);
  for (const w of assertValidBoardIR(ir)) console.error(`warning: ${w}`);
  adapted = irToProblem(ir, { preplace: o.preplace, sides: o.sides === 'free' ? 'ir' : o.sides });
} else {
  adapted = designToProblem((await loadKicadParser(placerRoot))(text, path.basename(file)), adapt);
}
const problem = normalizeProblem(adapted.input);
// The input placement is only a reference when every footprint has one.
const hasOriginal = adapted.originalLayout.every(Boolean);

let plan = null, generatedBy = null;
if (o.modules === 'auto') {
  plan = autoModules(problem, { resolution: o.moduleResolution, seed });
  plan.modules.forEach((m) => { m.side = 'auto'; m.cohesion = o.cohesion; });
  generatedBy = { method: 'louvain', resolution: o.moduleResolution, seed };
} else if (o.modules === 'ir' || (!o.modules && adapted.plan)) {
  plan = adapted.plan;
  generatedBy = { method: 'board IR modules' };
} else if (o.modules) {
  plan = importModules(JSON.parse(fs.readFileSync(o.modules, 'utf8')), adapted, problem);
  generatedBy = { method: 'file', file: path.resolve(o.modules) };
}
if (plan) {
  const ids = problem.components.map((c) => c.id);
  console.error(`modules: ${plan.modules.length} (${plan.modules.reduce((s, m) => s + m.members.length, 0)} parts), placed individually: ${plan.unassigned.length} parts`);
  plan.modules.forEach((m, k) => { m.name ??= `M${k + 1} ${ids[m.members[0]]}`; });
}

const out = await placeBoard(adapted, o, { device, seed, plan });
device?.destroy();

const cfg = out.cfg;
const scorer = new PriorityCpuBatchScorer(problem, cfg.scorerOptions);
const orig = hasOriginal ? scorer.scoreLayout(adapted.originalLayout) : null, fin = scorer.scoreLayout(out.layout);
const origRoute = hasOriginal ? routeStats(adapted, adapted.originalLayout, o.routeCell, o.routeLayers) : null, newRoute = routeStats(adapted, out.layout, o.routeCell, o.routeLayers);
const legal = legality(problem, out.layout);

if (plan && o.arg('export-modules', null)) {
  const exported = exportModules(adapted, problem, plan, { board: path.basename(file), generatedBy, cohesion: o.cohesion });
  // Report the side each 'auto' module actually got.
  exported.modules.forEach((m, k) => { m.info.resolvedSide = out.modules.sides[k] ? 'bottom' : 'top'; });
  fs.writeFileSync(o.arg('export-modules'), JSON.stringify(exported, null, 2));
  console.error(`wrote module plan ${o.arg('export-modules')}`);
}

const t = out.timing, s = (ms) => ms === undefined ? '—' : (ms / 1000).toFixed(1);
console.log(`\n${path.basename(file)}: ${problem.components.length} footprints, ${problem.nets.length} signal nets, mode ${o.mode}`);
const summary = (score, route, pairs) => ({ 'HPWL signal nets (mm)': Math.round(score.hpwl), 'Clean two-layer nets (count)': `${route.clean} / ${route.nets}`, 'Cells shared by nets (count)': route.overflow, 'Vias (count)': route.vias, 'Overlapping part pairs (count)': pairs });
console.table({
  ...(hasOriginal ? { 'Input placement': summary(orig, origRoute, legality(problem, adapted.originalLayout).overlapPairs) } : {}),
  'Optimized placement': summary(fin, newRoute, legal.overlapPairs),
});
console.log(`time (s): modules ${s(t.modulesMs)}, global ${s(t.globalMs)}, LNS ${s(t.fastLnsMs)}, polish ${s(t.polishMs)}, legalize ${s(t.legalizeMs)}, total ${s(t.totalMs)}`);

const moduleOf = plan ? new Array(problem.components.length).fill(-1) : null;
plan?.modules.forEach((m, k) => m.members.forEach((i) => { moduleOf[i] = k; }));
if (o.arg('placement', null)) {
  const result = placementResult(adapted, out.layout, {
    modules: plan?.modules.map((m, k) => ({ id: m.id ?? `M${k + 1}`, name: m.name, footprints: m.members.map((i) => problem.components[i].id), side: out.modules?.sides[k] ? 'bottom' : 'top', cohesion: m.cohesion ?? o.cohesion })),
    metrics: { hpwl_mm: +fin.hpwl.toFixed(1), overlappingPairs: legal.overlapPairs, cleanNets: newRoute.clean, routedNetsTotal: newRoute.nets, runtime_s: +(t.totalMs / 1000).toFixed(2) },
  });
  fs.writeFileSync(o.arg('placement'), JSON.stringify(result, null, 2));
  console.error(`wrote placement ${o.arg('placement')}`);
}
const row = {
  case: path.basename(file).replace(/\.(kicad_pcb|board\.json)$/, ''), file: path.resolve(file), adapt, isIR, backend: o.backend, budget: o.budget, mode: o.mode, n: problem.components.length, seed,
  'total s': +(t.totalMs / 1000).toFixed(1), original: hasOriginal ? { score: orig, route: origRoute } : null, result: { score: fin, route: newRoute, legality: legal }, timing: t,
  layouts: { original: hasOriginal ? adapted.originalLayout : null, result: out.layout },
  ...(plan ? { moduleOf, moduleNames: plan.modules.map((m) => m.name), moduleSides: out.modules?.sides } : {}),
};
const run = { date: new Date().toISOString(), placerRoot, rows: [row] };
if (o.arg('out', null)) fs.writeFileSync(o.arg('out'), JSON.stringify(run, null, 2));
if (o.arg('render', null)) await renderReport(run, { out: o.arg('render'), cell: o.routeCell });
