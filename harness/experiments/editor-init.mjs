// Whole-board layout of the interactive editor (ui/editor-worker.js load, mode 'auto') with and
// without the tool start layout (lib/start-layout.mjs) as the single global-stage start.
// Same problem as the editor (irToProblem preplace, sides 'ir'; through-hole parts not pinned) and
// the editor's options (--quality --modules auto --cohesion 3, budget same); routing as everywhere
// else (evaluateRobust, exact native router).
// node harness/experiments/editor-init.mjs [--boards a,b] [--seeds 1,2,3] [--out DIR] [--phase place|evaluate|report]
import fs from 'node:fs';
import path from 'node:path';
import { BOARDS, loadBoard, evaluateRobust, exactRouting, placementMetrics } from '../lib/board.mjs';
import { startLayout } from '../lib/init.mjs';

const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const phase = arg('phase', 'report'), out = path.resolve(arg('out', 'harness/results/editor-init'));
const boards = arg('boards', Object.keys(BOARDS).filter((n) => !n.startsWith('ppc')).join(',')).split(',');
const seeds = arg('seeds', '1,2,3').split(',').map(Number), VARIANTS = ['editor', 'editor+init'];
const file = (board, seed, v) => path.join(out, `${board}-${seed}-${v}.json`);
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
fs.mkdirSync(out, { recursive: true });

async function place() {
  // GPU path: needs the optional npm package webgpu (loaded only for the placement step).
  const { irToProblem } = await import('../../core/src/ir/to-problem.js'), { normalizeProblem } = await import('../../core/src/problem.js');
  const { autoModules } = await import('../../core/src/optimizer/modules.js'), { parseOptions, placeBoard } = await import('../../core/bench/pipeline.mjs');
  const { createNodeWebGpuDevice } = await import('../../core/src/node.js');
  const device = await createNodeWebGpuDevice();
  for (const board of boards) {
    const ir = loadBoard(board).a.ir, adapted = irToProblem(ir, { preplace: true, sides: 'ir' }), problem = normalizeProblem(adapted.input);
    for (const seed of seeds) for (const v of VARIANTS) {
      if (fs.existsSync(file(board, seed, v))) continue;
      // Exactly the worker's 'auto' branch.
      const o = parseOptions(['--quality', '--modules', 'auto', '--cohesion', '3'], { backend: 'gpu', budget: 'same' });
      const plan = autoModules(problem, { resolution: o.moduleResolution, seed });
      plan.modules.forEach((m) => { m.side = 'auto'; m.cohesion = o.cohesion; });
      const t0 = performance.now();
      const init = v === 'editor+init' ? startLayout({ p: problem, a: { ...adapted, ir } }, {}, { seed }) : null;
      const r = await placeBoard(adapted, o, { device, seed, plan, ...(init ? { initLayout: init, initMode: 'global' } : {}) });
      const s = (performance.now() - t0) / 1000;
      fs.writeFileSync(file(board, seed, v), JSON.stringify({ board, seed, variant: v, placementS: s, layout: r.layout }));
      log(`${board}/${seed} ${v} ${s.toFixed(1)} s`);
    }
  }
}

async function evaluate() {
  for (const board of boards) {
    const b = loadBoard(board);
    for (const seed of seeds) for (const v of VARIANTS) {
      const f = file(board, seed, v), d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (d.metrics) continue;
      // The editor output is already legalized by its own pipeline: route it as it is.
      const m = await evaluateRobust(b, d.layout, exactRouting()); delete m.perNet;
      d.metrics = { ...m, overlaps: placementMetrics(b, d.layout).geometry.overlaps };
      fs.writeFileSync(f, JSON.stringify(d));
      log(`${board}/${seed} ${v}: ${m.clean}/${m.nets} clean, ${m.vias} vias, HPWL ${m.hpwlMm} mm, overlaps ${d.metrics.overlaps}`);
    }
  }
}

function report() {
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
  const lines = ['| Board | Editor whole-board layout, median of 3 seeds: clean nets / vias / HPWL (mm) | Editor + tool start layout, median of 3 seeds: clean nets / vias / HPWL (mm) | Editor: placement time, median (s) | Editor + tool start layout: placement time, median (s) | Editor + tool start layout better on clean / vias / HPWL (seeds, of 3) |', '|---|---|---|---|---|---|'];
  for (const board of boards) {
    const get = (v) => seeds.map((seed) => JSON.parse(fs.readFileSync(file(board, seed, v), 'utf8')));
    const [a, c] = VARIANTS.map(get);
    const trio = (x) => `${med(x.map((d) => d.metrics.clean))}/${x[0].metrics.nets} / ${med(x.map((d) => d.metrics.vias))} / ${Math.round(med(x.map((d) => d.metrics.hpwlMm)))}`;
    const better = (k, sign) => seeds.filter((_, i) => sign * (c[i].metrics[k] - a[i].metrics[k]) > 0).length;
    lines.push(`| ${board} | ${trio(a)} | ${trio(c)} | ${med(a.map((d) => d.placementS)).toFixed(1)} | ${med(c.map((d) => d.placementS)).toFixed(1)} | ${better('clean', 1)} / ${better('vias', -1)} / ${better('hpwlMm', -1)} |`);
  }
  const text = lines.join('\n');
  fs.writeFileSync(path.join(out, 'summary.md'), text + '\n');
  console.log(text);
}

const phases = { place, evaluate, report };
if (!phases[phase]) throw new Error(`Unknown phase ${phase}`);
await phases[phase]();
process.exit(0);
