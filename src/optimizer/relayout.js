import { normalizeProblem, worldPin, rotatedSize, sharesSide } from '../problem.js';
import { AnalyticalGlobalPlacer } from './global-placement.js';
import { GpuLnsOptimizer } from './lns.js';
import { PriorityCpuBatchScorer } from '../cpu/priority-batch-scorer.js';
import { legalizeLayout } from './legalizer.js';
import { PriorityGpuBatchScorer } from '../gpu/batch-scorer.js';

/** Shapes and outline of the board canvas, shifted into a region's local frame. */
function shiftCanvas(canvas, x0, y0) {
  const P = ([x, y]) => [x - x0, y - y0];
  const shape = (s) => s.type === 'rect' ? { ...s, x: s.x - x0, y: s.y - y0 } : s.type === 'circle' ? { ...s, center: P(s.center) } : { ...s, points: s.points.map(P), ...(s.holes ? { holes: s.holes.map((h) => h.map(P)) } : {}) };
  return {
    ...(canvas.outline ? { outline: canvas.outline.map((o) => ({ outer: o.outer.map(P), ...(o.holes ? { holes: o.holes.map((h) => h.map(P)) } : {}) })) } : {}),
    ...(canvas.blocked?.length ? { blocked: canvas.blocked.map((b) => ({ ...b, shape: shape(b.shape) })) } : {}),
    ...(canvas.edgeClearance ? { edgeClearance: canvas.edgeClearance } : {}),
  };
}

const now = () => performance.now();

/**
 * Re-place only `members` (component indices) of a placed board, everything else fixed.
 *
 * The work happens on a local sub-problem: the canvas is the members' current bounding
 * box grown by `margin` (clipped to the board), other parts whose body touches it are
 * fixed obstacles, and every pin outside the module that shares a net with a member
 * becomes a pin of one fixed, zero-area "terminal hub" at the region origin (so the
 * terminals attract members without repelling them). The sub-problem is small
 * (tens to a few hundred parts), so it runs on the CPU without GPU setup costs.
 *
 * @returns {layout, timing: {buildMs, globalMs, lnsMs, legalizeMs, totalMs}, stats}
 */
