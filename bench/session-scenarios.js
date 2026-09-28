// Interactive session scenarios shared by bench/session-bench.mjs (Node/Dawn) and
// web/latency.html (browser WebGPU), so both environments run the same workload.
//
// "drag" moves a random module part by 3-8 mm, locks it and re-places the nearest parts
// of its module; "redo" scatters a whole module (up to 60 parts) and re-places it.
import { rotatedSize, normalizeProblem } from '../src/problem.js';
import { PlacementSession } from '../src/session.js';
import { PriorityGpuBatchScorer } from '../src/gpu/batch-scorer.js';

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
export const pct = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r0 = (v) => Math.round(v), r1 = (v) => Math.round(v * 10) / 10;

/**
 * GPU submit -> mapAsync round trip of one tiny scoring dispatch (median / p90, ms).
 * This is the fixed cost every LNS iteration pays, whatever the population.
 */
export async function gpuRoundTrip(device, repeats = 60) {
  const problem = normalizeProblem({ canvas: { width: 10, height: 10 }, components: [{ id: 'a', width: 1, height: 1, pins: [{ id: 'p', x: 0, y: 0 }] }, { id: 'b', width: 1, height: 1, pins: [{ id: 'p', x: 0, y: 0 }] }], nets: [{ id: 'n', pins: [{ componentId: 'a', pinId: 'p' }, { componentId: 'b', pinId: 'p' }] }] });
  const scorer = new PriorityGpuBatchScorer(device, problem, { weights: { hpwl: 1, overlap: 200, bounds: 200, congestion: 0 }, coarse: { gridWidth: 16, gridHeight: 12, capacity: 4 } });
  const layout = [{ x: 2, y: 2, rotation: 0 }, { x: 8, y: 8, rotation: 0 }];
  for (let k = 0; k < 5; k++) await scorer.scoreLayouts([layout]);
  const times = [];
  for (let k = 0; k < repeats; k++) { const t = performance.now(); await scorer.scoreLayouts([layout]); times.push(performance.now() - t); }
  scorer.destroy();
  return { p50: pct(times, 0.5), p90: pct(times, 0.9) };
}

/**
 * Run drag/redo scenarios on one board for each budget.
 * @param options {name, problem, layout, device, budgets, drags, modes, onRow}
 * @returns {rows, createMs}
 */
