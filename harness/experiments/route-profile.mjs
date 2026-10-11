// Where does routing time go? One routing with per-round timing and search counters
// (searches, cells popped, window cells, full-board fallback searches).
// node harness/experiments/route-profile.mjs --board ppc-n3 [--layout FILE] [--fast]
import fs from 'node:fs';
import { loadBoard } from '../lib/board.mjs';
import { routeBoard, evaluationRouting } from '../../core/src/router/board-router.js';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'ppc-n3')), src = arg('layout'), L = src ? JSON.parse(fs.readFileSync(src, 'utf8')) : b.a.originalLayout;
const board = { ...b.a.routing, pitch: 0.4 }, stats = {}, rows = [];
let t = performance.now(), last = { searches: 0, pops: 0, windowCells: 0, full: 0 }, full = 0;
const W = Math.ceil(board.canvas.width / 0.4), H = Math.ceil(board.canvas.height / 0.4);
const r = routeBoard(board, L, b.a.sides, { ...evaluationRouting(board), stats, ...(argv.includes('--fast') ? { incremental: true, maxRounds: 20, astarWeight: 1.5 } : {}),
  onWindow: (w) => { if (w[0] === 0 && w[1] === 0 && w[2] === W - 1 && w[3] === H - 1) full++; },
  onRound: ({ round, overflow }) => { const now = performance.now(); rows.push({ round, overflow, s: +((now - t) / 1000).toFixed(1), searches: stats.searches - last.searches, popsM: +((stats.pops - last.pops) / 1e6).toFixed(1), fullBoardSearches: full - last.full }); last = { ...stats, full }; t = now; } });
for (const x of rows) console.log(JSON.stringify(x));
console.log(JSON.stringify({ clean: r.clean, nets: r.nets, vias: r.vias, rounds: r.rounds, totalS: +rows.reduce((s, x) => s + x.s, 0).toFixed(1), grid: r.grid }));
