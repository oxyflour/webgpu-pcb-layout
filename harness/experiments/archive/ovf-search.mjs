// Routing-aware detailed placement (offline test): greedy local search on small parts (movable,
// < 8 pins) that lowers the round-1 overflow of the benchmark router (cells claimed by > 1 net
// after one routing pass; Pearson 0.98 with final vias over 126 k60 layouts). Moves: shift by
// 0.4-2 mm, quarter turn, swap with a same-size part within 6 mm; parts are picked near overflow
// cells. Legal moves only (no overlap at 0.1 mm clearance on a shared side, inside the canvas).
// cost = mean round-1 overflow over --phases grid phases (native router, 1 round, ~0.05 s each).
// node harness/experiments/ovf-search.mjs --board k60 --layout L.json --evals 800 --out FILE [--save F] [--tag T] [--phases 2]
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust, shiftedRouting, rotatedSize, worldPin } from '../../lib/board.mjs';
import { routeBoardNative } from '../../lib/native-router.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, n = C.length, evals = Number(arg('evals', 800)), phases = Number(arg('phases', 2)), seed = Number(arg('seed', 1));
const src = arg('layout'), L = (() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return (j.layout ?? j).map((q) => ({ ...q })); })();
let s = seed * 2654435761 >>> 0; const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296), pickOf = (a) => a[Math.floor(rnd() * a.length)];
const W = p.canvas.width, Hh = p.canvas.height, CL = 0.1;
const small = [...Array(n).keys()].filter((i) => !C[i].fixed && C[i].pins.length < 8);
const box = (i, q = L[i]) => { const [w, h] = rotatedSize(C[i], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
const shares = (i, j) => C[i].twoSided || C[j].twoSided || L[i].side === L[j].side;
const legalAt = (i, skip = -1) => { const a = box(i); if (a[0] < 0 || a[1] < 0 || a[2] > W || a[3] > Hh) return false;
  for (let j = 0; j < n; j++) { if (j === i || j === skip || !shares(i, j)) continue; const c = box(j); if (a[0] < c[2] + CL && c[0] < a[2] + CL && a[1] < c[3] + CL && c[1] < a[3] + CL) return false; } return true; };
// Start must itself be legal for the check to mean anything.
// Grid phases for the search, disjoint from the evaluation's diagonal phases k * 0.08 mm (no grid exploits).
const offs = Array.from({ length: phases }, (_, k) => [0.4 * (k + 0.5) / phases, 0.4 * (((k * 3 + 1) % phases) + 0.5) / phases]);
let cells = [];
const cost = (keepCells = false) => { let sum = 0; const cs = [];
  for (const o of offs) { const sr = shiftedRouting(b, L, 0, o); const r = routeBoardNative(sr.board, sr.layout, b.a.sides, { cell: 0.4, maxRounds: 1, emitOverflow: keepCells });
    sum += r.roundOverflow[0]; if (keepCells) { const Wg = r.grid.W, P = r.overflowCells.P, d = o[0], e = o[1]; for (const c of r.overflowCells.round1) { const q = c % P; cs.push([(q % Wg + 0.5) * 0.4 - d, (Math.floor(q / Wg) + 0.5) * 0.4 - e]); } } }
  if (keepCells) cells = cs; return sum / offs.length; };
const t0 = performance.now();
let cur = cost(true); const start = cur; let accepted = { shift: 0, turn: 0, swap: 0 }, tried = 0;
const near = (x, y, r) => small.filter((i) => { const a = box(i); return x > a[0] - r && x < a[2] + r && y > a[1] - r && y < a[3] + r; });
while (tried < evals && cells.length) {
  const [cx, cy] = pickOf(cells), cand = near(cx, cy, 1.5); if (!cand.length) { cells = cells.filter((c) => c[0] !== cx || c[1] !== cy); continue; }
  const i = pickOf(cand), old = { ...L[i] }, kind = rnd();
  let j = -1, oldJ = null, type;
  if (kind < 0.55) { type = 'shift'; const st = pickOf([0.4, 0.8, 1.2, 2]); const dir = pickOf([[1, 0], [-1, 0], [0, 1], [0, -1]]); L[i] = { ...old, x: old.x + dir[0] * st, y: old.y + dir[1] * st }; }
  else if (kind < 0.8) { type = 'turn'; if (C[i].rotatable === false) continue; L[i] = { ...old, rotation: (old.rotation + pickOf([1, 2, 3])) % 4 }; }
  else { type = 'swap'; const sz = rotatedSize(C[i], old.rotation).map((v) => v.toFixed(2)).join();
    const others = small.filter((k) => k !== i && L[k].side === old.side && Math.hypot(L[k].x - old.x, L[k].y - old.y) < 6 && [0, 1].some((r) => rotatedSize(C[k], (L[k].rotation + r) % 4).map((v) => v.toFixed(2)).join() === sz));
    if (!others.length) continue; j = pickOf(others); oldJ = { ...L[j] };
    const rj = rotatedSize(C[j], oldJ.rotation).map((v) => v.toFixed(2)).join() === sz ? oldJ.rotation : (oldJ.rotation + 1) % 4, ri = rotatedSize(C[i], old.rotation).map((v) => v.toFixed(2)).join() === rotatedSize(C[j], oldJ.rotation).map((v) => v.toFixed(2)).join() ? old.rotation : (old.rotation + 1) % 4;
    L[i] = { ...old, x: oldJ.x, y: oldJ.y, rotation: ri }; L[j] = { ...oldJ, x: old.x, y: old.y, rotation: rj }; }
  if (!legalAt(i, j) || (j >= 0 && !legalAt(j, i))) { L[i] = old; if (j >= 0) L[j] = oldJ; continue; }
  tried++;
  const c = cost(); if (c < cur) { cur = c; accepted[type]++; cost(true); }
  else { L[i] = old; if (j >= 0) L[j] = oldJ; }
}
const searchS = (performance.now() - t0) / 1000;
const leg = legalize(b, L);
if (arg('save')) fs.writeFileSync(arg('save'), JSON.stringify(leg.layout));
const m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
const row = { board: b.name, layout: src, tag: arg('tag'), evals: tried, phases, searchS: Math.round(searchS), ovf1: [Math.round(start), Math.round(cur)], accepted, legalizerMoved: leg.moved, clean: m.clean, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
