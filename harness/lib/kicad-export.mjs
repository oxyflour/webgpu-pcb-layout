// Write a layout and the harness router's routing into a copy of the board's .kicad_pcb, for review
// in KiCad. Footprint poses come from the adapter's inverse transform (placementResult: checked to
// reproduce every human footprint pose exactly). The original tracks, vias and zone fills are
// removed (zones stay; refill them in KiCad if wanted); the routing is written as segments (0.2 mm,
// display width of the 0.4 mm grid) and vias: one via per stack of layer changes at a grid cell,
// through when it spans the outer layers, blind/buried otherwise.
import fs from 'node:fs';
import crypto from 'node:crypto';

import { placementResult } from '../../core/src/ir/to-problem.js';
const num = (v) => String(Math.round(v * 1e6) / 1e6);
// Router layer l -> copper layer name: the router may use fewer layers than the file has (k60: 2 of
// TOP/PWR/GND/BOT); its last layer is the bottom copper.
export function routerLayerNames(b) {
  const all = b.a.ir.board.copperLayers.map((l) => l.name), L = Math.max(2, b.a.routing.layers ?? 2);
  return Array.from({ length: L }, (_, l) => l === L - 1 ? all[all.length - 1] : all[l]);
}

// Top-level blocks of a KiCad file: [{start, end, head}] line ranges (inclusive), by paren depth.
function topBlocks(lines) {
  const out = [];
  let depth = 0, cur = null;
  lines.forEach((line, i) => {
    const before = depth;
    for (let k = 0, q = false; k < line.length; k++) { const ch = line[k]; if (ch === '"' && line[k - 1] !== '\\') q = !q; else if (!q) { if (ch === '(') depth++; else if (ch === ')') depth--; } }
    if (before === 1 && !cur && /^\s*\(/.test(line)) cur = { start: i, head: line.trim().match(/^\((\S+)/)[1] };
    if (cur && depth === 1) { cur.end = i; out.push(cur); cur = null; }
  });
  return out;
}

// routing: routeBoardNative result with emitPaths (cell ids l * P + q) and its grid.
export function exportKicad(b, layout, routing, outFile) {
  const text = fs.readFileSync(b.file, 'utf8').replace(/\r\n/g, '\n'), lines = text.split('\n');
  const blocks = topBlocks(lines), place = placementResult(b.a, layout).placements;
  const netNum = new Map(); for (const l of lines) { const m = l.match(/^ {2}\(net (\d+) "?([^"]*?)"?\)$/); if (m) netNum.set(m[2], Number(m[1])); }
  const out = [], drop = new Set(['segment', 'via', 'arc']);
  let fi = 0, last = 0, changed = 0;
  const emitRange = (a, z) => { for (let i = a; i <= z; i++) out.push(lines[i]); };
  for (const bl of blocks) {
    emitRange(last, bl.start - 1); last = bl.end + 1;
    if (drop.has(bl.head)) continue;
    const body = lines.slice(bl.start, bl.end + 1);
    if (bl.head === 'zone') {
      // Drop filled_polygon / fill_segments sub-blocks (stale fills).
      let skip = 0;
      for (const line of body) {
        if (!skip && /^\s{4}\((filled_polygon|fill_segments)\b/.test(line)) skip = 1;
        if (skip) { for (const ch of line) { if (ch === '(') skip++; else if (ch === ')') skip--; } skip = skip > 1 ? skip : 0; continue; }
        out.push(line);
      }
      continue;
    }
    if (bl.head === 'footprint' || bl.head === 'module') { // module: KiCad <= 5 files
      const ir = b.a.ir.footprints[fi], p = place[fi]; fi++;
      const ref = (body.join('\n').match(/\(fp_text reference "?([^"\s)]*)"?|\(property "Reference" "([^"]*)"/) ?? []).slice(1).find(Boolean);
      if (ref !== undefined && ref !== ir.id.replace(/#\d+$/, '')) throw new Error(`footprint order differs: file ${ref}, adapter ${ir.id}`);
      const old = ir.placement, d = ((p.rotation - (old.rotation ?? 0)) % 360 + 360) % 360;
      if (Math.hypot(p.x - old.x, p.y - old.y) > 1e-6 || d) changed++;
      let headerDone = false;
      for (let line of body) {
        if (!headerDone && /^\s{4}\(at /.test(line)) { line = line.replace(/\(at [^)]*\)/, `(at ${num(p.x)} ${num(p.y)}${p.rotation ? ` ${num(p.rotation)}` : ''})`); headerDone = true; }
        else if (d && /\((pad|fp_text|property) /.test(line)) line = line.replace(/\(at (\S+) (\S+?)(?: (-?\d+(?:\.\d+)?))?([ )])/, (_, x, y, a, tail) => `(at ${x} ${y} ${num((((Number(a ?? 0) + d) % 360) + 360) % 360)}${tail}`);
        out.push(line);
      }
      continue;
    }
    for (const line of body) out.push(line);
  }
  if (fi !== place.length) throw new Error(`footprints: file ${fi}, adapter ${place.length}`);
  const tail = lines.slice(last);
  // Routing.
  const { W, H, cell } = routing.grid, P = W * H, L = Math.max(2, b.a.routing.layers ?? 2), names = routerLayerNames(b);
  const ox = b.a.origin.x, oy = b.a.origin.y, xy = (q) => [(q % W + 0.5) * cell + ox, (Math.floor(q / W) + 0.5) * cell + oy];
  const tid = () => crypto.randomUUID();
  let segments = 0, vias = 0;
  for (const [n, path] of routing.paths) {
    const net = netNum.get(b.p.nets[n].id);
    if (net === undefined) throw new Error(`net ${b.p.nets[n].id} not in the KiCad net table`);
    let k = 0;
    while (k < path.length) {
      const l = Math.floor(path[k] / P);
      // Planar run on layer l.
      let e = k; while (e + 1 < path.length && Math.floor(path[e + 1] / P) === l) e++;
      const pts = []; for (let i = k; i <= e; i++) pts.push(path[i] % P);
      const keep = pts.filter((q, i) => i === 0 || i === pts.length - 1 || (pts[i] - pts[i - 1]) !== (pts[i + 1] - pts[i]));
      for (let i = 1; i < keep.length; i++) { const [x0, y0] = xy(keep[i - 1]), [x1, y1] = xy(keep[i]); out.push(`  (segment (start ${num(x0)} ${num(y0)}) (end ${num(x1)} ${num(y1)}) (width 0.2) (layer "${names[l]}") (net ${net}) (tstamp ${tid()}))`); segments++; }
      if (e + 1 >= path.length) break;
      // Vertical run (layer changes at one cell) -> one via.
      let v = e; while (v + 1 < path.length && Math.abs(path[v + 1] - path[v]) === P) v++;
      const l0 = Math.min(l, Math.floor(path[v] / P)), l1 = Math.max(l, Math.floor(path[v] / P)), [x, y] = xy(path[e] % P);
      out.push(`  (via${l0 === 0 && l1 === L - 1 ? '' : ' blind'} (at ${num(x)} ${num(y)}) (size 0.3) (drill 0.15) (layers "${names[l0]}" "${names[l1]}") (net ${net}) (tstamp ${tid()}))`); vias++;
      k = v;
    }
  }
  fs.writeFileSync(outFile, [...out, ...tail].join('\n'));
  return { footprints: fi, moved: changed, segments, vias };
}
