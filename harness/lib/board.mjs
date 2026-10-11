// Load a registered board (KiCad case or IR file) with the core adapter, and evaluate
// layouts with the benchmark protocol: 0.1 mm legalization, strict geometry, PathFinder
// routing on the board's layers at 0.4 mm (clean nets, vias) and unweighted signal HPWL.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BOARDS_ROOT, HARNESS_ROOT, REPO_ROOT, required } from './env.mjs';

import { parseKicadBoard, designToProblem, kicadToIR } from '../../core/src/kicad/adapter.js';
import { irToProblem } from '../../core/src/ir/to-problem.js';
import * as P from '../../core/src/problem.js';
// Core router (core/src/router/board-router.js; harness hooks: deadline, weighted A*, viaSites, ...).
import { routeBoard, evaluationRouting } from '../../core/src/router/board-router.js';
const { routeBoardNative, nativeAvailable } = await import('./native-router.mjs');

// Routing used inside agent tool calls and for the human target. Native router (native/build.cmd);
// boards > 1000 parts add the layer-aware A* heuristic and incremental rip-up: on 16 ppc-n3 layouts
// identical clean counts and Spearman 0.974 of vias against exact routing, ~10x faster
// (experiments/rank-check.mjs). Smaller boards: exact routing (native = bit-identical to JS).
export const toolRouting = (b) => !nativeAvailable() ? (needsFastRouting(b) ? { fast: 'weighted' } : {}) : needsFastRouting(b) ? { router: 'native', layerHeuristic: true, incremental: true } : { router: 'native' };
// Final evaluation: exact routing (native build when available, same result as JS).
export const exactRouting = () => nativeAvailable() ? { router: 'native' } : {};
import { repositoryMetrics } from '../../core/bench/repository-metrics.mjs';
import { legalizeLayout } from '../../core/src/optimizer/legalizer.js';
import { KICAD_CASES } from '../../core/bench/kicad-cases.mjs';
export const { normalizeProblem, rotatedSize, worldPin } = P;

