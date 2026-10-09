// Timing / sanity of lib/uncross.mjs: node harness/experiments/uncross-check.mjs --board B [--layout L.json] [--deadline ms]
import fs from 'node:fs';
import { loadBoard, legalize, placementMetrics, legalOk, worldPin, rotatedSize } from '../lib/board.mjs';
import { startLayout } from '../lib/init.mjs';
import { createUncross } from '../lib/uncross.mjs';
const uncross = createUncross({ worldPin, rotatedSize });
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), src = arg('layout');
const L = src ? (() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return (j.layout ?? j).map((q) => ({ ...q })); })() : legalize(b, startLayout(b, {}, { seed: 1 })).layout;
const u = uncross(b, L, { deadlineMs: Number(arg('deadline', 30000)) }), t = performance.now(), leg = legalize(b, u.layout);
const pm0 = placementMetrics(b, L), pm = placementMetrics(b, leg.layout);
console.log(JSON.stringify({ board: b.name, parts: b.p.components.length, ...u, layout: undefined, legalizeMs: Math.round(performance.now() - t), legalizerMoved: leg.moved, legalBefore: legalOk(pm0), legalUncrossed: legalOk(placementMetrics(b, u.layout)), legalAfter: legalOk(pm), hpwlMm: [pm0.hpwlMm, pm.hpwlMm] }));
