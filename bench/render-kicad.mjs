// Renders original vs optimized placements of KiCad boards, both routed by the two-layer
// evaluation router, next to the board's real KiCad copper for reference. Rows that
// carry a module plan (`moduleOf`) also get module maps of both placements.
//
//   node bench/kicad-boards.mjs --backend gpu --budget large --only edk --save-layouts --out run.json
//   node bench/render-kicad.mjs --in run.json [--out report.html] [--cell 0.4] [--rounds 12] [--only a,b]
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { normalizeProblem, rotatedSize, worldPin, sharesSide } from '../src/problem.js';
import { loadKicadParser, designToProblem, parseTracks } from './kicad-adapter.mjs';
import { irToProblem } from '../src/ir/to-problem.js';
import { routeBoard } from './pcb-router.mjs';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const hue = (i) => (i * 137.508) % 360;

function overlapping(problem, layout) {
  const n = layout.length, bad = new Uint8Array(n), box = layout.map((p, i) => {
    const [w, h] = rotatedSize(problem.components[i], p.rotation);
    return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
  });
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!sharesSide(problem, i, layout[i], j, layout[j])) continue;
    const a = box[i], b = box[j], ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    if (ox > 0 && oy > 0 && ox * oy > 0.01) bad[i] = bad[j] = 1;
  }
  return bad;
}

