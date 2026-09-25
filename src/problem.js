/** Validate and normalize a component/pin/net layout problem. */
export function normalizeProblem(problem) {
  if (!problem?.canvas || !(problem.canvas.width > 0) || !(problem.canvas.height > 0)) {
    throw new Error('problem.canvas.width/height must be positive');
  }
  const components = problem.components ?? [];
  const nets = problem.nets ?? [];
  const componentIndex = new Map();
  const pinIndexByKey = new Map();
  const pins = [];

  components.forEach((c, ci) => {
    if (componentIndex.has(c.id)) throw new Error(`duplicate component id: ${c.id}`);
    if (!(c.width > 0) || !(c.height > 0)) throw new Error(`invalid size for component ${c.id}`);
    componentIndex.set(c.id, ci);
    (c.pins ?? []).forEach((p, pi) => {
      const key = `${c.id}\u0000${p.id}`;
      if (pinIndexByKey.has(key)) throw new Error(`duplicate pin id: ${c.id}/${p.id}`);
      const idx = pins.length;
      pinIndexByKey.set(key, idx);
      pins.push({
        index: idx,
        componentIndex: ci,
        componentId: c.id,
        pinId: p.id,
        x: Number(p.x),
        y: Number(p.y),
        normal: p.normal ? [Number(p.normal[0]), Number(p.normal[1])] : null,
        side: p.side ?? null
      });
    });
  });

  const normalizedNets = nets.map((net, ni) => {
    if (!net.id) throw new Error(`net ${ni} is missing id`);
    const netPins = (net.pins ?? []).map((ref) => {
      const key = `${ref.componentId}\u0000${ref.pinId}`;
      const idx = pinIndexByKey.get(key);
      if (idx === undefined) throw new Error(`net ${net.id} references missing pin ${ref.componentId}/${ref.pinId}`);
      return idx;
    });
    if (netPins.length < 2) throw new Error(`net ${net.id} must connect at least two pins`);
    return { id: net.id, index: ni, pins: netPins };
  });

  const pinUse = new Uint32Array(pins.length);
  for (const net of normalizedNets) for (const p of net.pins) pinUse[p]++;
  for (let i = 0; i < pinUse.length; i++) {
    if (pinUse[i] > 1) throw new Error(`pin ${pins[i].componentId}/${pins[i].pinId} belongs to multiple nets`);
  }

  return {
    canvas: { width: Number(problem.canvas.width), height: Number(problem.canvas.height) },
    components: components.map((c, i) => ({
      id: c.id,
      index: i,
      width: Number(c.width),
      height: Number(c.height),
      rotatable: c.rotatable !== false,
      // Board sides this part may be placed on; `twoSided` parts (through-hole) block both.
      sides: normalizeSides(c.sides, c.id),
      twoSided: !!c.twoSided,
      fixed: c.fixed ? { x: Number(c.fixed.x), y: Number(c.fixed.y), rotation: (c.fixed.rotation ?? 0) & 3, side: c.fixed.side ? 1 : 0 } : null,
      pins: (c.pins ?? []).map((p) => pinIndexByKey.get(`${c.id}\u0000${p.id}`))
    })),
    pins,
    nets: normalizedNets,
    componentIndex,
    pinIndexByKey
  };
}

function normalizeSides(sides, id) {
  const v = sides ?? 'top';
  if (v !== 'top' && v !== 'bottom' && v !== 'any') throw new Error(`component ${id}: sides must be 'top', 'bottom' or 'any'`);
  return v;
}

/** 0 = top, 1 = bottom. */
export function placementSide(placement) { return placement.side ? 1 : 0; }

/** Whether two placed components compete for the same board area. */
export function sharesSide(problem, i, pi, j, pj) {
  const a = problem.components[i], b = problem.components[j];
  return a.twoSided || b.twoSided || placementSide(pi) === placementSide(pj);
}

/**
 * Pin coordinates are given as seen from the top. A part flipped to the bottom is
 * mirrored in its local x before rotation (the view from the top of the board).
 */
export function localPin(x, y, side) { return side ? [-x, y] : [x, y]; }

export function rotateQuarter(x, y, r) {
  switch (r & 3) {
    case 0: return [x, y];
    case 1: return [-y, x];
    case 2: return [-x, -y];
    default: return [y, -x];
  }
}

export function worldPin(problem, layout, pinIndex) {
  const p = problem.pins[pinIndex];
  const pl = layout[p.componentIndex];
  const [lx, ly] = localPin(p.x, p.y, pl.side);
  const [rx, ry] = rotateQuarter(lx, ly, pl.rotation);
  return [pl.x + rx, pl.y + ry];
}

export function rotatedSize(component, rotation) {
  return (rotation & 1) ? [component.height, component.width] : [component.width, component.height];
}
