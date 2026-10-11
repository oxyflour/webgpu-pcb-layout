import { normalizeProblem, rotatedSize } from './problem.js';
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
  /**
   * @param options.modules [{members:number[], region?: {x,y,width,height}}] (default:
   *        autoModules). A module region is where relayout({ members }) of that module
   *        re-places its parts.
   */
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
    // maxRegionParts caps the parts (members + obstacles) inside the re-placed region, so a
    // module spread over the board does not turn a drag into a board-sized sub-problem.
    this.options = { maxParts: options.maxParts ?? 60, maxRegionParts: options.maxRegionParts ?? 120, budgetMs: options.budgetMs ?? 200, margin: options.margin ?? 2 };
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
   * Put parts into module k (-1: no module, 'new': a new module). Parts joining an
   * existing module are moved next to its other members (locked and fixed parts stay),
   * so a following relayout({ around }) re-places them inside the module.
   * @returns {module, moved} the module index and the parts that were moved
   */
  assignModule(indices, k) {
    if (k === 'new') { k = this.modules.length; this.modules.push({ members: [] }); }
    const set = new Set(indices);
    for (const m of this.modules) m.members = m.members.filter((i) => !set.has(i));
    for (const i of indices) this.moduleOfPart[i] = k;
    if (k < 0) return { module: -1, moved: [] };
    const others = this.modules[k].members;
    this.modules[k].members = [...others, ...indices];
    const movable = indices.filter((i) => !this.isLocked(i));
    if (!others.length || !movable.length) return { module: k, moved: [] };
    let cx = 0, cy = 0;
    for (const j of others) { cx += this.state[j].x; cy += this.state[j].y; }
    cx /= others.length; cy /= others.length;
    const W = this.problem.canvas.width, H = this.problem.canvas.height;
    movable.forEach((i, n) => {
      const a = 2.39996 * n, r = 0.5 * Math.sqrt(n);
      const [w, h] = rotatedSize(this.problem.components[i], this.state[i].rotation);
      this.state[i] = { ...this.state[i], x: Math.min(W - w / 2, Math.max(w / 2, cx + r * Math.cos(a))), y: Math.min(H - h / 2, Math.max(h / 2, cy + r * Math.sin(a))) };
    });
    return { module: k, moved: movable };
  }

  /**
   * Re-place `members`, or the module of part `around` (its `maxParts` parts nearest to
   * it when the module is larger). Locked and fixed parts stay put. Stays within
   * `budgetMs`: GPU LNS stops early, and when parts cannot be legalized the region is
   * doubled while time remains. `legalizeOnly` skips global placement and LNS (a cheap
   * clean-up pass for parts a budgeted relayout left overlapping).
   *
   * A result that adds overlaps is `rejected` and not applied unless `allowWorse`.
   * @returns {changed:number[], timing, attempts, before, after, applied, rejected}
   */
  async relayout({ members = null, around = null, budgetMs = this.options.budgetMs, scatter = false, seed = 1, apply = true, legalizeOnly = false, allowWorse = false } = {}) {
    const t0 = performance.now(), deadline = t0 + budgetMs;
    let set = members ? [...members] : this.#around(around);
    set = set.filter((i) => !this.isLocked(i));
    if (!set.length) return { changed: [], timing: { totalMs: 0 }, attempts: [], applied: false };
    const before = { hpwl: moduleHpwl(this.problem, this.state, set), overlaps: memberOverlaps(this.problem, this.state, set) };

    let layout = this.state, best = null, margin = this.options.margin;
    // Members of one module with a region are re-placed inside that region first.
    const k = this.moduleOfPart[set[0]], region = members && k >= 0 && this.modules[k].region && set.every((i) => this.moduleOfPart[i] === k) ? this.modules[k].region : null;
    const attempts = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const remaining = deadline - performance.now();
      if (attempt > 0 && remaining < 20) break;
      const r = await relayoutMembers(this.problem, layout, set, {
        ...(region && attempt === 0 ? { region } : {}),
        margin, scatter: scatter && attempt === 0, seed: seed + attempt, device: this.device, deadline,
        globalIterations: legalizeOnly ? 0 : remaining > 60 ? 120 : 40, legalizeMsPerMcell: this.legalizeMsPerMcell,
        ...(legalizeOnly ? { lnsIterations: 0 } : {}),
      });
      this.#learnLegalizeCost(r.stats.legalize);
      attempts.push({ margin, region: !!(region && attempt === 0), ...r.timing, failed: r.stats.legalFailed, parts: r.stats.members + r.stats.obstacles, lnsIterations: r.stats.lnsIterations, legalize: r.stats.legalize });
      if (!best || r.stats.legalFailed < best.stats.legalFailed) best = r;
      if (!r.stats.legalFailed) break;
      layout = r.layout; if (!(region && attempt === 0)) margin *= 2;
    }
    const after = { hpwl: moduleHpwl(this.problem, best.layout, set), overlaps: memberOverlaps(this.problem, best.layout, set) };
    // A result with more overlaps than the start is not applied (unless allowWorse):
    // colliding with neighbours is worse than keeping the old positions.
    const rejected = after.overlaps > before.overlaps && !allowWorse;
    const applied = apply && !rejected;
    if (applied) for (const i of set) this.state[i] = best.layout[i];
    return { changed: rejected ? [] : set, layout: best.layout, before, after, attempts, applied, rejected, timing: { totalMs: performance.now() - t0 } };
  }

  /**
   * Legalization cost per million grid cells, learned from finished re-placements (it
   * differs ~2x between Node and browsers): a fast-rising, slow-falling estimate, so
   * the LNS stops early enough to leave legalization its time. Runs that hit the deadline
   * count too (their time is a lower bound of the full cost).
   */
  #learnLegalizeCost(t) {
    if (!t || t.mcells < 0.02) return;
    const v = t.totalMs / t.mcells, cur = this.legalizeMsPerMcell;
    this.legalizeMsPerMcell = cur === undefined ? v : v > cur ? 0.5 * cur + 0.5 * v : 0.9 * cur + 0.1 * v;
  }

  /**
   * Members of the module around part i, nearest first (i included), capped at maxParts
   * and stopping before the members' bounding box (+ margin) holds more than
   * maxRegionParts parts.
   */
  #around(i) {
    if (i === null || i === undefined) throw new Error('relayout needs members or around');
    const k = this.moduleOfPart[i];
    const pool = k >= 0 ? this.modules[k].members : [i];
    const p = this.state[i];
    const dist = (j) => Math.hypot(this.state[j].x - p.x, this.state[j].y - p.y);
    const sorted = [...new Set([i, ...pool])].sort((a, b) => dist(a) - dist(b)).slice(0, this.options.maxParts);
    const boxes = this.state.map((q, j) => { const [w, h] = rotatedSize(this.problem.components[j], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; });
    const m = this.options.margin, out = [];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const j of sorted) {
      const b = boxes[j], nx0 = Math.min(x0, b[0]), ny0 = Math.min(y0, b[1]), nx1 = Math.max(x1, b[2]), ny1 = Math.max(y1, b[3]);
      if (out.length) {
        let inRegion = 0;
        for (const c of boxes) if (c[2] > nx0 - m && c[0] < nx1 + m && c[3] > ny0 - m && c[1] < ny1 + m) inRegion++;
        if (inRegion > this.options.maxRegionParts) break;
      }
      out.push(j); [x0, y0, x1, y1] = [nx0, ny0, nx1, ny1];
    }
    return out;
  }
}
