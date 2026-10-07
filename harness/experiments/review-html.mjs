// Self-contained HTML review of layouts around one IC: two synchronized panes (any two layouts),
// parts of both sides, pads, the exact router's routes (native build, grid phase 0) per copper
// layer and vias, highlighted part groups around the IC, and a net table sorted by the via
// difference between the two panes. Routes and pads are kept inside a window around the IC.
// node harness/experiments/review-html.mjs --board ppc-n3 --ic U1 --out FILE.html [--window 45] [--notes FRAGMENT.html] name=human name=FILE ...
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, rotatedSize, legalOk, placementMetrics } from '../lib/board.mjs';
import { evaluationRouting } from '../lib/router-gen.mjs';
import { routeBoardNative } from '../lib/native-router.mjs';
import { lib } from '../lib/env.mjs';
import { routerLayerNames } from '../lib/kicad-export.mjs';

const { rotateQuarter, localPin } = await lib('src/problem.js');
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'ppc-n3')), C = b.p.components, idx = new Map(C.map((c, i) => [c.id, i]));
const ic = idx.get(arg('ic', 'U1')), win = Number(arg('window', 45)), outFile = path.resolve(arg('out'));
const items = argv.filter((a) => a.includes('=') && !a.startsWith('--')).map((a) => { const k = a.indexOf('='); return { name: a.slice(0, k), src: a.slice(k + 1) }; });
const r2 = (v) => Math.round(v * 100) / 100;

// Part groups around the IC (from the netlist).
const sig = new Set(b.p.nets.map((n) => n.id)), fp = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
const partners = C.map(() => new Set());
for (const n of b.p.nets) { const cs = [...new Set(n.pins.map((pi) => b.p.pins[pi].componentIndex))]; if (cs.length >= 2 && cs.length <= 30) for (const a of cs) for (const c of cs) if (a !== c) partners[a].add(c); }
const sup = new Set(fp.get(C[ic].id).pads.map((p) => p.net).filter((n) => n && !sig.has(n) && !/GND|VSS/i.test(n)));
const group = C.map((c, i) => {
  if (i === ic) return 1;
  if (c.fixed) return 0;
  if (c.pins.length < 8 && partners[i].has(ic)) return [...partners[i]].some((j) => j !== ic && (C[j].fixed || C[j].pins.length >= 8)) ? 2 : 3; // 2: also another IC/fixed (series), 3: only this IC
  if (!c.pins.length && fp.get(c.id).pads.some((p) => sup.has(p.net))) return 4; // decap on the IC's supply
  return 0;
});
const GROUPS = ['other', `${C[ic].id}`, `small parts linked to ${C[ic].id} and another IC / fixed part`, `small parts linked only to ${C[ic].id}`, `parts without signal nets on a ${C[ic].id} supply net (decaps)`];

