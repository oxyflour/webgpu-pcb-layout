import { normalizeProblem } from './problem.js';
import { autoModules } from './optimizer/modules.js';
import { relayoutMembers, moduleHpwl, memberOverlaps } from './optimizer/relayout.js';
import { PriorityGpuBatchScorer } from './gpu/batch-scorer.js';

/**
 * Interactive placement session: keeps a placed board, lets the user move and lock
 * parts, and re-places a module (or the parts around a moved part) within a time budget.
 *
 * GPU pipelines are compiled once when the session is created (Dawn/D3D12 needs ~0.5 s
 * per shader set); afterwards each re-placement builds its small sub-problem scorer
 * from the cached pipelines in well under a millisecond.
 *
 *   const s = await PlacementSession.create(problem, layout, { device });
 *   s.move(i, { x, y, rotation, side }); s.lock([i]);
 *   const r = await s.relayout({ around: i, budgetMs: 200 });
 */
export class PlacementSession {
  /** @param options.modules [{members:number[]}] (default: autoModules) */
  static async create(problemInput, layout, options = {}) {
    const problem = problemInput.componentIndex ? problemInput : normalizeProblem(problemInput);
    const s = new PlacementSession(problem, layout, options);
    if (options.device && options.warm !== false) await s.#warm();
    return s;
  }

  constructor(problem, layout, options = {}) {
    this.problem = problem;
    this.device = options.device ?? null;
    this.state = layout.map((p) => ({ ...p }));
    this.locked = new Set();
    this.modules = options.modules ?? autoModules(problem, { seed: options.seed ?? 1 }).modules;
    this.moduleOfPart = new Int32Array(problem.components.length).fill(-1);
    this.modules.forEach((m, k) => m.members.forEach((i) => { this.moduleOfPart[i] = k; }));
    this.options = { maxParts: options.maxParts ?? 60, budgetMs: options.budgetMs ?? 200, margin: options.margin ?? 2 };
  }

  /** Compile the sub-problem pipelines (with and without board masks) once. */
  async #warm() {
    const tiny = (canvas) => normalizeProblem({ canvas, components: [{ id: 'a', width: 1, height: 1, pins: [{ id: 'p', x: 0, y: 0 }] }, { id: 'b', width: 1, height: 1, pins: [{ id: 'p', x: 0, y: 0 }] }], nets: [{ id: 'n', pins: [{ componentId: 'a', pinId: 'p' }, { componentId: 'b', pinId: 'p' }] }] });
    const opts = { weights: { hpwl: 1, overlap: 200, bounds: 200, congestion: 0 }, coarse: { gridWidth: 16, gridHeight: 12, capacity: 4 } };
    for (const canvas of [{ width: 10, height: 10 }, { width: 10, height: 10, outline: [{ outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[4, 4], [6, 4], [6, 6], [4, 6]]] }] }]) {
      const s = new PriorityGpuBatchScorer(this.device, tiny(canvas), opts);
      await s.scoreLayouts([[{ x: 2, y: 2, rotation: 0 }, { x: 8, y: 8, rotation: 0 }]]);
      s.destroy();
    }
  }

  get layout() { return this.state.map((p) => ({ ...p })); }
  moduleOf(i) { return this.moduleOfPart[i]; }

  /** Lock parts (optionally moving them first); locked parts are never moved. */
  lock(indices, placements = null) {
    indices.forEach((i, k) => { if (placements?.[k]) this.state[i] = { ...this.state[i], ...placements[k] }; this.locked.add(i); });
  }
  unlock(indices) { for (const i of indices) this.locked.delete(i); }
  isLocked(i) { return this.locked.has(i) || !!this.problem.components[i].fixed; }

  /** User move of one part (does not lock it). */
  move(i, placement) { this.state[i] = { ...this.state[i], ...placement }; }

  /**
   * Re-place `members`, or the module of part `around` (its `maxParts` parts nearest to
   * it when the module is larger). Locked and fixed parts stay put. Stays within
   * `budgetMs`: GPU LNS stops early, and when parts cannot be legalized the region is
   * doubled while time remains.
   *
   * @returns {changed:number[], timing, attempts, before, after, applied}
   */
  async relayout({ members = null, around = null, budgetMs = this.options.budgetMs, scatter = false, seed = 1, apply = true } = {}) {
    const t0 = performance.now(), deadline = t0 + budgetMs;
    let set = members ? [...members] : this.#around(around);
    set = set.filter((i) => !this.isLocked(i));
    if (!set.length) return { changed: [], timing: { totalMs: 0 }, attempts: [], applied: false };
    const before = { hpwl: moduleHpwl(this.problem, this.state, set), overlaps: memberOverlaps(this.problem, this.state, set) };

    let layout = this.state, best = null, margin = this.options.margin;
    const attempts = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const remaining = deadline - performance.now();
      if (attempt > 0 && remaining < 20) break;
      const r = await relayoutMembers(this.problem, layout, set, {
        margin, scatter: scatter && attempt === 0, seed: seed + attempt, device: this.device, deadline,
        globalIterations: remaining > 60 ? 120 : 40,
      });
      attempts.push({ margin, ...r.timing, failed: r.stats.legalFailed, parts: r.stats.members + r.stats.obstacles });
      if (!best || r.stats.legalFailed < best.stats.legalFailed) best = r;
      if (!r.stats.legalFailed) break;
      layout = r.layout; margin *= 2;
    }
    const after = { hpwl: moduleHpwl(this.problem, best.layout, set), overlaps: memberOverlaps(this.problem, best.layout, set) };
    if (apply) for (const i of set) this.state[i] = best.layout[i];
    return { changed: set, layout: best.layout, before, after, attempts, applied: apply, timing: { totalMs: performance.now() - t0 } };
  }

  /** Members of the module around part i, nearest first, capped at maxParts (i included). */
  #around(i) {
    if (i === null || i === undefined) throw new Error('relayout needs members or around');
    const k = this.moduleOfPart[i];
    const pool = k >= 0 ? this.modules[k].members : [i];
    const p = this.state[i];
    const dist = (j) => Math.hypot(this.state[j].x - p.x, this.state[j].y - p.y);
    const out = [...new Set([i, ...pool])].sort((a, b) => dist(a) - dist(b)).slice(0, this.options.maxParts);
    return out;
  }
}