export async function relayoutMembers(problem, layout, members, options = {}) {
  const t0 = now();
  const margin = options.margin ?? 2;
  const memberSet = new Set(members);
  const box = (i, p = layout[i]) => { const [w, h] = rotatedSize(problem.components[i], p.rotation); return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2]; };

  // Region: members' bounding box + margin (or an explicit region), clipped to the board.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const i of members) { const b = box(i); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  if (options.region) ({ x: x0, y: y0 } = options.region), x1 = x0 + options.region.width, y1 = y0 + options.region.height;
  else { x0 -= margin; y0 -= margin; x1 += margin; y1 += margin; }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(problem.canvas.width, x1); y1 = Math.min(problem.canvas.height, y1);

  const local = (p) => ({ ...p, x: p.x - x0, y: p.y - y0 });
  const components = [], subIndex = new Map(), subLayout = [];
  const add = (c, p, fixed, pins = []) => {
    subIndex.set(components.length, c.index);
    components.push({ id: `c${components.length}`, width: c.width, height: c.height, sides: c.sides, twoSided: c.twoSided, rotatable: c.rotatable, pins, ...(fixed ? { fixed: local(p) } : {}) });
    subLayout.push(local(p));
  };
  // Members keep their own pins; pins are referenced by index `p<pin>`.
  const pinsOf = (i) => problem.components[i].pins.map((pi) => ({ id: `p${pi}`, x: problem.pins[pi].x, y: problem.pins[pi].y }));
  for (const i of members) add(problem.components[i], layout[i], false, pinsOf(i));
  // Obstacles: non-members overlapping the region.
  for (let i = 0; i < problem.components.length; i++) {
    if (memberSet.has(i)) continue;
    const b = box(i);
    if (b[2] > x0 && b[0] < x1 && b[3] > y0 && b[1] < y1) add(problem.components[i], layout[i], true);
  }
  const obstacles = components.length - members.length;
  // Nets touching members: member pins + terminal-hub pins for outside pins.
  const nets = [], hubPins = [], hub = components.length;
  let terminals = 0;
  for (const net of problem.nets) {
    const inside = net.pins.filter((pi) => memberSet.has(problem.pins[pi].componentIndex));
    if (!inside.length) continue;
    const pins = inside.map((pi) => ({ componentId: `c${members.indexOf(problem.pins[pi].componentIndex)}`, pinId: `p${pi}` }));
    for (const pi of net.pins) {
      if (memberSet.has(problem.pins[pi].componentIndex)) continue;
      const [wx, wy] = worldPin(problem, layout, pi);
      const id = `t${terminals++}`;
      hubPins.push({ id, x: wx - x0, y: wy - y0 });
      pins.push({ componentId: 'hub', pinId: id });
    }
    if (pins.length >= 2) nets.push({ id: net.id, pins });
  }
  components.push({ id: 'hub', width: 0.01, height: 0.01, rotatable: false, twoSided: true, pins: hubPins, fixed: { x: 0, y: 0, rotation: 0 } });
  subLayout.push({ x: 0, y: 0, rotation: 0 });
  // The board's outline/holes/keepouts, shifted into the region.
  const sub = normalizeProblem({ canvas: { width: x1 - x0, height: y1 - y0, ...shiftCanvas(problem.canvas, x0, y0) }, components, nets });
  // Terminals are zero-area and twoSided so they never collide or get legalized.
  const t1 = now();

  // Global placement from the current positions (or scattered, when asked to start over).
  let init = subLayout;
  if (options.scatter) {
    const rnd = rng32(options.seed ?? 1);
    init = subLayout.map((p, k) => k < members.length ? { ...p, x: rnd() * sub.canvas.width, y: rnd() * sub.canvas.height } : p);
  }
  const L = Math.sqrt(sub.canvas.width * sub.canvas.height);
  const placer = new AnalyticalGlobalPlacer(sub, {
    iterations: options.globalIterations ?? 120, clearance: 0.2, macroClearance: 0.3, egressGap: 0.5, maxMove: 0.03 * L, step: 0.58, damping: .66, cooling: .995,
    wireStrength: .92, densityStrength: .86, overlapStrength: 4, macroStrength: 7.4, boundaryStrength: 2.6, recordEvery: 1e9,
  });
  let cur = (await placer.optimize(init)).layout;
  const t2 = now();

  // LNS on the exact objective: on the GPU (cached pipelines, ~1 ms per 1024 candidates)
  // until the deadline minus a legalization reserve, or a few CPU iterations.
  if (options.device || options.lnsIterations) {
    const scorerOptions = { weights: { hpwl: 1, overlap: 200, bounds: 200, congestion: 0 }, coarse: { gridWidth: 16, gridHeight: 12, capacity: 4 } };
    const scorer = options.device ? new PriorityGpuBatchScorer(options.device, sub, scorerOptions) : new PriorityCpuBatchScorer(sub, scorerOptions);
    const deadline = options.deadline !== undefined ? options.deadline - (options.legalizeReserveMs ?? 15) : undefined;
    cur = (await new GpuLnsOptimizer(sub, scorer, {
      iterations: options.lnsIterations ?? (options.device ? 200 : 0), population: options.lnsPopulation ?? (options.device ? 512 : 32),
      movesPerCandidate: 1, translationScale: 0.02 * L, rotationProbability: 0.1, temperature: .01, cooling: .97, seed: options.seed ?? 1, deadline,
    }).optimize(cur)).layout;
    scorer.destroy?.();
  }
  const t3 = now();

  // Legalize inside the region: members only (obstacles and terminals are fixed).
  // Bounded search: a part that finds no room within maxRadius keeps its global position.
  const legal = legalizeLayout(sub, cur, { clearance: 0.1, cell: options.cell ?? 0.1, ignore: [hub], maxRadius: options.maxRadius ?? 3 });
  const t4 = now();

  const out = layout.map((p) => ({ ...p }));
  members.forEach((i, k) => { const q = legal.layout[k]; out[i] = { ...out[i], x: q.x + x0, y: q.y + y0, rotation: q.rotation, ...(q.side !== undefined ? { side: q.side } : {}) }; });
  return {
    layout: out,
    timing: { buildMs: t1 - t0, globalMs: t2 - t1, lnsMs: t3 - t2, legalizeMs: t4 - t3, totalMs: t4 - t0 },
    stats: { members: members.length, obstacles, terminals, nets: nets.length, region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, legalFailed: legal.failed },
  };
}

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/** Signal HPWL of the nets touching `members` (for before/after comparisons). */
export function moduleHpwl(problem, layout, members) {
  const set = new Set(members);
  let total = 0;
  for (const net of problem.nets) {
    if (!net.pins.some((pi) => set.has(problem.pins[pi].componentIndex))) continue;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const pi of net.pins) { const [x, y] = worldPin(problem, layout, pi); a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    total += c - a + d - b;
  }
  return total;
}

/** Same-side overlapping pairs that involve at least one member. */
export function memberOverlaps(problem, layout, members) {
  const set = new Set(members);
  let n = 0;
  for (const i of members) for (let j = 0; j < problem.components.length; j++) {
    if (j === i || (set.has(j) && j < i) || !sharesSide(problem, i, layout[i], j, layout[j])) continue;
    const [aw, ah] = rotatedSize(problem.components[i], layout[i].rotation), [bw, bh] = rotatedSize(problem.components[j], layout[j].rotation);
    const ox = Math.min(layout[i].x + aw / 2, layout[j].x + bw / 2) - Math.max(layout[i].x - aw / 2, layout[j].x - bw / 2);
    const oy = Math.min(layout[i].y + ah / 2, layout[j].y + bh / 2) - Math.max(layout[i].y - ah / 2, layout[j].y - bh / 2);
    if (ox > 1e-6 && oy > 1e-6 && ox * oy > 0.01) n++;
  }
  return n;
}
