// Agent tool commands over one board session. Every candidate is the start layout of the agent's
// plan, the shared 0.1 mm legalizer and the detail pass (lib/detail.mjs); the benchmark router
// evaluates it. Cypress was removed on 2026-10-11 (no gain after the detail pass, RESULTS.md).
// State lives in the session dir, outside the agent's workspace.
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, legalOk, rotatedSize, worldPin, needsFastRouting, toolRouting } from '../lib/board.mjs';
import { startLayout } from '../lib/init.mjs';
import { detailPlace } from '../lib/detail.mjs';
import { lib } from '../lib/env.mjs';

const { placementMasks, blockedCells, maskCellRect } = await lib('src/geometry/mask.js');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${f}.tmp`, f); };
const r2 = (v) => Math.round(v * 100) / 100;

export async function initSession(dir, { board, seed = 1, reference = null }) {
  fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true });
  const b = loadBoard(board), human = await evaluateRobust(b, b.a.originalLayout, toolRouting(b));
  writeJson(path.join(dir, 'session.json'), { board, seed, next: 0, candidates: {}, best: null, submitted: null, placeCalls: 0, reference,
    target: { clean: human.clean, nets: human.nets, vias: human.vias, viaSites: human.viaSites, hpwlMm: human.hpwlMm, noise: human.noise, margin: human.margin } });
}

// Lexicographic: geometry legal, clean nets, then vias + HPWL relative to the human target.
export function rank(m, t) { return [legalOk(m) ? 1 : 0, m.clean, -(m.vias / t.vias + m.hpwlMm / t.hpwlMm)]; }
const better = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k]; return false; };

export function createSession(dir) {
  const file = path.join(dir, 'session.json'), state = () => readJson(file);
  const s0 = state(), b = loadBoard(s0.board);
  const comps = b.p.components, idx = new Map(comps.map((c, i) => [c.id, i]));
  const fp = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
  const layoutOf = (id) => readJson(path.join(dir, 'candidates', `${id}.json`)).layout;
  const pose = (L, i) => ({ x: r2(L[i].x), y: r2(L[i].y), rotation: L[i].rotation, side: L[i].side ? 'bottom' : 'top' });
  const powerNets = (ref) => [...new Set((fp.get(ref)?.pads ?? []).map((p) => p.net).filter((n) => n && !b.p.nets.some((x) => x.id === n)))];
  const netOfPin = new Int32Array(b.p.pins.length).fill(-1);
  b.p.nets.forEach((n, ni) => n.pins.forEach((pi) => { netOfPin[pi] = ni; }));
  const signalNets = (i) => [...new Set(b.p.nets.filter((n) => n.pins.some((pi) => b.p.pins[pi].componentIndex === i)).map((n) => n.id))];

  // Congestion hotspots: board areas (binMm squares) with most overflowing router cells when every
  // net takes its shortest path (round 1), averaged over grid phases, with the parts inside.
  const congestion = (m, L, n) => {
    const ob = m.overflowBins; if (!ob) return [];
    const total = Object.values(ob.round1).reduce((a, v) => a + v, 0) || 1, B = ob.binMm;
    return Object.entries(ob.round1).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => {
      const [i, j] = k.split(',').map(Number), x0 = i * B, y0 = j * B;
      const isBig = (q) => comps[q].pins.length >= 8 || comps[q].fixed;
      const overlaps = (q) => { const [w, h] = rotatedSize(comps[q], L[q].rotation); return L[q].x + w / 2 > x0 && L[q].x - w / 2 < x0 + B && L[q].y + h / 2 > y0 && L[q].y - h / 2 < y0 + B; };
      const big = comps.map((c, q) => (isBig(q) && overlaps(q)) ? q : -1).filter((q) => q >= 0).sort((p, q) => comps[q].pins.length - comps[p].pins.length);
      const small = comps.map((c, q) => (!isBig(q) && L[q].x >= x0 && L[q].x < x0 + B && L[q].y >= y0 && L[q].y < y0 + B) ? q : -1).filter((q) => q >= 0);
      return { areaMm: [x0, y0, x0 + B, y0 + B], overflowRound1: Math.round(v / ob.runs), shareOfAll: `${Math.round(100 * v / total)}%`, stillOverflowingAtEnd: Math.round((ob.end[k] ?? 0) / ob.runs * 10) / 10,
        ics: big.map((q) => `${comps[q].id}${comps[q].fixed ? '(fixed)' : ''}`), smallParts: small.length, smallRefs: small.slice(0, 12).map((q) => comps[q].id) };
    });
  };
  // PCB_MARGIN_FEEDBACK=0: tool output without routingMargin / congestion / fragileNets (prompt v7 baseline).
  const feedback = process.env.PCB_MARGIN_FEEDBACK !== '0';
  const shownTarget = (t) => { if (feedback || !t) return t; const { margin, ...rest } = t; return rest; };
  const marginOf = (m, s) => m.margin ? { ...m.margin, human: s.target.margin ?? null } : null;

  const commands = {
    info({ section = 'summary', page = 0, refs } = {}) {
      const s = state(), per = 60;
      if (section === 'summary') {
        const fixed = comps.map((c, i) => c.fixed ? { ref: c.id, footprint: fp.get(c.id)?.library, ...pose(b.a.originalLayout, i), size: [r2(c.width), r2(c.height)], signalPins: c.pins.length } : null).filter(Boolean);
        return { board: s.board, canvasMm: [r2(b.p.canvas.width), r2(b.p.canvas.height)], origin: 'top-left, y grows downward, mm', copperLayers: b.a.routing.layers,
          parts: comps.length, movable: comps.filter((c) => !c.fixed).length, signalNets: b.p.nets.length, humanTarget: shownTarget(s.target),
          fixedParts: fixed, note: 'Fixed parts (connectors, mechanical, through-hole) never move. Movable parts keep their assigned side. Power/ground nets are not routed or scored but are listed per part.' };
      }
      if (section === 'parts') {
        const list = comps.map((c, i) => c.fixed ? null : { ref: c.id, footprint: fp.get(c.id)?.library, side: c.sides === 'bottom' ? 'bottom' : 'top', size: [r2(c.width), r2(c.height)], signalPins: c.pins.length, nets: signalNets(i), power: powerNets(c.id) }).filter(Boolean)
          .sort((a, b2) => b2.signalPins - a.signalPins);
        return { page, pages: Math.ceil(list.length / per), parts: list.slice(page * per, (page + 1) * per) };
      }
      if (section === 'ics') {
        // IC-level connectivity in one call: every movable part with >= 8 signal pins, and its
        // strongest links (shared signal nets) to fixed parts and to other ICs.
        const ics = comps.map((c, i) => (!c.fixed && c.pins.length >= 8) ? i : -1).filter((i) => i >= 0);
        const isIc = new Set(ics), links = new Map(ics.map((i) => [i, new Map()]));
        for (const n of b.p.nets) {
          if (n.pins.length > 40) continue;
          const cs = [...new Set(n.pins.map((pi) => b.p.pins[pi].componentIndex))];
          for (const i of cs) if (isIc.has(i)) for (const j of cs) if (j !== i && (comps[j].fixed || isIc.has(j))) links.get(i).set(j, (links.get(i).get(j) ?? 0) + 1);
        }
        const list = ics.sort((a, c) => comps[c].pins.length - comps[a].pins.length).map((i) => ({ ref: comps[i].id, footprint: fp.get(comps[i].id)?.library, side: comps[i].sides === 'bottom' ? 'bottom' : 'top', size: [r2(comps[i].width), r2(comps[i].height)], signalPins: comps[i].pins.length,
          links: [...links.get(i)].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([j, k]) => `${comps[j].id}${comps[j].fixed ? '(fixed)' : ''}:${k}`) }));
        return { page, pages: Math.ceil(list.length / per), ics: list.slice(page * per, (page + 1) * per), note: 'links = ref:number of shared signal nets (nets with <= 40 pins). Fixed part positions are in `info`.' };
      }
      if (section === 'nets') {
        const list = b.p.nets.map((n) => ({ net: n.id, pins: n.pins.map((pi) => `${comps[b.p.pins[pi].componentIndex].id}.${b.p.pins[pi].pinId}`) }));
        return { page, pages: Math.ceil(list.length / per), nets: list.slice(page * per, (page + 1) * per) };
      }
      if (section === 'part') {
        if (!Array.isArray(refs) || !refs.length || refs.length > 16) throw new Error('info part needs refs: [1..16 refs]');
        return { parts: refs.map((ref) => {
          const i = idx.get(ref); if (i === undefined) throw new Error(`unknown ref ${ref}`);
          const c = comps[i], f = fp.get(ref);
          // Neighbours: parts sharing signal nets, with the count of shared nets.
          const nb = new Map();
          for (const n of b.p.nets) if (n.pins.some((pi) => b.p.pins[pi].componentIndex === i)) for (const pi of n.pins) { const j = b.p.pins[pi].componentIndex; if (j !== i) nb.set(comps[j].id, (nb.get(comps[j].id) ?? 0) + 1); }
          return { ref, footprint: f?.library, fixed: !!c.fixed, ...(c.fixed ? pose(b.a.originalLayout, i) : {}), side: c.sides === 'bottom' ? 'bottom' : 'top', size: [r2(c.width), r2(c.height)],
            signalPins: b.p.pins.map((q, pi) => [q, pi]).filter(([q]) => q.componentIndex === i).map(([q, pi]) => ({ pin: q.pinId, local: [r2(q.x), r2(q.y)], net: b.p.nets[netOfPin[pi]]?.id ?? null })),
            powerPads: powerNets(ref),
            neighbours: [...nb].sort((x, y) => y[1] - x[1]).slice(0, 24).map(([r, k]) => ({ ref: r, sharedNets: k, fixed: !!comps[idx.get(r)].fixed })) };
        }), note: 'Pin world position = (x, y) + R_r(sx * lx, ly), sx = -1 on the bottom side else 1, R_0(a,b)=(a,b), R_1=(-b,a), R_2=(-a,-b), R_3=(b,-a); y grows downward.' };
      }
      throw new Error('section must be summary | ics | parts | nets | part');
    },

    // ASCII floorplan per side: '#' keepout/outside, fixed bodies as their label, and (with a
    // candidate) movable parts with >= minPins pins as labels, smaller movable parts as '+'.
    map({ candidate, minPins = 8, cols = 100 } = {}) {
      const s = state(), L = candidate ? (s.candidates[candidate] ? layoutOf(candidate) : (() => { throw new Error(`unknown candidate ${candidate}`); })()) : b.a.originalLayout;
      const W = b.p.canvas.width, H = b.p.canvas.height, nc = Math.min(160, Math.max(40, cols)), cell = W / nc, nr = Math.ceil(H / cell / 2);
      const ch = cell * 2, masks = placementMasks(b.p), probe = comps.findIndex((c) => !c.fixed);
      const legend = {}, sides = {};
      const labels = new Map(); let next = 0;
      const tag = (ref) => { if (!labels.has(ref)) { const t = next < 26 ? String.fromCharCode(65 + next) : next < 52 ? String.fromCharCode(97 + next - 26) : String(next - 52); labels.set(ref, t); legend[t] = ref; next++; } return labels.get(ref); };
      for (const side of [0, 1]) {
        const g = Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => masks && blockedCells(masks, masks.componentLayers[probe], side, false, maskCellRect(masks, c * cell, r * ch, (c + 1) * cell, (r + 1) * ch)) > 0 ? '#' : '.'));
        comps.forEach((c, i) => {
          const show = c.fixed || candidate; if (!show) return;
          if (!c.twoSided && (L[i].side ? 1 : 0) !== side) return;
          const [w, h] = rotatedSize(c, L[i].rotation), big = c.fixed || c.pins.length >= minPins;
          const ch2 = big ? tag(c.id) : '+';
          for (let r = Math.max(0, Math.floor((L[i].y - h / 2) / ch)); r <= Math.min(nr - 1, Math.floor((L[i].y + h / 2 - 1e-6) / ch)); r++)
            for (let k = Math.max(0, Math.floor((L[i].x - w / 2) / cell)); k <= Math.min(nc - 1, Math.floor((L[i].x + w / 2 - 1e-6) / cell)); k++) g[r][k] = ch2;
        });
        sides[side ? 'bottom' : 'top'] = g.map((row) => row.join(''));
      }
      return { candidate: candidate ?? 'fixed parts only', cellMm: [r2(cell), r2(ch)], note: `column k covers x in [k*${r2(cell)}, (k+1)*${r2(cell)}) mm, row r covers y in [r*${r2(ch)}, (r+1)*${r2(ch)}) mm; through-hole fixed parts appear on both sides`, legend, ...sides };
    },

    // Cheap feasibility check of a plan: legalize the start layout only (no detail pass, no routing).
    check({ from = 'centroid', plan = {} } = {}) {
      const s = state();
      const base = from !== 'centroid' ? (s.candidates[from] ? layoutOf(from) : (() => { throw new Error(`unknown candidate ${from}`); })()) : null;
      const init = startLayout(b, plan, { seed: 1, base, jitterMm: 0 });
      const leg = legalize(b, init);
      // Rotation advisor: HPWL of the part's nets over pins of positioned parts only (fixed parts,
      // the planned parts, and with from=<candidate> every part), for each quarter turn.
      const known = new Set(comps.map((c, i) => (c.fixed || base || plan[c.id]) ? i : -1).filter((i) => i >= 0));
      const anchoredHpwl = (i, rot) => {
        const L = init.map((q, j) => j === i ? { ...q, rotation: rot } : q); let sum = 0;
        for (const n of b.p.nets) {
          if (!n.pins.some((pi) => b.p.pins[pi].componentIndex === i)) continue;
          const pts = n.pins.filter((pi) => known.has(b.p.pins[pi].componentIndex)).map((pi) => worldPin(b.p, L, pi));
          if (pts.length > 1 && pts.some((_, k) => b.p.pins[n.pins.filter((pi) => known.has(b.p.pins[pi].componentIndex))[k]].componentIndex !== i))
            sum += Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0])) + Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]));
        }
        return r2(sum);
      };
      const box = (L, j) => { const [w, h] = rotatedSize(comps[j], L[j].rotation); return [L[j].x - w / 2, L[j].y - h / 2, L[j].x + w / 2, L[j].y + h / 2]; };
      const hit = (a, c) => Math.min(a[2], c[2]) - Math.max(a[0], c[0]) > -0.1 && Math.min(a[3], c[3]) - Math.max(a[1], c[1]) > -0.1;
      const masks = placementMasks(b.p);
      const blockers = (i) => {
        const a = box(init, i), side = init[i].side ? 1 : 0, out = [];
        if (a[0] < 0 || a[1] < 0 || a[2] > b.p.canvas.width || a[3] > b.p.canvas.height) out.push('board edge');
        else if (masks && blockedCells(masks, masks.componentLayers[i], side, !!comps[i].twoSided, maskCellRect(masks, ...a)) > 0) out.push('keepout/outline');
        comps.forEach((c, j) => { if (j !== i && (c.fixed || plan[c.id]) && (c.twoSided || (init[j].side ? 1 : 0) === side) && hit(a, box(init, j))) out.push(`${c.id} (${c.fixed ? 'fixed' : 'planned'}, ${r2(box(init, j)[0])}..${r2(box(init, j)[2])} x ${r2(box(init, j)[1])}..${r2(box(init, j)[3])} y)`); });
        return out;
      };
      const planned = Object.keys(plan).map((ref) => { const i = idx.get(ref), byRot = [0, 1, 2, 3].map((r) => anchoredHpwl(i, r));
        const shift = r2(Math.hypot(leg.layout[i].x - init[i].x, leg.layout[i].y - init[i].y));
        return { ref, wanted: pose(init, i), bodyMm: box(init, i).map(r2), legalAt: pose(leg.layout, i), shiftMm: shift, ...(shift > 0.2 ? { blockedBy: blockers(i) } : {}), anchoredHpwlByRotation: byRot, bestRotation: byRot.indexOf(Math.min(...byRot)) }; });
      return { planned, note: 'shiftMm > 0: the wanted spot overlaps a fixed part, keepout, outline or another planned part (planned parts are legalized largest first). anchoredHpwlByRotation[r]: wirelength (mm) of the nets of this part to already-positioned parts if it had rotation r; lower is better.' };
    },

    async place({ from = 'centroid', plan = {}, knobs, netWeights, seed } = {}) {
      const s = state();
      let base = null;
      if (from !== 'centroid') { if (!s.candidates[from]) throw new Error(`unknown candidate ${from}; use "centroid" or an existing id`); base = layoutOf(from); }
      if (typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan must be {ref: {x, y, rotation}}');
      if (knobs !== undefined || netWeights !== undefined) throw new Error('knobs / netWeights no longer exist (Cypress was removed): give only from, plan and seed');
      for (const ref of Object.keys(plan)) if (comps[idx.get(ref)]?.fixed) throw new Error(`${ref} is fixed and cannot be planned`);
      const runSeed = Number.isInteger(seed) ? seed : s.seed * 1000 + s.next;
      const init = startLayout(b, plan, { seed: runSeed, base });
      const id = `c${String(s.next).padStart(3, '0')}`;
      // Time plan for one tool call (< 3 min end to end): detail pass (30 s; 60 s on > 1000 parts), then
      // routing until a deadline (one routing round on ppc can take 15-40 s, hence the margin).
      const t0 = performance.now(), big = needsFastRouting(b);
      const s2 = state(); s2.next++; s2.placeCalls++;
      let leg = legalize(b, init), detail = null;
      // Detailed placement of the small parts (lib/detail.mjs: HPWL + routing-channel term, annealed local
      // search; k60 tool layouts 504-547 -> ~420 vias). PCB_DETAIL=0 turns it off.
      if (process.env.PCB_DETAIL !== '0') {
        const d = detailPlace(b, leg.layout, { budgetS: big ? 60 : 30, seed: runSeed });
        leg = legalize(b, d.layout); detail = { evals: d.evals, accepted: d.accepted, seconds: d.seconds };
      }
      const m = await evaluateRobust(b, leg.layout, { detail: true, ...toolRouting(b), deadlineS: Math.max(15, 150 - (performance.now() - t0) / 1000) });
      const moved = comps.map((c, i) => [c.id, Math.hypot(leg.layout[i].x - init[i].x, leg.layout[i].y - init[i].y)]).filter(([ref, d]) => !comps[idx.get(ref)].fixed && d > 0).sort((x, y) => y[1] - x[1]);
      const { perNet, overflowBins, fragileNets = [], ...metrics } = m;
      writeJson(path.join(dir, 'candidates', `${id}.json`), { id, from, plan, seed: runSeed, legalizer: { failed: leg.failed, meanDisplacement: leg.meanDisplacement }, detail, metrics, perNet, overflowBins, fragileNets, layout: leg.layout, start: init });
      s2.candidates[id] = { id, from, planned: Object.keys(plan).length, metrics };
      const prev = s2.best && s2.candidates[s2.best];
      const accepted = !prev || better(rank(metrics, s2.target), rank(prev.metrics, s2.target));
      if (accepted) s2.best = id;
      writeJson(file, s2);
      if (!feedback) delete metrics.margin;
      return { candidate: id, best: s2.best, newBest: accepted, scoringNote: `clean/vias are medians over ${m.noise.shifts} routing-grid phases; metrics.noise gives their min-max. Two candidates whose clean/vias differ by less than that spread are equal within measurement noise.`, ...(m.margin?.timeLimited ? { routingNote: `routing stopped after ${m.routeRounds} rounds (time limit): clean/vias are a lower-quality estimate` } : {}), detailSeconds: detail?.seconds ?? 0, metrics, humanTarget: shownTarget(s2.target),
        ...(feedback ? { routingMargin: marginOf(m, s2), congestion: congestion(m, leg.layout, 4), fragileNets: { count: fragileNets.length, nets: fragileNets.slice(0, 12) } } : {}),
        failedNets: perNet.filter((n) => n.status !== 'clean').slice(0, 20).map((n) => n.net),
        mostViaNets: perNet.filter((n) => n.vias > 0).sort((x, y) => y.vias - x.vias).slice(0, 8).map((n) => `${n.net}:${n.vias}`),
        plannedDriftMm: Object.fromEntries(Object.keys(plan).map((ref) => { const i = idx.get(ref); return [ref, r2(Math.hypot(leg.layout[i].x - init[i].x, leg.layout[i].y - init[i].y))]; })),
        largestMovesFromStartMm: moved.slice(0, 8).map(([ref, d]) => `${ref}:${r2(d)}`) };
    },

    inspect({ candidate, refs, nets, congestion: cong } = {}) {
      const s = state(), id = candidate ?? s.best;
      if (!s.candidates[id]) throw new Error(`unknown candidate ${id}`);
      const c = readJson(path.join(dir, 'candidates', `${id}.json`)), L = c.layout;
      const { margin, ...shown } = c.metrics;
      const out = { candidate: id, metrics: feedback ? c.metrics : shown, ...(feedback ? { routingMargin: marginOf(c.metrics, s) } : {}) };
      if (cong && !feedback) throw new Error('unknown flag congestion');
      if (cong) { out.congestion = congestion({ overflowBins: c.overflowBins }, L, 10); out.fragileNets = c.fragileNets ?? []; }
      const want = refs === 'all' ? comps.map((x) => x.id) : refs;
      if (Array.isArray(want)) { if (want.length > 500) throw new Error('at most 500 refs'); out.poses = Object.fromEntries(want.map((ref) => { const i = idx.get(ref); if (i === undefined) throw new Error(`unknown ref ${ref}`); return [ref, pose(L, i)]; })); }
      if (nets === 'failed' || nets === 'fragile' || Array.isArray(nets)) {
        const sel = nets === 'failed' ? c.perNet.filter((n) => n.status !== 'clean').map((n) => n.net) : nets === 'fragile' ? (c.fragileNets ?? []) : nets;
        out.nets = sel.slice(0, 30).map((name) => {
          const ni = b.p.nets.findIndex((n) => n.id === name); if (ni < 0) throw new Error(`unknown net ${name}`);
          const pts = b.p.nets[ni].pins.map((pi) => { const [x, y] = worldPin(b.p, L, pi); return `${comps[b.p.pins[pi].componentIndex].id}@(${r2(x)},${r2(y)})`; });
          return { ...c.perNet[ni], pins: pts };
        });
      }
      return out;
    },

    status() {
      const s = state();
      return { board: s.board, placeCalls: s.placeCalls, best: s.best, submitted: s.submitted, humanTarget: shownTarget(s.target),
        candidates: Object.values(s.candidates).slice(-12).map((c) => ({ id: c.id, from: c.from, planned: c.planned, clean: c.metrics.clean, vias: c.metrics.vias, hpwlMm: c.metrics.hpwlMm, legal: legalOk(c.metrics) })) };
    },

    submit({ candidate } = {}) {
      const s = state();
      if (!s.candidates[candidate]) throw new Error(`unknown candidate ${candidate}`);
      s.submitted = candidate; writeJson(file, s);
      return { submitted: candidate, metrics: s.candidates[candidate].metrics };
    },

  };
  return commands;
}

export async function callTool(dir, command, input = {}, ctx = {}) {
  const log = path.join(dir, 'tools.jsonl'), t = performance.now();
  fs.appendFileSync(log, JSON.stringify({ type: 'call', command, input, at: new Date().toISOString() }) + '\n');
  let result;
  try {
    const cmds = createSession(dir);
    if (!cmds[command]) throw new Error(`unknown command ${command}; use info, map, check, place, inspect, status, submit`);
    result = await cmds[command](input, ctx);
  } catch (e) { result = { error: e.message }; }
  fs.appendFileSync(log, JSON.stringify({ type: 'result', command, seconds: (performance.now() - t) / 1000, result }) + '\n');
  return result;
}
