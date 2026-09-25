// Renders original vs optimized placements of KiCad boards, both routed by this package's
// negotiated router, next to the board's real KiCad copper for reference.
//
//   node bench/kicad-boards.mjs --backend gpu --budget large --only edk --save-layouts --out run.json
//   node bench/render-kicad.mjs --in run.json [--out report.html] [--cell 0.25] [--rounds 8]
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { normalizeProblem, rotatedSize, worldPin, sharesSide } from '../src/problem.js';
import { loadKicadParser, designToProblem, parseTracks } from './kicad-adapter.mjs';
import { routeBoard } from './pcb-router.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const inFile = arg('in');
if (!inFile) { console.error('usage: node bench/render-kicad.mjs --in results.json [--out report.html]'); process.exit(2); }
const run = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const outFile = arg('out', inFile.replace(/\.json$/, '') + '.html');
const cellMm = Number(arg('cell', 0.4));
const maxRounds = Number(arg('rounds', 12));
const parse = await loadKicadParser(run.placerRoot);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = (v) => (Math.round(v * 10) / 10).toString();

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

function route(adapted, layout) {
  const t0 = performance.now();
  const r = routeBoard(adapted.routing, layout, adapted.sides, { cell: cellMm, maxRounds });
  return { ...r, lines: r.polylines(), ms: performance.now() - t0 };
}

const hue = (i) => (i * 137.508) % 360;

