// Load a registered KiCad case exactly as bench/cypress/compare.mjs does, and evaluate
// layouts with the benchmark protocol: 0.1 mm legalization, strict geometry, PathFinder
// routing on the board's layers at 0.4 mm (clean nets, vias) and unweighted signal HPWL.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lib, PLACER_ROOT } from './env.mjs';

const { parseKicadBoard, designToProblem } = await lib('src/kicad/adapter.js');
const P = await lib('src/problem.js');
// Adapter router with harness hooks (deadline, weighted A*, ...): see router-gen.mjs.
const { routeBoard, evaluationRouting } = await import('./router-gen.mjs');
const { repositoryMetrics } = await lib('bench/cypress/repository-metrics.mjs');
const { legalizeLayout } = await lib('src/optimizer/legalizer.js');
const { KICAD_CASES } = await lib('bench/kicad-cases.mjs');
export const { normalizeProblem, rotatedSize, worldPin } = P;

export const BOARDS = Object.fromEntries(KICAD_CASES);

// locks: {ref: {x,y,rotation,side}} extra components held fixed (exported as Cypress terminals).
export function loadBoard(name, { locks = {} } = {}) {
  if (!BOARDS[name]) throw new Error(`Unknown board ${name}; known: ${Object.keys(BOARDS).join(', ')}`);
  const file = path.join(PLACER_ROOT, BOARDS[name]), text = fs.readFileSync(file, 'utf8');
  const a = designToProblem(parseKicadBoard(text, name), { preplace: true, sides: 'original' });
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
  return { name, file, sha256: crypto.createHash('sha256').update(text).digest('hex'), a, p, fixedByInput };
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
export function evaluate(b, layout, { detail = false, fast = false, deadlineS = null, onRound = null } = {}) {
  const rm = repositoryMetrics(b.p, layout);
  const board = { ...b.a.routing, pitch: 0.4 }, t = performance.now();
  const r = routeBoard(board, layout, b.a.sides, { ...evaluationRouting(board), diagnostics: detail, ...(fast ? { incremental: true, maxRounds: 20, astarWeight: 1.5 } : {}), ...(deadlineS ? { deadline: t + deadlineS * 1000 } : {}), ...(onRound ? { onRound } : {}) });
  const g = rm.geometry;
  const m = {
    clean: r.clean, nets: r.nets, vias: r.vias, routedLengthMm: Math.round(r.length), hpwlMm: Math.round(rm.metrics.hpwl_mm * 10) / 10,
    geometry: { overlaps: g.movableOverlapPairs, clearance: g.movableClearancePairs, outside: g.movableOutside, keepout: g.movableMaskViolations, fixedChanged: g.fixed_changed, sideChanged: g.side_changed },
    routeMs: Math.round(performance.now() - t), routing: fast ? 'incremental-20-astar1.5' : 'full-40', routeRounds: r.rounds, routeConverged: r.overflow === 0,
  };
  if (detail) {
    if (board.netCount !== b.p.nets.length) throw new Error('router net indexing differs from problem nets');
    m.perNet = b.p.nets.map((n, i) => ({ net: n.id, status: ['?', 'clean', 'overflow', 'open'][r.status[i]], vias: r.netStats[i].vias, lengthMm: Math.round(r.netStats[i].lengthMm * 10) / 10 }));
  }
  return m;
}

export const legalOk = (m) => m.geometry.overlaps === 0 && m.geometry.outside === 0 && m.geometry.keepout === 0 && m.geometry.fixedChanged === 0 && m.geometry.sideChanged === 0;
