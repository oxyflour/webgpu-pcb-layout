// Axis pass on a legal layout: every movable 2-pad small part (non-square) re-picks its orientation
// axis by --order (default fit,rows,pins): fit = the axis whose footprint overlaps the other parts
// least at its position; rows = majority axis of 2-pad neighbours within 3 mm (same side); pins =
// the init rule (signal pins closest to their targets), which also picks the flip within the axis.
// --passes Gauss-Seidel passes, then legalize and evaluate (5 grid phases, native exact).
// node harness/experiments/axis-pass.mjs --board k60 --layout L.json --out FILE [--order rows,fit,pins] [--tag T]
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust, worldPin, rotatedSize } from '../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, n = C.length, order = arg('order', 'fit,rows,pins').split(','), passes = Number(arg('passes', 2));
const src = arg('layout'), L = (() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return (j.layout ?? j).map((q) => ({ ...q })); })();
const fp = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
const netOfPin = new Map(); p.nets.forEach((nt) => { if (new Set(nt.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30) nt.pins.forEach((pi) => netOfPin.set(pi, nt)); });
const box = (i, q = L[i]) => { const [w, h] = rotatedSize(C[i], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
const shares = (i, j) => C[i].twoSided || C[j].twoSided || L[i].side === L[j].side;
const parts = [...Array(n).keys()].filter((i) => !C[i].fixed && fp.get(C[i].id).pads.length === 2 && C[i].rotatable !== false && Math.abs(C[i].width - C[i].height) > 0.05);
const pinCost = (i, r) => { const T = [...L]; T[i] = { ...L[i], rotation: r }; let c = 0;
  for (const pi of C[i].pins) { const nt = netOfPin.get(pi); if (!nt) continue; const [x, y] = worldPin(p, T, pi); for (const q of nt.pins) { if (p.pins[q].componentIndex === i) continue; const [u, v] = worldPin(p, T, q); c += Math.abs(u - x) + Math.abs(v - y); } } return c; };
const overlap = (i, r) => { const a = box(i, { ...L[i], rotation: r }); let s = 0;
  for (let j = 0; j < n; j++) { if (j === i || !shares(i, j)) continue; const c = box(j); const ox = Math.min(a[2], c[2] + 0.1) - Math.max(a[0], c[0] - 0.1), oy = Math.min(a[3], c[3] + 0.1) - Math.max(a[1], c[1] - 0.1); if (ox > 0 && oy > 0) s += ox * oy; } return s; };
const rowsVote = (i) => { let v = 0; for (const j of parts) if (j !== i && shares(i, j) && Math.hypot(L[j].x - L[i].x, L[j].y - L[i].y) < 3) v += L[j].rotation % 2 ? 1 : -1; return v > 0 ? 1 : v < 0 ? 0 : null; };
let changed = 0;
for (let pass = 0; pass < passes; pass++) for (const i of parts) {
  // best flip per axis by the pin rule
  const byAxis = [0, 1].map((a) => [a, a + 2].reduce((x, r) => (pinCost(i, r) < pinCost(i, x) - 1e-9 ? r : x)));
  let axis = null;
  for (const rule of order) {
    if (rule === 'fit') { const o = byAxis.map((r) => overlap(i, r)); if (Math.abs(o[0] - o[1]) > 1e-6) { axis = o[0] < o[1] ? 0 : 1; break; } }
    else if (rule === 'rows') { const v = rowsVote(i); if (v !== null) { axis = v; break; } }
    else if (rule === 'pins') { const c = byAxis.map((r) => pinCost(i, r)); axis = c[0] <= c[1] ? 0 : 1; break; }
  }
  if (axis === null) continue;
  const r = byAxis[axis]; if (r !== L[i].rotation) { L[i] = { ...L[i], rotation: r }; changed++; }
}
const leg = legalize(b, L), m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
if (arg('save')) fs.writeFileSync(arg('save'), JSON.stringify(leg.layout));
const row = { board: b.name, layout: src, tag: arg('tag'), order: order.join(','), passes, parts: parts.length, changed, legalizerMoved: leg.moved, clean: m.clean, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
