// Causal test for the fan-out ring: legalize a layout with every IC (movable, >= 8 pins) held at
// its pose and inflated by --gap mm on each side, so small parts leave the ring around the ICs;
// then the normal legalizer and evaluation. Optional uncross output (experiments/uncross.mjs) as input.
// node harness/experiments/ic-ring.mjs --board k60 --layout L.json --gap 1 --out FILE [--tag T] [--save F]
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust } from '../../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), C = b.p.components, gap = Number(arg('gap', 1)), src = arg('layout');
const L0 = src === 'human' ? legalize(b, b.a.originalLayout).layout : (() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return j.layout ?? j; })();
const isIc = (i) => !C[i].fixed && C[i].pins.length >= 8;
const p2 = { ...b.p, components: C.map((c, i) => isIc(i) ? { ...c, width: c.width + 2 * gap, height: c.height + 2 * gap, fixed: { ...L0[i] } } : c) };
const r1 = legalize({ ...b, p: p2 }, L0), leg = legalize(b, r1.layout);
if (arg('save')) fs.writeFileSync(arg('save'), JSON.stringify(leg.layout));
const m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
const row = { board: b.name, layout: src, tag: arg('tag'), gap, ringMoved: r1.moved, ringFailed: r1.failed, meanMoveMm: +(r1.meanDisplacement ?? 0).toFixed(2), clean: m.clean, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
