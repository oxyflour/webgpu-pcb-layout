// Timing of module-local re-placement (everything outside the module fixed).
//
//   node bench/relayout-bench.mjs [--only safety,pic] [--lns 20] [--iterations 120] [--scatter]
//
// For every automatic module of each board (human placement as the starting point):
// re-place the module's parts in place (or scattered inside their region with
// --scatter) and report wall time percentiles, module HPWL change and overlaps.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProblem } from '../src/problem.js';
import { autoModules } from '../src/optimizer/modules.js';
import { relayoutMembers, moduleHpwl, memberOverlaps } from '../src/optimizer/relayout.js';
import { loadKicadParser, designToProblem } from './kicad-adapter.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const placerRoot = path.resolve(arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const only = (arg('only', 'edk,safety,pic,nxp,k60,ppc-n1') ?? '').split(',');
const options = { globalIterations: Number(arg('iterations', 120)), lnsIterations: Number(arg('lns', 0)), scatter: args.includes('--scatter') };
const FILES = {
  edk: 'ciaa-Hardware/PCB/EDU-INTEL/edk.kicad_pcb', safety: 'ciaa-Hardware/PCB/Safety/CIAA_Safety_VTI_1.0.kicad_pcb',
  pic: 'ciaa-Hardware/PCB/PIC/ciaa-pic.kicad_pcb', nxp: 'ciaa-Hardware/PCB/NXP/ciaa-nxp.kicad_pcb', k60: 'ciaa-Hardware/PCB/FSL/CIAA_K60/CIAA_K60.kicad_pcb',
  acc: 'ciaa-Hardware/PCB/ACC/CIAA_ACC/ciaa_acc.kicad_pcb', 'ppc-n1': 'powerpc-laptop-mobo/KiCAD/openPPCnotebook/Mas100n1 ACUBE_PORTABILE R_0.kicad_pcb',
};
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const parse = await loadKicadParser(placerRoot);
const rows = [];
for (const name of only) {
  const text = fs.readFileSync(path.join(placerRoot, 'benchmark', FILES[name]), 'utf8');
  const adapted = designToProblem(parse(text, name), { sides: 'free', preplace: true });
  const problem = normalizeProblem(adapted.input), layout = adapted.originalLayout;
  const { modules } = autoModules(problem, { seed: 1 });
  // Warm-up (JIT) on the first module.
  await relayoutMembers(problem, layout, modules[0].members, options);
  const times = [], sizes = [], ratios = [], overlaps = [], parts = { build: [], global: [], lns: [], legal: [] };
  for (const m of modules) {
    const before = moduleHpwl(problem, layout, m.members);
    const r = await relayoutMembers(problem, layout, m.members, { ...options, seed: m.members[0] });
    times.push(r.timing.totalMs); sizes.push(m.members.length + r.stats.obstacles);
    parts.build.push(r.timing.buildMs); parts.global.push(r.timing.globalMs); parts.lns.push(r.timing.lnsMs); parts.legal.push(r.timing.legalizeMs);
    ratios.push(moduleHpwl(problem, r.layout, m.members) / before);
    overlaps.push(memberOverlaps(problem, r.layout, m.members) - memberOverlaps(problem, layout, m.members));
  }
  const row = {
    board: name, 'modules (count)': modules.length,
    'module parts, median / max (count)': `${pct(modules.map((m) => m.members.length), 0.5)} / ${Math.max(...modules.map((m) => m.members.length))}`,
    'sub-problem parts incl. obstacles, median (count)': pct(sizes, 0.5),
    'time median (ms)': +pct(times, 0.5).toFixed(0), 'time p90 (ms)': +pct(times, 0.9).toFixed(0), 'time max (ms)': +Math.max(...times).toFixed(0),
    'global median (ms)': +pct(parts.global, 0.5).toFixed(0), 'legalize median (ms)': +pct(parts.legal, 0.5).toFixed(0), 'LNS median (ms)': +pct(parts.lns, 0.5).toFixed(0),
    'module HPWL after / before, median (ratio)': +pct(ratios, 0.5).toFixed(2), 'new overlapping pairs, max (count)': Math.max(...overlaps),
  };
  rows.push(row);
  console.error(JSON.stringify(row));
}
console.table(rows);