// Registered boards: the benchmark KiCad cases (core/bench/kicad-cases.mjs, paths relative to boardsRoot) and the local
// registry harness/boards.json {"name": "path"} (a .kicad_pcb or an IR .json = kicadToIR output; paths
// relative to the repository root or absolute). EVAL_BOARDS: the default board list of the sweeps.
const LOCAL = (() => { const f = path.join(HARNESS_ROOT, 'boards.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; })();
export const BOARDS = { ...Object.fromEntries(KICAD_CASES.map(([k, v]) => [k, BOARDS_ROOT ? path.join(BOARDS_ROOT, v) : null])), ...Object.fromEntries(Object.entries(LOCAL).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, path.resolve(REPO_ROOT, v)])) };
export const EVAL_BOARDS = [...new Set(['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp', 'safety', 'pic', 'nxp', 'rx', 'k60', 'acc', 'ppc-n3', ...Object.keys(LOCAL).filter((k) => !k.startsWith('_'))])];

// locks: {ref: {x,y,rotation,side}} extra components held fixed.
// only: Set of refs -> sub-board with just these footprints (same outline, rules and adapter path;
// nets keep only the pins of these parts), e.g. one module.
const parsed = new Map();
export function loadBoard(name, { locks = {}, only = null } = {}) {
  if (!BOARDS[name]) throw new Error(`Unknown board ${name}; known: ${Object.keys(BOARDS).join(', ')}`);
  const file = required(BOARDS[name], 'boardsRoot', 'PCB_BOARDS_ROOT', `board ${name} is a benchmark KiCad case (core/bench/kicad-cases.mjs) under the boards checkout`), isIr = file.endsWith('.json');
  if (!parsed.has(name)) { const text = fs.readFileSync(file, 'utf8'); parsed.set(name, { text, sha256: crypto.createHash('sha256').update(text).digest('hex'), ir: isIr ? JSON.parse(text) : kicadToIR(parseKicadBoard(text, name)) }); }
  const { text, sha256, ir } = parsed.get(name), copy = () => JSON.parse(JSON.stringify(ir));
  // An IR file goes through irToProblem (same problem as the KiCad path: checked on k60).
  const a = only ? irToProblem({ ...copy(), footprints: copy().footprints.filter((f) => only.has(f.id)) }, { preplace: true, sides: 'original' }) : isIr ? irToProblem(copy(), { preplace: true, sides: 'original' }) : designToProblem(parseKicadBoard(text, name), { preplace: true, sides: 'original' });
  // Through-hole parts stay at their input pose (benchmark protocol: mechanical + THT fixed).
  a.input.components.forEach((c, i) => { if (c.twoSided && !c.fixed) c.fixed = { ...a.originalLayout[i] }; });
  const fixedByInput = new Set(a.input.components.filter((c) => c.fixed).map((c) => c.id));
  for (const [ref, pose] of Object.entries(locks)) {
    const c = a.input.components.find((c) => c.id === ref);
    if (!c) throw new Error(`lock: unknown ref ${ref}`);
    if (fixedByInput.has(ref)) continue;
    c.fixed = { x: pose.x, y: pose.y, rotation: pose.rotation ?? 0, side: c.sides === 'bottom' ? 1 : 0 };
  }
  const p = normalizeProblem(a.input);
  return { name, file, format: isIr ? 'ir' : 'kicad', sha256, a, p, fixedByInput, ...(only ? { only } : {}) };
}

export function legalize(b, layout) {
  const t = performance.now(), r = legalizeLayout(b.p, layout, { clearance: 0.1 });
  const nudged = nudgeTinyOverlaps(b, r.layout);
  return { layout: r.layout, failed: r.failed, nudged, moved: r.moved, maxDisplacement: r.maxDisplacement, meanDisplacement: r.meanDisplacement, ms: performance.now() - t };
}

// The shared legalizer works on a grid (0.19 mm cells on ppc) and left 3-16 um overlaps between
// movable parts and off-grid fixed parts (ppc v5: 1-4 pairs per layout). Push the movable part
// out along the shorter axis; only overlaps below 0.2 mm are touched, others stay visible.
function nudgeTinyOverlaps(b, L, limit = 0.2) {
  const C = b.p.components, box = (i) => { const [w, h] = rotatedSize(C[i], L[i].rotation); return [L[i].x - w / 2, L[i].y - h / 2, L[i].x + w / 2, L[i].y + h / 2]; };
  const boxes = C.map((_, i) => box(i));
  let nudged = 0;
  for (let i = 0; i < C.length; i++) for (let j = 0; j < C.length; j++) {
    if (i === j || C[i].fixed || (!C[j].fixed && j < i) || !P.sharesSide(b.p, i, L[i], j, L[j])) continue;
    const a = boxes[i], c = boxes[j], ox = Math.min(a[2], c[2]) - Math.max(a[0], c[0]), oy = Math.min(a[3], c[3]) - Math.max(a[1], c[1]);
    if (!(ox > 1e-6 && oy > 1e-6) || Math.min(ox, oy) > limit) continue;
    if (ox <= oy) L[i].x += (L[i].x < L[j].x ? -1 : 1) * (ox + 1e-4); else L[i].y += (L[i].y < L[j].y ? -1 : 1) * (oy + 1e-4);
    boxes[i] = box(i); nudged++;
  }
  return nudged;
}

// Full metrics of an already legal layout. Routing details include per-net status when asked.
// Same routing call as bench/pipeline.mjs routeStats (board layers, 0.4 mm, 40 rounds).
// fast: incremental PathFinder capped at 20 rounds with weighted A* (w 1.5), used inside agent
// tool calls on boards with > 1000 parts (ppc-n3 human: incremental 146 s -> 44 s, 8729 -> 8802
// vias; weighted A* 46 s -> 20 s). Weighted A* checked on 33 ppc-n3 candidates against exact
// routing: identical clean counts, vias x1.08-1.13, Spearman 0.998 on (clean, vias), same best
// candidate in 5 of 6 sessions (the other within 0.5 % vias). Final evaluation stays exact.
export const needsFastRouting = (b) => b.p.components.length > 1000;
// deadlineS: stop routing after the round that passes it (partial negotiation, reported).
// onRound({round, overflow}): per-round progress (e.g. to log long evaluations to disk).
// shift k: route with the 0.4 mm grid's phase moved by k/3 cell in x and y (board outline and every
// part translated together; the layout is physically unchanged). See evaluateRobust.
export const SHIFT_MM = 0.4 / 3;
// offset [dx, dy] (mm) instead of k: any grid phase (experiments).
export function shiftedRouting(b, layout, k, offset = null) {
  const r = b.a.routing;
  if (!k && !offset) return { board: { ...r, pitch: 0.4 }, layout };
  const [dx, dy] = offset ?? [k * SHIFT_MM, k * SHIFT_MM], d = Math.max(dx, dy), mv = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
  if (r.blocked?.length) throw new Error('shiftedRouting: blocked areas not handled');
  return {
    board: { ...r, pitch: 0.4, canvas: { ...r.canvas, width: r.canvas.width + d, height: r.canvas.height + d }, outline: r.outline?.map((o) => ({ ...o, outer: mv(o.outer), ...(o.holes ? { holes: o.holes.map(mv) } : {}) })) },
    layout: layout.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })),
  };
}
// router 'native': native/router.cpp (bit-identical to the JS router unless layerHeuristic);
// layerHeuristic: A* also counts the layer changes still needed (native only); incremental: rip-up
// only nets on overflowing cells after the first round.
// Geometry and HPWL only (no routing).
export function placementMetrics(b, layout) {
  const rm = repositoryMetrics(b.p, layout), g = rm.geometry;
  return { hpwlMm: Math.round(rm.metrics.hpwl_mm * 10) / 10, geometry: { overlaps: g.movableOverlapPairs, clearance: g.movableClearancePairs, outside: g.movableOutside, keepout: g.movableMaskViolations, fixedChanged: g.fixed_changed, sideChanged: g.side_changed } };
}
export function evaluate(b, layout, { detail = false, fast = false, deadlineS = null, onRound = null, shift = 0, router = 'js', layerHeuristic = false, incremental = false, cleanup = 0, offset = null, netRules = null } = {}) {
  const pm = placementMetrics(b, layout);
  const sr = shiftedRouting(b, layout, shift, offset), board = sr.board, t = performance.now();
  const route = router === 'native' ? routeBoardNative : routeBoard;
  if ((layerHeuristic || cleanup || netRules?.length) && router !== 'native') throw new Error('layerHeuristic / cleanup / netRules need router native');
  const r = route(board, sr.layout, b.a.sides, { ...evaluationRouting(board), diagnostics: detail, ...(fast === 'weighted' ? { incremental: true, maxRounds: 20, astarWeight: 1.5 } : fast || incremental ? { incremental: true } : {}), ...(layerHeuristic ? { layerHeuristic } : {}), ...(cleanup ? { cleanup } : {}), ...(netRules?.length ? { netRules } : {}), ...(detail && router === 'native' ? { emitOverflow: true } : {}), ...(deadlineS ? { deadline: t + deadlineS * 1000 } : {}), ...(onRound ? { onRound } : {}) });
  const m = {
    clean: r.clean, nets: r.nets, vias: r.vias, viaSites: r.viaSites, routedLengthMm: Math.round(r.length), hpwlMm: pm.hpwlMm, geometry: pm.geometry,
    routeMs: Math.round(performance.now() - t), routing: `${router}${layerHeuristic ? '-layerh' : ''}-${fast === 'weighted' ? 'incremental-20-astar1.5' : fast || incremental ? 'incremental-40' : 'full-40'}${cleanup ? `-cleanup${cleanup}` : ''}`, ...(shift ? { shift } : {}), routeRounds: r.rounds, routeConverged: r.overflow === 0, ...(r.cleanup ? { cleanup: r.cleanup } : {}),
  };
  // Routing margin (experiments/why-stable.mjs): overflow 0 at the end <=> clean nets do not depend on
  // the grid phase. overflowRound1 = cells claimed by > 1 net when every net takes its shortest path.
  if (r.roundOverflow) {
    const ro = r.roundOverflow, z = ro.indexOf(0);
    m.margin = { overflowRound1: ro[0], overflowRound5: ro[Math.min(4, ro.length - 1)], roundsToZero: z < 0 ? null : z + 1, timeLimited: z < 0 && r.rounds < (evaluationRouting(board).maxRounds ?? 40) && !!deadlineS };
  }
  if (r.overflowCells) m.overflowBins = overflowBins(b, r, offset ?? [shift * SHIFT_MM, shift * SHIFT_MM]);
  if (detail) {
    if (board.netCount !== b.p.nets.length) throw new Error('router net indexing differs from problem nets');
    m.perNet = b.p.nets.map((n, i) => ({ net: n.id, status: ['?', 'clean', 'overflow', 'open'][r.status[i]], vias: r.netStats[i].vias, lengthMm: Math.round(r.netStats[i].lengthMm * 10) / 10 }));
  }
  return m;
}

