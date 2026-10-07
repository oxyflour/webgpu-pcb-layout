// Editor (ui/) <-> Cypress selection layout. The editor worker sends the board's
// adapted problem (irToProblem: signal nets in input, power rails separate), its
// current layout and the selected component indices. Every unselected part becomes a
// fixed terminal at its current pose; the selection is movable on its current side.
// Power/ground pads are restored to the objective as in the harness experiments.
import { withElectricalPower } from './board.mjs';
import { normalizeProblem, worldPin, rotatedSize } from './runtime.mjs';
export const MAX_SELECTED = 512;

export function buildSelectionProblem({ input, power, layout, selected, allowRotation = true }) {
  if (!input?.components || !Array.isArray(layout) || layout.length !== input.components.length) throw Error('Request needs input and a matching layout');
  const movable = new Set((selected ?? []).map(Number));
  if (!movable.size) throw Error('Select at least one part');
  if (movable.size > MAX_SELECTED) throw Error(`At most ${MAX_SELECTED} parts per Cypress job`);
  for (const i of movable) {
    if (!Number.isInteger(i) || !input.components[i]) throw Error('Invalid selected part ' + i);
    if (input.components[i].fixed) throw Error(`${input.components[i].id} is fixed by the board`);
  }
  const pose = i => ({ x: +layout[i].x, y: +layout[i].y, rotation: (layout[i].rotation ?? 0) & 3, side: layout[i].side ? 1 : 0 });
  const full = withElectricalPower({ input, power: power ?? [] }).input;
  const components = full.components.map((c, i) => {
    const { fixed, ...rest } = c;
    return movable.has(i)
      ? { ...rest, sides: pose(i).side ? 'bottom' : 'top', rotatable: c.rotatable !== false && allowRotation }
      : { ...rest, fixed: pose(i) };
  });
  // Nets among fixed parts only are constant; keep the ones touching the selection.
  const index = new Map(components.map((c, i) => [c.id, i]));
  const nets = full.nets.filter(n => n.pins.some(p => movable.has(index.get(p.componentId))));
  const initial = layout.map((_, i) => pose(i));
  return { adapted: { input: { ...full, components, nets } }, initial, selected: [...movable] };
}

export function hpwl(problem, layout) {
  return problem.nets.reduce((sum, net) => {
    const pts = net.pins.map(pi => worldPin(problem, layout, pi)), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return sum + Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  }, 0);
}

/** Body overlaps (pairs) between a selected part and any part sharing its side. */
export function selectedOverlaps(problem, layout, selected) {
  const box = i => { const [w, h] = rotatedSize(problem.components[i], layout[i].rotation), p = layout[i]; return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2]; };
  const shares = (i, j) => problem.components[i].twoSided || problem.components[j].twoSided || (layout[i].side ? 1 : 0) === (layout[j].side ? 1 : 0);
  const sel = new Set(selected); let count = 0;
  for (const i of selected) { const a = box(i); for (let j = 0; j < layout.length; j++) {
    if (j === i || (sel.has(j) && j < i) || !shares(i, j)) continue; const b = box(j);
    if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) count++;
  } }
  return count;
}

export function summarize(built, solved) {
  const p = normalizeProblem(built.adapted.input);
  return {
    placements: built.selected.map(i => [i, solved.layout[i].x, solved.layout[i].y, solved.layout[i].rotation & 3, solved.layout[i].side ? 1 : 0]),
    metrics: { nets: p.nets.length, hpwlBeforeMm: hpwl(p, built.initial), hpwlAfterMm: hpwl(p, solved.layout),
      overlapsBefore: selectedOverlaps(p, built.initial, built.selected), overlapsAfter: selectedOverlaps(p, solved.layout, built.selected),
      rotated: built.selected.filter(i => (solved.layout[i].rotation & 3) !== built.initial[i].rotation).length },
  };
}
