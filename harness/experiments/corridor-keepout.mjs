// Key information: human routing corridors. Human track segments of chosen nets become thin fixed
// blockers on their outer layer's side (TOP / F.Cu -> side 0, BOT / B.Cu -> side 1; inner layers
// skipped) while a layout is legalized, then the blockers are dropped and the layout is routed.
//   --nets backbone : nets without small parts (all parts fixed or >= 8 signal pins)
//   --nets all      : every signal net (2-30 parts)
// node harness/experiments/corridor-keepout.mjs --board k60 --layout L.json --nets backbone --out FILE [--tag T]
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust } from '../lib/board.mjs';
import { loadTracks } from '../lib/tracks.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, which = arg('nets', 'backbone'), src = arg('layout');
const L0 = (() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return j.layout ?? j; })();
const segs = loadTracks(b), sig = new Array(C.length).fill(0);
p.nets.forEach((nt) => nt.pins.forEach((pi) => sig[p.pins[pi].componentIndex]++));
const sideOf = (layer) => /^(TOP|F\.Cu)/i.test(layer) ? 0 : /^(BOT|B\.Cu)/i.test(layer) ? 1 : null;
const W = 0.25, dummies = [], poses = [];
p.nets.forEach((nt, k) => {
  const cs = new Set(nt.pins.map((pi) => p.pins[pi].componentIndex)); if (cs.size < 2 || cs.size > 30) return;
  if (which === 'backbone' && ![...cs].every((i) => C[i].fixed || sig[i] >= 8)) return;
  for (const [x1, y1, x2, y2, layer] of segs[k]) {
    const side = sideOf(layer); if (side === null) continue;
    const add = (x, y, w, h) => { dummies.push({ id: `trk${dummies.length}`, width: Math.max(w, W), height: Math.max(h, W), rotatable: false, sides: side ? 'bottom' : 'top', twoSided: false, pins: [], fixed: { x, y, rotation: 0, side } }); };
    if (Math.abs(x1 - x2) < 1e-3 || Math.abs(y1 - y2) < 1e-3) add((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1), Math.abs(y2 - y1));
    else { const l = Math.hypot(x2 - x1, y2 - y1), n = Math.ceil(l / 0.3); for (let s = 0; s < n; s++) { const t = (s + 0.5) / n; add(x1 + t * (x2 - x1), y1 + t * (y2 - y1), W, W); } }
  }
});
// ICs (>= 8 signal pins) stay at their pose: only small parts make room for the corridors.
const n = C.length, comps = [...C.map((c, i) => !c.fixed && sig[i] >= 8 ? { ...c, fixed: { ...L0[i] } } : c), ...dummies.map((d, k) => ({ ...d, index: n + k }))];
const p2 = { ...p, components: comps }, b2 = { ...b, p: p2 };
const L = [...L0.map((q) => ({ ...q })), ...dummies.map((d) => ({ ...d.fixed }))];
const t0 = performance.now(), r = legalize(b2, L), leg = legalize(b, r.layout.slice(0, n));
const m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
const row = { board: b.name, layout: src, tag: arg('tag'), nets: which, blockers: dummies.length, legalizeS: +((performance.now() - t0) / 1000).toFixed(1), moved: r.moved, failed: r.failed, meanMoveMm: +(r.meanDisplacement ?? 0).toFixed(2), clean: m.clean, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
