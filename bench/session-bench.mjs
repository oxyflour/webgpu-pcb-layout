// Interactive session benchmark: drag-and-relayout and module re-placement within a time budget.
//
//   node bench/session-bench.mjs [--only edk,safety] [--budgets 50,100,200] [--drags 20]
//
// Starting from the human placement: "drag" moves a random module part by 3-8 mm, locks
// it and re-places the nearest parts of its module; "redo" scatters a whole module
// (up to 60 parts) and re-places it. Reports wall time and what the re-placement left behind.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProblem, rotatedSize } from '../src/problem.js';
import { PlacementSession } from '../src/session.js';
import { loadKicadParser, designToProblem } from './kicad-adapter.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const placerRoot = path.resolve(arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const only = arg('only', 'edk,safety,pic,nxp,k60,ppc-n1').split(',');
const budgets = arg('budgets', '50,100,200').split(',').map(Number);
const drags = Number(arg('drags', 20));
const FILES = {
  edk: 'ciaa-Hardware/PCB/EDU-INTEL/edk.kicad_pcb', safety: 'ciaa-Hardware/PCB/Safety/CIAA_Safety_VTI_1.0.kicad_pcb',
  pic: 'ciaa-Hardware/PCB/PIC/ciaa-pic.kicad_pcb', nxp: 'ciaa-Hardware/PCB/NXP/ciaa-nxp.kicad_pcb', k60: 'ciaa-Hardware/PCB/FSL/CIAA_K60/CIAA_K60.kicad_pcb',
  'ppc-n1': 'powerpc-laptop-mobo/KiCAD/openPPCnotebook/Mas100n1 ACUBE_PORTABILE R_0.kicad_pcb',
};
const device = await (await import('../src/node.js')).createNodeWebGpuDevice();
function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const parse = await loadKicadParser(placerRoot);
const rows = [];
for (const name of only) {
  const text = fs.readFileSync(path.join(placerRoot, 'benchmark', FILES[name]), 'utf8');
  const adapted = designToProblem(parse(text, name), { sides: 'free', preplace: true });
  const problem = normalizeProblem(adapted.input);
  const tc = performance.now();
  const session = await PlacementSession.create(problem, adapted.originalLayout, { device });
  const createMs = performance.now() - tc;
  const candidates = session.modules.flatMap((m) => m.members).filter((i) => !problem.components[i].fixed);
  for (const budget of budgets) {
    for (const mode of ['drag', 'redo']) {
      const rnd = rng32(7), times = [], newOverlaps = [], hpwlRatio = [], parts = [];
      const n = mode === 'drag' ? drags : Math.min(drags, session.modules.length);
      for (let k = 0; k < n; k++) {
        const s = new PlacementSession(problem, adapted.originalLayout, { device, modules: session.modules });
        let r;
        if (mode === 'drag') {
          const i = candidates[Math.floor(rnd() * candidates.length)], p = s.layout[i], [w, h] = rotatedSize(problem.components[i], p.rotation);
          const a = rnd() * 2 * Math.PI, d = 3 + 5 * rnd();
          const x = Math.min(problem.canvas.width - w / 2, Math.max(w / 2, p.x + d * Math.cos(a))), y = Math.min(problem.canvas.height - h / 2, Math.max(h / 2, p.y + d * Math.sin(a)));
          s.move(i, { x, y }); s.lock([i]);
          r = await s.relayout({ around: i, budgetMs: budget, seed: k + 1 });
        } else {
          const m = session.modules[k % session.modules.length];
          r = await s.relayout({ members: m.members.slice(0, 60), budgetMs: budget, scatter: true, seed: k + 1 });
        }
        if (!r.changed.length) continue;
        if (args.includes('--debug') && r.timing.totalMs > budget + 20) console.error('slow', name, mode, Math.round(r.timing.totalMs), JSON.stringify(r.attempts.map((x) => Object.fromEntries(Object.entries(x).map(([k2, v]) => [k2, typeof v === 'number' ? Math.round(v) : v])))));
        times.push(r.timing.totalMs); parts.push(r.changed.length);
        newOverlaps.push(r.after.overlaps - r.before.overlaps);
        hpwlRatio.push(r.after.hpwl / r.before.hpwl);
      }
      const row = {
        board: name, 'budget (ms)': budget, mode, 'runs (count)': times.length, 'parts re-placed, median (count)': pct(parts, 0.5),
        'time p50 / p90 / max (ms)': `${pct(times, 0.5).toFixed(0)} / ${pct(times, 0.9).toFixed(0)} / ${Math.max(...times).toFixed(0)}`,
        'runs over budget by > 20 ms (count)': times.filter((t) => t > budget + 20).length,
        'HPWL after / before, median (ratio)': +pct(hpwlRatio, 0.5).toFixed(2),
        'overlapping pairs added, median / max (count)': `${pct(newOverlaps, 0.5)} / ${Math.max(...newOverlaps)}`,
        'session create (ms)': Math.round(createMs),
      };
      rows.push(row);
      console.error(JSON.stringify(row));
    }
  }
}
device.destroy();
console.table(rows);