function panel({ problem, layout, sides, contours, routes, tracks, highlight }) {
  const W = problem.canvas.width, H = problem.canvas.height, pad = 1.5;
  const parts = [`<svg viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}" xmlns="http://www.w3.org/2000/svg">`];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" class="canvas"/>`);
  for (const c of contours) parts.push(`<path class="edge" d="M${c.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}Z"/>`);
  layout.forEach((p, i) => {
    const [w, h] = rotatedSize(problem.components[i], p.rotation);
    const cls = `${(p.side ?? (sides[i] < 0 ? 1 : 0)) ? 'bot' : 'top'}${highlight?.[i] ? ' bad' : ''}${problem.components[i].fixed ? ' locked' : ''}`;
    parts.push(`<rect class="${cls}" x="${(p.x - w / 2).toFixed(2)}" y="${(p.y - h / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"><title>${esc(problem.components[i].id)}</title></rect>`);
  });
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
      for (const b of lines) parts.push(`<polyline class="${b.layer ? 'rb' : 'rf'}${st === 2 ? ' conflict' : ''}" points="${b.points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}"><title>${esc(problem.nets[ni].id)}</title></polyline>`);
    });
  }
  problem.pins.forEach((pin, pi) => {
    const [x, y] = worldPin(problem, layout, pi);
    parts.push(`<circle class="pin" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="0.22"/>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

const sections = [];
for (const row of run.rows) {
  if (!row.layouts) { console.error(`skip ${row.case}: no layouts (re-run kicad-boards.mjs with --save-layouts)`); continue; }
  const text = fs.readFileSync(path.join(run.placerRoot, row.file), 'utf8');
  const adapted = designToProblem(parse(text, path.basename(row.file)), { preplace: String(row.mode ?? '').includes('preplace'), sides: (String(row.mode ?? '').match(/sides-(\w+)/) ?? [])[1] ?? 'single' });
  const problem = normalizeProblem(adapted.input);
  const tracks = parseTracks(text, adapted.origin);
  const { original, result } = row.layouts;
  const rOrig = route(adapted, original), rNew = route(adapted, result);
  console.error(`${row.case}: clean ${rOrig.clean}/${rOrig.nets} -> ${rNew.clean}/${rNew.nets}`);
  const base = { problem, sides: adapted.sides, contours: adapted.contours };
  const origBad = overlapping(problem, original), newBad = overlapping(problem, result);
  const stat = (label, hpwl, bad, r) => `<tr><th>${label}</th><td>${Math.round(hpwl)}</td><td>${bad.reduce((s, v) => s + v, 0)}</td>` +
    (r ? `<td>${r.clean} / ${r.nets}</td><td>${r.overflow}</td><td>${r.vias}</td><td>${Math.round(r.length)}</td><td>${f1(r.ms / 1000)}</td>` : '<td colspan="5">—</td>') + '</tr>';
  sections.push(`
<section>
  <h2>${esc(row.case)} <small>${esc(path.basename(row.file))} · ${row.n} footprints · ${problem.nets.length} signal nets · ${f1(problem.canvas.width)}×${f1(problem.canvas.height)} mm</small></h2>
  <table>
    <thead><tr><th></th><th>HPWL (mm)</th><th>Overlapping parts</th><th>Clean nets</th><th>Conflict cells</th><th>Vias</th><th>Route length (mm)</th><th>Route time (s)</th></tr></thead>
    <tbody>
      ${stat('Original (human)', row.original.score.hpwl, origBad, rOrig)}
      ${stat(`Optimized (${esc(row.backend)}/${esc(row.budget)}/${esc(row.mode ?? 'plain')}, ${row['total s']} s)`, row.result.score.hpwl, newBad, rNew)}
    </tbody>
  </table>
  <div class="panels">
    <figure>${panel({ ...base, layout: original, tracks })}<figcaption>Original placement + real KiCad copper (red F.Cu, blue B.Cu)</figcaption></figure>
    <figure>${panel({ ...base, layout: original, routes: rOrig, highlight: origBad })}<figcaption>Original placement, two-layer evaluation router</figcaption></figure>
    <figure>${panel({ ...base, layout: result, routes: rNew, highlight: newBad })}<figcaption>Optimized placement from random start, routed the same way</figcaption></figure>
  </div>
</section>`);
}

fs.writeFileSync(outFile, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>KiCad Placement Comparison</title>
<style>
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#deded8; --canvas:#fbfbf8; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecece8; --muted:#a3a39c; --card:#1f1f1d; --line:#34342f; --canvas:#232320; } }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; }
main { max-width:1500px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:32px 0 8px; } h2 small { color:var(--muted); font-weight:400; font-size:13px; }
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
.pin { fill:var(--fg); fill-opacity:.55; }
.rf, .rb { fill:none; stroke-width:.28; stroke-linejoin:round; stroke-opacity:.85; } .rf { stroke:#d0443a; } .rb { stroke:#3b6fd6; } .conflict { stroke:#f0a020 !important; }
.rat { stroke:#e0452b; stroke-width:.12; stroke-dasharray:.5 .4; }
.tf { stroke:#d0443a; stroke-opacity:.75; stroke-linecap:round; } .tb { stroke:#3b6fd6; stroke-opacity:.75; stroke-linecap:round; } .ti { stroke:#c08a1e; stroke-opacity:.7; }
.via { fill:#8a8a84; }
.legend span { display:inline-block; margin-right:14px; color:var(--muted); font-size:12px; }
.legend i { display:inline-block; width:12px; height:9px; margin-right:5px; vertical-align:-1px; border:1px solid; }
</style></head><body><main>
<h1>KiCad placement: original vs optimized</h1>
<p class="lead">Middle and right panels use the same two-layer PathFinder router (${cellMm} mm grid, pads as obstacles, SMD pads on their footprint's original side, up to ${maxRounds} rounds, power/ground nets excluded) so the two placements are compared on equal terms. Every footprint shares one placement plane in this package, so bottom-side parts of the original board overlap top-side parts.</p>
<p class="legend"><span><i style="background:#5fa8a044;border-color:#2f7d74"></i>top-side footprint</span><span><i style="background:#9a86c944;border-color:#6a55a3"></i>bottom-side footprint (original side)</span><span><i style="background:#e0452b40;border-color:#e0452b"></i>overlapping footprint</span><span><i style="border:0;border-top:2px solid #d0443a;height:0"></i>F.Cu</span><span><i style="border:0;border-top:2px solid #3b6fd6;height:0"></i>B.Cu</span><span><i style="border:0;border-top:2px solid #f0a020;height:0"></i>net sharing cells</span><span><i style="border:0;border-top:2px dashed #e0452b;height:0"></i>unrouted net</span></p>
${sections.join('\n')}
</main></body></html>`);
console.error(`wrote ${outFile}`);