function panel({ problem, layout, sides, contours, routes, tracks, highlight, moduleOf, moduleNames }) {
  const W = problem.canvas.width, H = problem.canvas.height, pad = 1.5;
  const parts = [`<svg viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}" xmlns="http://www.w3.org/2000/svg">`];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" class="canvas"/>`);
  for (const c of contours) parts.push(`<path class="edge" d="M${c.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z"/>`);
  layout.forEach((p, i) => {
    const [w, h] = rotatedSize(problem.components[i], p.rotation);
    const bottom = p.side ?? (sides[i] < 0 ? 1 : 0);
    const locked = problem.components[i].fixed ? ' locked' : '';
    const rect = `x="${(p.x - w / 2).toFixed(2)}" y="${(p.y - h / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"`;
    if (moduleOf) {
      const m = moduleOf[i];
      const fill = m >= 0 ? `hsl(${hue(m).toFixed(0)} 65% 50%)` : '#888';
      parts.push(`<rect class="mod${bottom ? ' modbot' : ''}${locked}" style="fill:${fill};stroke:${fill}" ${rect}><title>${esc(problem.components[i].id)}${m >= 0 ? ` · ${esc(moduleNames[m])}` : ''}${bottom ? ' · bottom' : ''}</title></rect>`);
    } else {
      parts.push(`<rect class="${bottom ? 'bot' : 'top'}${highlight?.[i] ? ' bad' : ''}${locked}" ${rect}><title>${esc(problem.components[i].id)}</title></rect>`);
    }
  });
  if (moduleOf) {
    // Module labels at the centroid of their members.
    const acc = moduleNames.map(() => [0, 0, 0]);
    layout.forEach((p, i) => { const m = moduleOf[i]; if (m >= 0) { acc[m][0] += p.x; acc[m][1] += p.y; acc[m][2]++; } });
    const size = Math.max(W, H) / 55;
    acc.forEach(([x, y, n], m) => { if (n) parts.push(`<text class="modlabel" x="${(x / n).toFixed(2)}" y="${(y / n).toFixed(2)}" font-size="${size.toFixed(2)}">${esc(moduleNames[m].split(' ')[0])}</text>`); });
  }
  if (tracks) {
    for (const s of tracks.segments) parts.push(`<line class="${s.layer === 'B.Cu' ? 'tb' : s.layer === 'F.Cu' ? 'tf' : 'ti'}" x1="${s.x1.toFixed(2)}" y1="${s.y1.toFixed(2)}" x2="${s.x2.toFixed(2)}" y2="${s.y2.toFixed(2)}" stroke-width="${Math.max(0.12, s.width)}"/>`);
    for (const v of tracks.vias) parts.push(`<circle class="via" cx="${v.x.toFixed(2)}" cy="${v.y.toFixed(2)}" r="${(v.size / 2).toFixed(2)}"/>`);
  }
  if (routes) {
    routes.lines.forEach((lines, ni) => {
      const st = routes.status[ni];
      if (st === 3) {
        // Incomplete net: ratsnest star from its first pin.
        const pins = problem.nets[ni].pins.map((pi) => worldPin(problem, layout, pi));
        for (let k = 1; k < pins.length; k++) parts.push(`<line class="rat" x1="${pins[0][0].toFixed(2)}" y1="${pins[0][1].toFixed(2)}" x2="${pins[k][0].toFixed(2)}" y2="${pins[k][1].toFixed(2)}"/>`);
      }
      const last = (routes.grid?.layers ?? 2) - 1;
      for (const b of lines) parts.push(`<polyline class="${b.layer === 0 ? 'rf' : b.layer === last ? 'rb' : 'ri'}${st === 2 ? ' conflict' : ''}" points="${b.points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}"><title>${esc(problem.nets[ni].id)}</title></polyline>`);
    });
  }
  if (!moduleOf) problem.pins.forEach((pin, pi) => {
    const [x, y] = worldPin(problem, layout, pi);
    parts.push(`<circle class="pin" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.22"/>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/**
 * @param run {placerRoot, rows:[{case, file, mode|adapt, layouts:{original,result}, original, result, ...}]}
 *        row.adapt = designToProblem options; row.moduleOf / row.moduleNames enable module maps.
 */
export async function renderReport(run, { out, cell = 0.4, rounds = 12, only = [], layers = 'board', intro = '', title = 'KiCad placement: original vs optimized', lang = 'en' } = {}) {
  const parse = await loadKicadParser(run.placerRoot);
  const route = (adapted, layout) => { const t0 = performance.now(); const r = routeBoard(layers === 'board' ? adapted.routing : { ...adapted.routing, layers: Number(layers) }, layout, adapted.sides, { cell, maxRounds: rounds }); return { ...r, lines: r.polylines(), ms: performance.now() - t0 }; };
  const sections = [];
  for (const row of run.rows) {
    if (only.length && !only.includes(row.case)) continue;
    if (!row.layouts) { console.error(`skip ${row.case}: no layouts (re-run kicad-boards.mjs with --save-layouts)`); continue; }
    const file = path.isAbsolute(row.file) ? row.file : path.join(run.placerRoot, row.file);
    const text = fs.readFileSync(file, 'utf8');
    const adapt = row.adapt ?? { preplace: String(row.mode ?? '').includes('preplace'), sides: (String(row.mode ?? '').match(/sides-(\w+)/) ?? [])[1] ?? 'single' };
    // Board IR input has no copper to show; KiCad input shows its real tracks.
    const adapted = row.isIR
      ? irToProblem(JSON.parse(text), { preplace: adapt.preplace, sides: adapt.sides === 'free' ? 'ir' : adapt.sides })
      : designToProblem(parse(text, path.basename(file)), adapt);
    const problem = normalizeProblem(adapted.input);
    const tracks = row.isIR ? null : parseTracks(text, adapted.origin);
    const { original, result } = row.layouts;
    const rOrig = original ? route(adapted, original) : null, rNew = route(adapted, result);
    console.error(`${row.case}: clean nets ${rOrig ? `${rOrig.clean}/${rOrig.nets} (input) -> ` : ''}${rNew.clean}/${rNew.nets} (optimized)`);
    const base = { problem, sides: adapted.sides, contours: adapted.contours };
    const origBad = original ? overlapping(problem, original) : null, newBad = overlapping(problem, result);
    const stat = (label, hpwl, bad, r) => `<tr><th>${label}</th><td>${Math.round(hpwl)}</td><td>${bad.reduce((s, v) => s + v, 0)}</td>` +
      `<td>${r.clean} / ${r.nets}</td><td>${r.overflow}</td><td>${r.vias}</td><td>${Math.round(r.length)}</td><td>${f1(r.ms / 1000)}</td></tr>`;
    const modules = row.moduleOf ? `
  <h3>Modules (${row.moduleNames.length}; grey = placed individually)</h3>
  <div class="panels">
    ${original ? `<figure>${panel({ ...base, layout: original, moduleOf: row.moduleOf, moduleNames: row.moduleNames })}<figcaption>Where the input placement put each module's parts</figcaption></figure>` : ''}
    <figure>${panel({ ...base, layout: result, moduleOf: row.moduleOf, moduleNames: row.moduleNames })}<figcaption>Modules in the optimized placement (lighter = bottom side)</figcaption></figure>
  </div>` : '';
    sections.push(`
<section>
  <h2>${esc(row.case)} <small>${esc(path.basename(file))} · ${row.n} footprints · ${problem.nets.length} signal nets · ${f1(problem.canvas.width)}×${f1(problem.canvas.height)} mm</small></h2>
  <table>
    <thead><tr><th>Placement</th><th>HPWL, signal nets (mm)</th><th>Overlapping parts (count)</th><th>Clean nets, board signal layers (count / total)</th><th>Cells shared by nets (count)</th><th>Vias (count)</th><th>Route length (mm)</th><th>Routing time (s)</th></tr></thead>
    <tbody>
      ${original ? stat('Input (original) placement', row.original.score.hpwl, origBad, rOrig) : ''}
      ${stat(`Optimized: ${esc(row.backend)} backend, ${esc(row.budget)} budget, ${esc(row.mode ?? 'plain')} (placement ${row['total s']} s)`, row.result.score.hpwl, newBad, rNew)}
    </tbody>
  </table>
  <div class="panels">
    ${original && tracks ? `<figure>${panel({ ...base, layout: original, tracks })}<figcaption>Original placement + real KiCad copper (red F.Cu, blue B.Cu)</figcaption></figure>` : ''}
    ${original ? `<figure>${panel({ ...base, layout: original, routes: rOrig, highlight: origBad })}<figcaption>Input placement, two-layer evaluation router</figcaption></figure>` : ''}
    <figure>${panel({ ...base, layout: result, routes: rNew, highlight: newBad })}<figcaption>Optimized placement from random start, routed the same way</figcaption></figure>
  </div>${modules}
</section>`);
  }

  fs.writeFileSync(out, `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KiCad Placement Comparison</title>
<style>
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#deded8; --canvas:#fbfbf8; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecece8; --muted:#a3a39c; --card:#1f1f1d; --line:#34342f; --canvas:#232320; } }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
main { max-width:1500px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 8px; } h2 small { color:var(--muted); font-weight:400; font-size:13px; } h3 { font-size:14px; margin:16px 0 8px; }
p.lead { color:var(--muted); margin:0 0 8px; max-width:900px; }
table { border-collapse:collapse; margin:8px 0 12px; font-variant-numeric:tabular-nums; background:var(--card); }
th, td { padding:4px 10px; border-bottom:1px solid var(--line); text-align:right; } th:first-child, thead th { text-align:left; }
.panels { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:12px; }
figure { margin:0; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px; }
figcaption { color:var(--muted); font-size:12px; margin-top:6px; }
svg { width:100%; height:auto; display:block; }
.canvas { fill:var(--canvas); stroke:none; } .edge { fill:none; stroke:var(--muted); stroke-width:.25; }
.top { fill:#5fa8a0; fill-opacity:.28; stroke:#2f7d74; stroke-width:.12; }
.bot { fill:#9a86c9; fill-opacity:.28; stroke:#6a55a3; stroke-width:.12; }
.bad { stroke:#e0452b; stroke-width:.3; fill:#e0452b; fill-opacity:.25; } .locked { stroke-dasharray:.6 .3; }
.mod { fill-opacity:.7; stroke-width:.12; } .modbot { fill-opacity:.3; }
.modlabel { fill:var(--fg); font-weight:600; text-anchor:middle; dominant-baseline:middle; paint-order:stroke; stroke:var(--card); stroke-width:.4; }
.pin { fill:var(--fg); fill-opacity:.55; }
.rf, .rb { fill:none; stroke-width:.28; stroke-linejoin:round; stroke-opacity:.85; } .rf { stroke:#d0443a; } .rb { stroke:#3b6fd6; } .ri { stroke:#2fa36b; stroke-opacity:.6; } .conflict { stroke:#f0a020 !important; }
.rat { stroke:#e0452b; stroke-width:.12; stroke-dasharray:.5 .4; }
.tf { stroke:#d0443a; stroke-opacity:.75; stroke-linecap:round; } .tb { stroke:#3b6fd6; stroke-opacity:.75; stroke-linecap:round; } .ti { stroke:#c08a1e; stroke-opacity:.7; }
.via { fill:#8a8a84; }
.legend span { display:inline-block; margin-right:14px; color:var(--muted); font-size:12px; }
.intro { max-width:1100px; } .intro td, .intro th { text-align:right; } .intro td:first-child, .intro th:first-child { text-align:left; }
.intro ul { padding-left:20px; } .intro li { margin:3px 0; }
.legend i { display:inline-block; width:12px; height:9px; margin-right:5px; vertical-align:-1px; border:1px solid; }
</style></head><body><main>
<h1>${esc(title)}</h1>
${intro}
<p class="lead">Middle and right panels use the same multi-layer PathFinder router (the board's signal layers, planes excluded) (${cell} mm grid, pads as obstacles, SMD pads on the side the placement puts them, up to ${rounds} rounds, power/ground nets excluded) so the two placements are compared on equal terms. Footprint colour shows the side each placement puts it on; with <code>--sides single</code> every footprint shares one plane, so bottom-side parts of the original board overlap top-side parts.</p>
<p class="legend"><span><i style="background:#5fa8a044;border-color:#2f7d74"></i>top-side footprint</span><span><i style="background:#9a86c944;border-color:#6a55a3"></i>bottom-side footprint</span><span><i style="background:#e0452b40;border-color:#e0452b"></i>overlapping footprint</span><span><i style="border:0;border-top:2px solid #d0443a;height:0"></i>F.Cu</span><span><i style="border:0;border-top:2px solid #3b6fd6;height:0"></i>B.Cu</span><span><i style="border:0;border-top:2px solid #2fa36b;height:0"></i>inner layers</span><span><i style="border:0;border-top:2px solid #f0a020;height:0"></i>net sharing cells</span><span><i style="border:0;border-top:2px dashed #e0452b;height:0"></i>unrouted net</span></p>
${sections.join('\n')}
</main></body></html>`);
  console.error(`wrote ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const inFile = arg('in');
  if (!inFile) { console.error('usage: node bench/render-kicad.mjs --in results.json [--out report.html]'); process.exit(2); }
  await renderReport(JSON.parse(fs.readFileSync(inFile, 'utf8')), {
    out: arg('out', inFile.replace(/\.json$/, '') + '.html'), cell: Number(arg('cell', 0.4)), rounds: Number(arg('rounds', 12)),
    only: (arg('only', '') ?? '').split(',').filter(Boolean),
  });
}
