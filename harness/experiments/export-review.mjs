// Export layouts with their routing for review: one .kicad_pcb per layout (lib/kicad-export.mjs) and
// one CSV with per-net routing results side by side. Routing = exact router (native build,
// bit-identical to the JS benchmark router), grid phase 0.
// node harness/experiments/export-review.mjs --board ppc-n3 --out DIR name=human name=FILE ...
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard } from '../lib/board.mjs';
import { evaluationRouting } from '../lib/router-gen.mjs';
import { routeBoardNative } from '../lib/native-router.mjs';
import { exportKicad } from '../lib/kicad-export.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'ppc-n3')), out = path.resolve(arg('out'));
const items = argv.filter((a) => a.includes('=') && !a.startsWith('--')).map((a) => { const [name, src] = a.split('='); return { name, src }; });
fs.mkdirSync(out, { recursive: true });
const board = { ...b.a.routing, pitch: 0.4 }, results = [];
for (const { name, src } of items) {
  const L = src === 'human' ? b.a.originalLayout : JSON.parse(fs.readFileSync(src, 'utf8'));
  const t = performance.now(), r = routeBoardNative(board, L, b.a.sides, { ...evaluationRouting(board), diagnostics: true, emitPaths: true });
  const file = path.join(out, `${b.name}-${name}-routed.kicad_pcb`), x = exportKicad(b, L, r, file);
  // Physical vias per net (a stack of layer changes = 1), from the paths.
  const P = r.grid.W * r.grid.H, sites = new Array(b.p.nets.length).fill(0);
  for (const [n, p] of r.paths) for (let k = 1; k < p.length; k++) if (Math.abs(p[k] - p[k - 1]) === P && !(k > 1 && Math.abs(p[k - 1] - p[k - 2]) === P)) sites[n]++;
  results.push({ name, src, r, sites, summary: { layout: name, source: src, clean: r.clean, nets: r.nets, vias: r.vias, viaSites: r.viaSites, routedLengthMm: Math.round(r.length), rounds: r.rounds, routeSeconds: Math.round((performance.now() - t) / 1000), kicadFile: path.basename(file), footprintsMoved: x.moved, segments: x.segments, viaItems: x.vias } });
  console.log(JSON.stringify(results.at(-1).summary));
}
// Per-net CSV: one row per signal net, columns per layout.
const pins = b.p.nets.map((n) => n.pins.length), parts = b.p.nets.map((n) => [...new Set(n.pins.map((pi) => b.p.components[b.p.pins[pi].componentIndex].id))]);
const status = ['', 'clean', 'overflow', 'open'];
const head = ['net', 'pins (count)', 'parts on net', ...results.flatMap(({ name }) => [`${name}: status`, `${name}: vias, layer steps (count)`, `${name}: vias, physical (count)`, `${name}: routed length (mm)`])];
const rows = b.p.nets.map((n, i) => [n.id, pins[i], parts[i].join(' '), ...results.flatMap(({ r, sites }) => [status[r.status[i]], r.netStats[i].vias, sites[i], Math.round(r.netStats[i].lengthMm * 10) / 10])]);
const csv = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
fs.writeFileSync(path.join(out, `${b.name}-nets.csv`), [head, ...rows].map((r) => r.map(csv).join(',')).join('\n') + '\n');
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ board: b.name, boardFile: b.file, routing: 'exact PathFinder, native build (bit-identical to JS), 0.4 mm grid, phase 0, 40 rounds', layouts: results.map((x) => x.summary) }, null, 1));
