// Native router vs JS router on the same layouts: identical results expected (clean, vias, rounds,
// per-net status), and the speed-up. node harness/experiments/native-check.mjs --board k60 [--layout FILE] [--incremental] [--weight 1.5]
import fs from 'node:fs';
import { loadBoard } from '../lib/board.mjs';
import { routeBoard, evaluationRouting } from '../lib/router-gen.mjs';
import { routeBoardNative } from '../lib/native-router.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'k60')), src = arg('layout'), L = src ? JSON.parse(fs.readFileSync(src, 'utf8')) : b.a.originalLayout;
const board = { ...b.a.routing, pitch: 0.4 }, opts = { ...evaluationRouting(board), diagnostics: true, ...(argv.includes('--incremental') ? { incremental: true } : {}), ...(arg('weight') ? { astarWeight: Number(arg('weight')) } : {}), ...(argv.includes('--layer-h') ? { layerHeuristic: true } : {}) };
let t = performance.now(); const n = routeBoardNative(board, L, b.a.sides, opts); const ns = (performance.now() - t) / 1000;
t = performance.now(); const j = argv.includes('--no-js') ? null : routeBoard(board, L, b.a.sides, opts); const js = (performance.now() - t) / 1000;
const same = j && n.clean === j.clean && n.vias === j.vias && n.rounds === j.rounds && Math.abs(n.length - j.length) < 1e-6 && n.status.every((s, i) => s === j.status[i]) && n.netStats.every((s, i) => s.vias === j.netStats[i].vias);
console.log(JSON.stringify({ board: b.name, layout: src ? src.slice(-40) : 'human', opts: { incremental: !!opts.incremental, astarWeight: opts.astarWeight ?? 1, layerHeuristic: !!opts.layerHeuristic }, native: { s: +ns.toFixed(2), core: n.nativeSeconds, clean: n.clean, vias: n.vias, viaSites: n.viaSites, rounds: n.rounds }, js: j && { s: +js.toFixed(2), clean: j.clean, vias: j.vias, viaSites: j.viaSites, rounds: j.rounds }, identical: j ? same : 'not run', speedup: j ? +(js / ns).toFixed(1) : null }));
