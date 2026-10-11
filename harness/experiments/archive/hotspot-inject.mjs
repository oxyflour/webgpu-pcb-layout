// Key-information test for small parts: start from a layout whose ICs already have the human poses
// (tool run with the human IC plan), put chosen small parts (< 8 signal pins, movable) on their
// human poses, legalize, evaluate (5 grid phases, native exact) incl. routing margin.
//   hot<N>: small parts lying in the N most congested areas (round-1 overflow bins of the input)
//   ic:<REF>: small parts sharing a signal net with REF;  all: every small part
// node harness/experiments/hotspot-inject.mjs --board k60 --layout cand.json --variants none,hot4,ic:U201,all --out FILE
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust, binMm } from '../../lib/board.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), C = b.p.components, H = b.a.originalLayout, src = arg('layout');
const j = JSON.parse(fs.readFileSync(src, 'utf8')), L0 = legalize(b, j.layout ?? j).layout;
const small = (i) => !C[i].fixed && C[i].pins.length < 8;
const base = await evaluateRobust(b, L0, { router: 'native', detail: true });
const B = binMm(b);
for (const v of arg('variants', 'none,hot4,all').split(',')) {
  let pick = [];
  if (v.startsWith('hot')) {
    const n = Number(v.slice(3)), bins = new Set(Object.entries(base.overflowBins.round1).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => k));
    pick = C.map((c, i) => small(i) && bins.has(`${Math.floor(L0[i].x / B)},${Math.floor(L0[i].y / B)}`) ? i : -1).filter((i) => i >= 0);
  } else if (v.startsWith('ic:')) {
    const ic = C.findIndex((c) => c.id === v.slice(3)), pinsOf = new Set(C[ic].pins);
    const nets = b.p.nets.filter((n) => n.pins.some((p) => pinsOf.has(p)));
    const set = new Set(); for (const n of nets) for (const p of n.pins) { const k = b.p.pins[p].componentIndex; if (small(k)) set.add(k); }
    pick = [...set];
  } else if (v === 'all') pick = C.map((c, i) => small(i) ? i : -1).filter((i) => i >= 0);
  const L = L0.map((l, i) => pick.includes(i) ? { ...H[i] } : { ...l });
  const leg = legalize(b, L), m = v === 'none' ? base : await evaluateRobust(b, leg.layout, { router: 'native' });
  const row = { board: b.name, layout: src, variant: v, parts: pick.length, legalizerMoved: leg.moved, clean: m.clean, noiseClean: m.noise.clean, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin.overflowRound1, overflowRound5: m.margin.overflowRound5, converged: m.margin.phasesConverged };
  fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
}
