// Cypress layout of the parts selected in the editor (ui/). The editor worker sends its
// adapted problem (irToProblem: signal nets only, as in lib/board.mjs), its layout and the
// selected component indices. Every unselected part becomes a fixed Cypress terminal at its
// current pose; the selection warm-starts from its current pose on its current side. The job
// is the harness protocol: lib/cypress.mjs runCypress (orientations frozen unless the
// crossing term is on), then lib/board.mjs legalize (0.1 mm).
import { normalizeProblem, rotatedSize, worldPin, legalize } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';

export const MAX_SELECTED = 512;
// Rotation needs the crossing term (lib/cypress.mjs HARNESS_DEFAULTS note): 3-4x slower.
export const ROTATE_KNOBS = { net_crossing_weight: 0.001 };

export function buildSelection({ input, layout, selected }) {
  if (!input?.components || !Array.isArray(layout) || layout.length !== input.components.length) throw new Error('Request needs input and a matching layout');
  const movable = new Set((selected ?? []).map(Number));
  if (!movable.size) throw new Error('Select at least one part');
  if (movable.size > MAX_SELECTED) throw new Error(`At most ${MAX_SELECTED} parts per Cypress job`);
  for (const i of movable) {
    if (!Number.isInteger(i) || !input.components[i]) throw new Error(`Invalid selected part ${i}`);
    if (input.components[i].fixed) throw new Error(`${input.components[i].id} is fixed by the board`);
  }
  const pose = (i) => ({ x: +layout[i].x, y: +layout[i].y, rotation: (layout[i].rotation ?? 0) & 3, side: layout[i].side ? 1 : 0 });
  const components = input.components.map((c, i) => {
    const { fixed, ...rest } = c;
    return movable.has(i) ? { ...rest, sides: pose(i).side ? 'bottom' : 'top' } : { ...rest, fixed: pose(i) };
  });
  // Nets among fixed parts only are constant; keep the ones touching the selection.
  const index = new Map(components.map((c, i) => [c.id, i]));
  const nets = input.nets.filter((n) => n.pins.some((p) => movable.has(index.get(p.componentId))));
  const a = { input: { ...input, components, nets } };
  return { a, p: normalizeProblem(a.input), initial: layout.map((_, i) => pose(i)), selected: [...movable] };
}

export function hpwl(p, layout) {
  return p.nets.reduce((sum, net) => {
    const pts = net.pins.map((pi) => worldPin(p, layout, pi)), xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    return sum + Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  }, 0);
}

/** Body overlaps (pairs) between a selected part and any part sharing its side. */
export function selectedOverlaps(p, layout, selected) {
  const box = (i) => { const [w, h] = rotatedSize(p.components[i], layout[i].rotation), q = layout[i]; return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
  const shares = (i, j) => p.components[i].twoSided || p.components[j].twoSided || (layout[i].side ? 1 : 0) === (layout[j].side ? 1 : 0);
  const sel = new Set(selected); let count = 0;
  for (const i of selected) {
    const u = box(i);
    for (let j = 0; j < layout.length; j++) {
      if (j === i || (sel.has(j) && j < i) || !shares(i, j)) continue;
      const v = box(j);
      if (u[0] < v[2] && v[0] < u[2] && u[1] < v[3] && v[1] < u[3]) count++;
    }
  }
  return count;
}

export function summarize(b, layout, extra = {}) {
  return {
    placements: b.selected.map((i) => [i, layout[i].x, layout[i].y, layout[i].rotation & 3, layout[i].side ? 1 : 0]),
    metrics: { nets: b.p.nets.length, hpwlBeforeMm: hpwl(b.p, b.initial), hpwlAfterMm: hpwl(b.p, layout),
      overlapsBefore: selectedOverlaps(b.p, b.initial, b.selected), overlapsAfter: selectedOverlaps(b.p, layout, b.selected),
      rotated: b.selected.filter((i) => (layout[i].rotation & 3) !== b.initial[i].rotation).length },
    ...extra,
  };
}

export async function solveSelection(request, { jobDir, seed }) {
  const b = buildSelection(request);
  const r = await runCypress(b, { jobDir, seed, init: b.initial, knobs: request.rotate ? ROTATE_KNOBS : {} });
  if (r.status === 'timeout' || r.status === 'error') throw new Error(`Cypress ${r.status}: ${r.error}`);
  const legal = legalize(b, r.layout);
  return summarize(b, legal.layout, {
    cypress: { status: r.status, iterations: r.iterations, finalOverflow: r.finalOverflow, solveS: r.solveS, wallS: r.wallS, slotWaitS: r.slotWaitS, pinErrorMm: r.pinErrorMm },
    legalize: { failed: legal.failed, moved: legal.moved, nudged: legal.nudged, maxDisplacementMm: legal.maxDisplacement },
  });
}