export async function runSessionScenarios({ name, problem, layout, device, budgets = [50, 100, 200], drags = 20, modes = ['drag', 'redo'], onRow = null, debug = false }) {
  const tc = performance.now();
  const session = await PlacementSession.create(problem, layout, { device });
  const createMs = performance.now() - tc;
  const candidates = session.modules.flatMap((m) => m.members).filter((i) => !problem.components[i].fixed);
  const rows = [];
  let learned;
  for (const budget of budgets) {
    for (const mode of modes) {
      const rnd = rng32(7), times = [], newOverlaps = [], hpwlRatio = [], parts = [], attempts = [], lnsIters = [];
      const stage = { buildMs: [], globalMs: [], lnsMs: [], legalizeMs: [] };
      let slowest = null, lateRuns = 0, rejected = 0;
      const legalMs = [];
      const n = mode === 'drag' ? drags : Math.min(drags, session.modules.length);
      for (let k = 0; k < n; k++) {
        const s = new PlacementSession(problem, layout, { device, modules: session.modules });
        // An editor keeps one session: carry over what it learned about legalization cost.
        s.legalizeMsPerMcell = learned;
        let r;
        if (mode === 'drag') {
          const i = candidates[Math.floor(rnd() * candidates.length)], p = s.layout[i], [w, h] = rotatedSize(problem.components[i], p.rotation);
          const a = rnd() * 2 * Math.PI, d = 3 + 5 * rnd();
          const x = Math.min(problem.canvas.width - w / 2, Math.max(w / 2, p.x + d * Math.cos(a))), y = Math.min(problem.canvas.height - h / 2, Math.max(h / 2, p.y + d * Math.sin(a)));
          s.move(i, { x, y }); s.lock([i]);
          r = await s.relayout({ around: i, budgetMs: budget, seed: k + 1 });
        } else {
          const m = session.modules[k % session.modules.length];
          r = await s.relayout({ members: m.members.slice(0, 60), budgetMs: budget, scatter: true, seed: k + 1 });
        }
        learned = s.legalizeMsPerMcell;
        if (r.rejected) rejected++;
        if (!r.changed.length) continue;
        legalMs.push(r.attempts.reduce((s2, x) => s2 + (x.legalizeMs ?? 0), 0));
        if (r.attempts.some((x) => x.legalize?.lateParts)) lateRuns++;
        if (debug && r.timing.totalMs > budget + 20) console.error('slow', name, mode, Math.round(r.timing.totalMs), JSON.stringify(r.attempts.map((x) => Object.fromEntries(Object.entries(x).map(([k2, v]) => [k2, typeof v === 'number' ? Math.round(v) : v])))));
        times.push(r.timing.totalMs); parts.push(r.changed.length);
        newOverlaps.push(r.after.overlaps - r.before.overlaps);
        hpwlRatio.push(r.after.hpwl / r.before.hpwl);
        attempts.push(r.attempts.length);
        lnsIters.push(r.attempts.reduce((s2, x) => s2 + (x.lnsIterations ?? 0), 0));
        for (const key of Object.keys(stage)) stage[key].push(r.attempts.reduce((s2, x) => s2 + (x[key] ?? 0), 0));
        if (!slowest || r.timing.totalMs > slowest.totalMs) slowest = { totalMs: r.timing.totalMs, stages: Object.keys(stage).map((key) => r1(r.attempts.reduce((s2, x) => s2 + (x[key] ?? 0), 0))), parts: r.attempts[0]?.parts };
      }
      if (!times.length) continue;
      const row = {
        board: name, 'budget (ms)': budget, mode, 'runs (count)': times.length, 'parts re-placed, median (count)': pct(parts, 0.5),
        'time p50 / p90 / max (ms)': `${r0(pct(times, 0.5))} / ${r0(pct(times, 0.9))} / ${r0(Math.max(...times))}`,
        'runs over budget by > 20 ms (count)': times.filter((t) => t > budget + 20).length,
        'results rejected for adding overlaps (count)': rejected,
        'build / global / LNS / legalize, median (ms)': Object.values(stage).map((v) => r1(pct(v, 0.5))).join(' / '),
        'slowest run: build / global / LNS / legalize (ms)': slowest.stages.join(' / '),
        'slowest run: sub-problem parts incl. obstacles (count)': slowest.parts,
        'legalize p50 / p90 / max (ms)': `${r1(pct(legalMs, 0.5))} / ${r1(pct(legalMs, 0.9))} / ${r1(Math.max(...legalMs))}`,
        'runs where legalization hit the deadline (count)': lateRuns,
        'LNS iterations, median (count)': pct(lnsIters, 0.5),
        'attempts, median / max (count)': `${pct(attempts, 0.5)} / ${Math.max(...attempts)}`,
        'HPWL after / before, median (ratio)': +pct(hpwlRatio, 0.5).toFixed(2),
        'overlapping pairs added, median / max (count)': `${pct(newOverlaps, 0.5)} / ${Math.max(...newOverlaps)}`,
        'session create (ms)': r0(createMs),
      };
      rows.push(row);
      onRow?.(row);
    }
  }
  return { rows, createMs };
}

/** Pure-JS arithmetic loop (median ms): compares CPU speed across environments. */
export function cpuProbe() {
  const f = () => { let s = 0; const a = new Float64Array(1 << 16); for (let r = 0; r < 400; r++) for (let i = 0; i < a.length; i++) { a[i] = a[i] * 0.999 + Math.sqrt(i + r); s += a[i]; } return s; };
  f();
  const t = [];
  for (let k = 0; k < 7; k++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); }
  return pct(t, 0.5);
}
