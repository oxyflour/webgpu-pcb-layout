// Key-information check for the parts around one large IC: start from a base layout (--layout, file
// or human), put the IC's small parts at their pose relative to the IC in a donor layout (--donor,
// default human), following the base's IC pose, legalize,
// optionally run the global Cypress pass, and score (exact router, median of grid phases).
//   --set signal : movable parts with < 8 signal pins that share a signal net (<= 30 parts) with the IC
//   --set all    : + parts without signal nets on a non-ground supply net of the IC (decaps)
//   --set series / local : the signal set split by whether a part also links another IC / fixed part
//   --set none   : the base layout as is (legalized), the reference
// node harness/experiments/u1-transplant.mjs --board ppc-n3 --ic U1 --layout FILE|human [--donor FILE|human] --set signal --out DIR [--tag t] [--cypress]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, legalOk, exactRouting } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { lib } from '../lib/env.mjs';

const { rotateQuarter } = await lib('src/problem.js');
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'ppc-n3')), C = b.p.components, H = b.a.originalLayout, idx = new Map(C.map((c, i) => [c.id, i]));
const ic = idx.get(arg('ic', 'U1')), set = arg('set', 'signal'), src = arg('layout'), out = path.resolve(arg('out'));
const read = (s) => (s === 'human' ? H : JSON.parse(fs.readFileSync(s, 'utf8'))).map((p) => ({ ...p }));
const L = read(src), Dn = read(arg('donor', 'human'));
export function icNeighbours(b, ic, set) {
  const C = b.p.components, chosen = new Set();
  if (set === 'none') return chosen;
  for (const n of b.p.nets) { const cs = new Set(n.pins.map((pi) => b.p.pins[pi].componentIndex)); if (cs.size <= 30 && cs.has(ic)) for (const c of cs) if (c !== ic && !C[c].fixed && C[c].pins.length < 8) chosen.add(c); }
  // series: of those, parts that also share a net with another IC (>= 8 pins) or a fixed part;
  // local: the others (only this IC).
  if (set === 'series' || set === 'local') {
    const other = (c) => b.p.nets.some((n) => { const cs = new Set(n.pins.map((pi) => b.p.pins[pi].componentIndex)); return cs.size <= 30 && cs.has(c) && [...cs].some((j) => j !== ic && j !== c && (C[j].fixed || C[j].pins.length >= 8)); });
    for (const c of [...chosen]) if (other(c) !== (set === 'series')) chosen.delete(c);
  }
  if (set === 'all') {
    const sig = new Set(b.p.nets.map((n) => n.id)), fp = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
    const sup = new Set(fp.get(C[ic].id).pads.map((p) => p.net).filter((n) => n && !sig.has(n) && !/GND|VSS/i.test(n)));
    C.forEach((c, i) => { if (!c.fixed && !c.pins.length && fp.get(c.id).pads.some((p) => sup.has(p.net))) chosen.add(i); });
  }
  return chosen;
}
const chosen = icNeighbours(b, ic, set);
// Donor pose relative to the IC, carried to the base's IC pose (translation + quarter turns).
const dr = ((L[ic].rotation - Dn[ic].rotation) % 4 + 4) % 4;
for (const i of chosen) {
  const [rx, ry] = rotateQuarter(Dn[i].x - Dn[ic].x, Dn[i].y - Dn[ic].y, dr);
  L[i] = { ...L[i], x: L[ic].x + rx, y: L[ic].y + ry, rotation: (Dn[i].rotation + dr) % 4 };
}
const tag = arg('tag', `${path.basename(path.dirname(src))}-${set}${argv.includes('--cypress') ? '-cy' : ''}`), dir = path.join(out, tag);
fs.mkdirSync(dir, { recursive: true });
let start = L, cy = null;
if (argv.includes('--cypress')) {
  const r = await runCypress(b, { jobDir: path.join(dir, 'cypress'), seed: 1001, init: legalize(b, L).layout, budgetS: 150 });
  cy = r.status; if (r.layout) start = r.layout;
}
const leg = legalize(b, start);
const moved = [...chosen].map((i) => Math.hypot(leg.layout[i].x - L[i].x, leg.layout[i].y - L[i].y)).sort((a, c) => a - c);
fs.writeFileSync(path.join(dir, 'final-layout.json'), JSON.stringify(leg.layout));
const m = await evaluateRobust(b, leg.layout, exactRouting());
const row = { tag, layout: src, donor: arg('donor', 'human'), ic: C[ic].id, set, parts: chosen.size, cypress: cy, legalizerMoveOfSetMm: moved.length ? { p50: +moved[moved.length >> 1].toFixed(2), p90: +moved[Math.floor(0.9 * (moved.length - 1))].toFixed(2) } : null,
  legal: legalOk(m), clean: m.clean, nets: m.nets, vias: m.vias, viaSites: m.viaSites, hpwlMm: m.hpwlMm, noise: m.noise };
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