const board = { ...b.a.routing, pitch: 0.4 }, layerNames = routerLayerNames(b);
const layouts = [];
let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
const loaded = items.map(({ name, src }) => ({ name, src, L: src === 'human' ? b.a.originalLayout : JSON.parse(fs.readFileSync(src, 'utf8')) }));
for (const { L: lay } of loaded) { wx0 = Math.min(wx0, lay[ic].x - win); wx1 = Math.max(wx1, lay[ic].x + win); wy0 = Math.min(wy0, lay[ic].y - win); wy1 = Math.max(wy1, lay[ic].y + win); }
const inWin = (x, y) => x >= wx0 && x <= wx1 && y >= wy0 && y <= wy1;
for (const { name, src, L: lay } of loaded) {
  const t = performance.now(), r = routeBoardNative(board, lay, b.a.sides, { ...evaluationRouting(board), diagnostics: true, emitPaths: true });
  const m = placementMetrics(b, lay);
  const { W, H, cell } = r.grid, P = W * H, xy = (q) => [r2((q % W + 0.5) * cell), r2((Math.floor(q / W) + 0.5) * cell)];
  const routes = [], vias = [], sites = new Array(b.p.nets.length).fill(0);
  for (const [n, p] of r.paths) {
    let k = 0;
    while (k < p.length) {
      const l = Math.floor(p[k] / P); let e = k; while (e + 1 < p.length && Math.floor(p[e + 1] / P) === l) e++;
      const pts = []; for (let i = k; i <= e; i++) pts.push(p[i] % P);
      const keep = pts.filter((q, i) => i === 0 || i === pts.length - 1 || pts[i] - pts[i - 1] !== pts[i + 1] - pts[i]).map(xy);
      if (keep.length > 1 && keep.some(([x, y]) => inWin(x, y))) routes.push([n, l, ...keep.flat()]);
      if (e + 1 >= p.length) break;
      let v = e; while (v + 1 < p.length && Math.abs(p[v + 1] - p[v]) === P) v++;
      sites[n]++;
      const [x, y] = xy(p[e] % P); if (inWin(x, y)) vias.push([n, x, y, Math.min(l, Math.floor(p[v] / P)), Math.max(l, Math.floor(p[v] / P))]);
      k = v;
    }
  }
  const parts = C.map((c, i) => { const [w, h] = rotatedSize(c, lay[i].rotation); return [r2(lay[i].x - w / 2), r2(lay[i].y - h / 2), r2(w), r2(h), (lay[i].side ?? (b.a.sides[i] < 0 ? 1 : 0)) ? 1 : 0]; });
  const pads = [];
  board.pads.forEach((pad) => {
    const pl = lay[pad.comp], [rx, ry] = rotateQuarter(...localPin(pad.lx, pad.ly, pl.side), pl.rotation), cx = pl.x + rx, cy = pl.y + ry;
    if (!inWin(cx, cy)) return;
    const a = pad.rot * Math.PI / 180; let hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h), hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h);
    if (pl.rotation & 1) [hx, hy] = [hy, hx];
    pads.push([r2(cx - hx), r2(cy - hy), r2(2 * hx), r2(2 * hy), pad.tht || pad.hole ? 2 : (pl.side ?? (b.a.sides[pad.comp] < 0 ? 1 : 0)) ? 1 : 0, pad.net]);
  });
  layouts.push({ name, src, metrics: { clean: r.clean, nets: r.nets, vias: r.vias, viaSites: r.viaSites, hpwlMm: m.hpwlMm, legal: legalOk(m) }, parts, pads, routes, vias, netVias: r.netStats.map((s) => s.vias), netSites: sites, netStatus: Array.from(r.status) });
  console.log(JSON.stringify({ name, ...layouts.at(-1).metrics, routesInWindow: routes.length, viasInWindow: vias.length, s: Math.round((performance.now() - t) / 1000) }));
}
// Nets shown in the table: nets with a pin on the IC or on a highlighted part.
const netParts = b.p.nets.map((n) => [...new Set(n.pins.map((pi) => b.p.pins[pi].componentIndex))]);
const tableNets = b.p.nets.map((n, i) => i).filter((i) => netParts[i].some((c) => group[c]));
const data = {
  board: b.name, ic: C[ic].id, layerNames, groups: GROUPS, window: [r2(wx0), r2(wy0), r2(wx1), r2(wy1)],
  outline: (b.a.routing.outline ?? []).map((o) => [o.outer, ...(o.holes ?? [])].map((ring) => ring.map(([x, y]) => [r2(x), r2(y)]))),
  refs: C.map((c) => c.id), group, fixed: C.map((c) => c.fixed ? 1 : 0),
  nets: b.p.nets.map((n, i) => ({ id: n.id, parts: netParts[i].map((c) => C[c].id) })), tableNets, layouts,
};
const tpl = fs.readFileSync(path.join(import.meta.dirname, 'review-template.html'), 'utf8');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
// --notes FILE: an HTML fragment (findings) shown above the metrics.
const notes = arg('notes') ? fs.readFileSync(arg('notes'), 'utf8') : '';
fs.writeFileSync(outFile, tpl.replace('<!--__NOTES__-->', () => notes).replace('/*__DATA__*/null', () => JSON.stringify(data).replace(/</g, '\\u003c')));
console.log(`${outFile}: ${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB`);