// Overflowing cells binned on the board (mm, grid offset removed): {binMm, round1: {"i,j": n}, end}.
export const binMm = (b) => Math.max(4, Math.round(Math.min(b.p.canvas.width, b.p.canvas.height) / 10));
function overflowBins(b, r, [dx, dy]) {
  const { W, cell } = r.grid, P = r.overflowCells.P, B = binMm(b);
  const bin = (cells) => { const o = {}; for (const c of cells) { const q = c % P, x = (q % W + 0.5) * cell - dx, y = Math.floor(q / W + 1e-9) * cell + cell / 2 - dy; const k = `${Math.floor(x / B)},${Math.floor(y / B)}`; o[k] = (o[k] ?? 0) + 1; } return o; };
  return { binMm: B, round1: bin(r.overflowCells.round1), end: bin(r.overflowCells.end) };
}

export const legalOk = (m) => m.geometry.overlaps === 0 && m.geometry.outside === 0 && m.geometry.keepout === 0 && m.geometry.fixedChanged === 0 && m.geometry.sideChanged === 0;

// Router noise (experiments/router-noise.mjs): the same layout routed with another grid phase or
// 0.01 mm jitter changes ppc-n3 by +-150 vias and up to 7 clean nets, congested k60 layouts by up to
// 30 clean nets. evaluateRobust routes `shifts` grid phases in parallel worker threads and reports
// Phase k moves the grid by k/shifts cell (k/3 before 2026-10-08: with 5 shifts, 4 repeated 1).
// the median of each routing metric (clean, vias, viaSites, length) and their spread (min-max).
// perNet (detail) comes from the run whose via count is the median.
const sumBins = (list) => { const o = {}; for (const x of list) for (const [k, v] of Object.entries(x)) o[k] = (o[k] ?? 0) + v; return o; };
export const defaultShifts = (b) => needsFastRouting(b) ? 3 : 5;
export async function evaluateRobust(b, layout, { shifts = defaultShifts(b), ...opts } = {}) {
  const { Worker } = await import('node:worker_threads');
  const { onRound, ...plain } = opts;
  const runs = await Promise.all(Array.from({ length: shifts }, (_, k) => new Promise((resolve, reject) => {
    const w = new Worker(new URL('./eval-worker.mjs', import.meta.url), { execArgv: [], workerData: { name: b.name, layout, opts: { ...plain, shift: k, ...(k ? { offset: [k * 0.4 / shifts, k * 0.4 / shifts] } : {}) } } });
    w.once('message', resolve); w.once('error', reject);
    w.once('exit', (c) => { if (c) reject(new Error(`eval worker exit ${c}`)); });
  })));
  const med = (k) => { const v = runs.map((m) => m[k]).sort((x, y) => x - y); return v[(v.length - 1) >> 1]; };
  const span = (k) => [Math.min(...runs.map((m) => m[k])), Math.max(...runs.map((m) => m[k]))];
  const { shift, ...byVias } = [...runs].sort((x, y) => x.vias - y.vias)[(runs.length - 1) >> 1];
  const out = { ...byVias, clean: med('clean'), vias: med('vias'), viaSites: med('viaSites'), routedLengthMm: med('routedLengthMm'),
    routeConverged: runs.every((m) => m.routeConverged), routeMs: Math.max(...runs.map((m) => m.routeMs)),
    noise: { shifts, clean: span('clean'), vias: span('vias'), viaSites: span('viaSites') } };
  delete out.overflowBins;
  if (runs.every((m) => m.margin)) {
    const mm = (f) => { const v = runs.map(f).sort((x, y) => x - y); return v[(v.length - 1) >> 1]; }, z = runs.filter((m) => m.margin.roundsToZero);
    out.margin = { overflowRound1: mm((m) => m.margin.overflowRound1), overflowRound5: mm((m) => m.margin.overflowRound5), phasesConverged: `${z.length}/${runs.length}`,
      roundsToZero: z.length ? z.map((m) => m.margin.roundsToZero).sort((x, y) => x - y)[(z.length - 1) >> 1] : null, timeLimited: runs.some((m) => m.margin.timeLimited) };
  }
  if (runs.every((m) => m.overflowBins)) out.overflowBins = { binMm: runs[0].overflowBins.binMm, runs: runs.length, round1: sumBins(runs.map((m) => m.overflowBins.round1)), end: sumBins(runs.map((m) => m.overflowBins.end)) };
  if (runs.every((m) => m.perNet)) out.fragileNets = runs[0].perNet.map((n, i) => { const c = runs.filter((m) => m.perNet[i].status === 'clean').length; return c > 0 && c < runs.length ? n.net : null; }).filter(Boolean);
  return out;
}
