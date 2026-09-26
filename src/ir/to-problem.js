// Board IR (docs/board-ir.md) -> engine problem, and engine layout -> placement@1 result.
export const BOARD_FORMAT = 'webgpu-pin-layout/board@1';
export const PLACEMENT_FORMAT = 'webgpu-pin-layout/placement@1';

// Parts whose position is dictated by the enclosure, not by wiring.
const MECHANICAL_LIB = /conn|usb|rj\d\d|header|pin_?head|jack|terminal|socket|barrel|hdmi|sd_?card|micro_?sd|sim_?card|mounting|hole|fiducial|test_?point|dsub|db\d|idc|molex|jst|battery|bnc|sma/i;
// Reference designators of connectors, mounting holes, test points and fiducials.
const MECHANICAL_REF = /^(J|P|CN|CON|X|XS|XP|H|MH|MK|TP|FID|FD)\d/i;
const ANCHOR_PADS = 8;

/** Rotation of a local vector by θ (counter-clockwise seen from the top) in y-down coordinates. */
export function rotateDown(x, y, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c + y * s, -x * s + y * c];
}
const quarterOf = (deg) => ((Math.round(-deg / 90) % 4) + 4) % 4;
const isQuarter = (deg) => Math.abs(deg / 90 - Math.round(deg / 90)) < 1e-6;
const sideIndex = (side) => side === 'bottom' ? 1 : 0;

/** Whether a ring is exactly the axis-aligned box [x0, x1] x [y0, y1]. */
function isAxisBox(ring, x0, y0, x1, y1) {
  if (ring.length !== 4) return false;
  return ring.every(([x, y]) => (Math.abs(x - x0) < 1e-9 || Math.abs(x - x1) < 1e-9) && (Math.abs(y - y0) < 1e-9 || Math.abs(y - y1) < 1e-9));
}

function shapeBox(shape) {
  if (shape.type === 'rect') return [shape.x, shape.y, shape.x + shape.width, shape.y + shape.height];
  if (shape.type === 'circle') return [shape.center[0] - shape.radius, shape.center[1] - shape.radius, shape.center[0] + shape.radius, shape.center[1] + shape.radius];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of shape.points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
function padHalf(pad) {
  const a = (pad.rotation ?? 0) * Math.PI / 180, [w, h] = pad.size;
  return [0.5 * (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h), 0.5 * (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h)];
}

/** Returns a copy of the IR with every coordinate in y-down form (yAxis "up" negates y). */
export function toYDown(ir) {
  if ((ir.yAxis ?? 'down') === 'down') return ir;
  const P = ([x, y]) => [x, -y];
  const S = (s) => !s ? s : s.type === 'rect' ? { ...s, y: -(s.y + s.height) } : s.type === 'circle' ? { ...s, center: P(s.center) } : { ...s, points: s.points.map(P), ...(s.holes ? { holes: s.holes.map((h) => h.map(P)) } : {}) };
  return {
    ...ir, yAxis: 'down',
    board: { ...ir.board, outline: ir.board.outline.map((o) => ({ ...o, outer: o.outer.map(P), ...(o.holes ? { holes: o.holes.map((h) => h.map(P)) } : {}) })) },
    footprints: ir.footprints.map((f) => ({
      ...f,
      // Angles are physical (counter-clockwise seen from the top), so they survive the flip.
      pads: (f.pads ?? []).map((p) => ({ ...p, at: P(p.at), ...(p.points ? { points: p.points.map(P) } : {}) })),
      ...(f.courtyard ? { courtyard: S(f.courtyard) } : {}),
      ...(f.placement ? { placement: { ...f.placement, y: -f.placement.y } } : {}),
    })),
    regions: (ir.regions ?? []).map((r) => ({ ...r, shape: S(r.shape) })),
    keepouts: (ir.keepouts ?? []).map((k) => ({ ...k, shape: S(k.shape) })),
  };
}

/**
 * Board IR -> engine problem input plus everything the KiCad-style pipeline needs.
 *
 * @param options.preplace fix `mechanical` footprints (explicit or inferred) at `placement`
 * @param options.sides    'ir' (default: allowedSides), 'original' (stay on placement.side),
 *                         'single' (legacy: every footprint on one plane, no sides)
 * @param options.bodyMargin courtyard margin around pads when no courtyard is given (mm)
 */
export function irToProblem(irIn, options = {}) {
  const ir = toYDown(irIn);
  const sideMode = options.sides ?? 'ir';
  const bodyMargin = options.bodyMargin ?? 0.25;
  const boardSides = ir.board.sides ?? ['top', 'bottom'];

  // Canvas = bounding box of every outline polygon (holes/keepouts are not yet applied).
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const o of ir.board.outline) for (const [x, y] of o.outer) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
  const origin = { x: bx0, y: by0 }, canvas = { width: bx1 - bx0, height: by1 - by0 };

  const netByName = new Map((ir.nets ?? []).map((n) => [n.name, n]));
  const netPads = new Map();
  let padIndex = 0;
  const padRefs = ir.footprints.map((f, fi) => (f.pads ?? []).map((p) => {
    const ref = { fi, pad: p, index: padIndex++ };
    if (p.net) { if (!netPads.has(p.net)) netPads.set(p.net, []); netPads.get(p.net).push(ref); }
    return ref;
  }));
  const signalNets = [], powerNets = [];
  for (const [name, refs] of netPads) {
    const net = netByName.get(name) ?? { name, class: 'signal' };
    if (net.ignore || refs.length < 2) continue;
    (net.class === 'power' || net.class === 'ground' ? powerNets : signalNets).push({ net, refs });
  }
  const padNet = new Int32Array(padIndex).fill(-1);
  signalNets.forEach(({ refs }, ni) => { for (const r of refs) padNet[r.index] = ni; });

  const originalLayout = [], bodyFrame = [], mechanical = [], sides = [], placed = [];
  const components = ir.footprints.map((f, fi) => {
    const pads = f.pads ?? [];
    const pl = f.placement ?? null;
    const deg = pl?.rotation ?? 0, side = sideIndex(pl?.side);
    // Body box in the footprint's local (top-view) frame.
    let x0, y0, x1, y1;
    if (f.courtyard) [x0, y0, x1, y1] = shapeBox(f.courtyard);
    else if (pads.length) {
      x0 = y0 = Infinity; x1 = y1 = -Infinity;
      for (const p of pads) { const [hx, hy] = padHalf(p); x0 = Math.min(x0, p.at[0] - hx); x1 = Math.max(x1, p.at[0] + hx); y0 = Math.min(y0, p.at[1] - hy); y1 = Math.max(y1, p.at[1] + hy); }
      x0 -= bodyMargin; y0 -= bodyMargin; x1 += bodyMargin; y1 += bodyMargin;
    } else { x0 = y0 = -0.5; x1 = y1 = 0.5; }
    const tht = pads.some((p) => p.type === 'through');
    const allowed = f.allowedSides ?? [pl?.side ?? 'top'];
    const fixedByUser = !!f.fixed;
    // A fixed footprint at an off-quarter angle is baked into rotation 0.
    const bake = pl && fixedByUser && !isQuarter(deg);
    const mirror = (x, y) => side ? [-x, y] : [x, y];
    let d, width, height, rotation, pinOf, center;
    if (bake) {
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => rotateDown(...mirror(x, y), deg));
      const cx0 = Math.min(...corners.map((c) => c[0])), cx1 = Math.max(...corners.map((c) => c[0]));
      const cy0 = Math.min(...corners.map((c) => c[1])), cy1 = Math.max(...corners.map((c) => c[1]));
      const off = [(cx0 + cx1) / 2, (cy0 + cy1) / 2];
      center = [pl.x + off[0], pl.y + off[1]];
      width = cx1 - cx0; height = cy1 - cy0; rotation = 0;
      // Internal pins are un-mirrored again by localPin(side), so pre-mirror them.
      pinOf = (p) => { const [wx, wy] = rotateDown(...mirror(p.at[0], p.at[1]), deg); const o = [wx - off[0], wy - off[1]]; return side ? [-o[0], o[1]] : o; };
      d = { bake: true, off, deg };
    } else {
      const dx = (x0 + x1) / 2, dy = (y0 + y1) / 2;
      width = x1 - x0; height = y1 - y0; rotation = quarterOf(deg);
      const [rx, ry] = rotateDown(...mirror(dx, dy), deg);
      center = pl ? [pl.x + rx, pl.y + ry] : null;
      pinOf = (p) => [p.at[0] - dx, p.at[1] - dy];
      d = { bake: false, dx, dy };
    }
    // Single-plane legacy mode has no sides, so bottom pins are given as placed (mirrored).
    if (sideMode === 'single' && side) { const inner = pinOf; pinOf = (p) => { const [x, y] = inner(p); return [-x, y]; }; }
    bodyFrame.push({ ...d, width, height, pinOf });
    placed.push(!!pl);
    const place = center ? { x: center[0] - origin.x, y: center[1] - origin.y, rotation } : null;
    if (place && sideMode !== 'single') place.side = side;
    originalLayout.push(place);
    sides.push(side ? -1 : 1);

    const pins = [];
    pads.forEach((p, k) => { const idx = padRefs[fi][k].index; if (padNet[idx] >= 0) { const [x, y] = pinOf(p); pins.push({ id: `p${idx}`, x, y }); } });
    // Mechanical: explicit flag, connector-like library, no pads, or body touching the outline box.
    let atEdge = false;
    if (place) {
      const [w, h] = (rotation & 1) ? [height, width] : [width, height];
      atEdge = place.x - w / 2 < 0.5 || place.y - h / 2 < 0.5 || place.x + w / 2 > canvas.width - 0.5 || place.y + h / 2 > canvas.height - 0.5;
    }
    const mech = f.mechanical ?? (MECHANICAL_LIB.test(f.library ?? '') || MECHANICAL_REF.test(f.id) || !pads.length || atEdge);
    mechanical.push(mech);
    const c = { id: f.id, width: Math.max(0.2, width), height: Math.max(0.2, height), pins, rotatable: !bake && (f.allowedRotations ? new Set(f.allowedRotations.map(quarterOf)).size > 1 : true) };
    if (sideMode !== 'single') {
      c.twoSided = tht;
      const allowedHere = allowed.filter((s) => boardSides.includes(s));
      c.sides = sideMode === 'original' ? (side ? 'bottom' : 'top') : allowedHere.length > 1 ? 'any' : (allowedHere[0] ?? 'top');
    }
    if (place && (fixedByUser || (options.preplace && mech))) c.fixed = { ...place };
    return c;
  });

  // Placement masks in canvas coordinates: outline + holes, edge clearance, keepouts.
  const shift = (s) => s.type === 'rect' ? { ...s, x: s.x - origin.x, y: s.y - origin.y }
    : s.type === 'circle' ? { ...s, center: [s.center[0] - origin.x, s.center[1] - origin.y] }
    : { ...s, points: s.points.map(([x, y]) => [x - origin.x, y - origin.y]), ...(s.holes ? { holes: s.holes.map((h) => h.map(([x, y]) => [x - origin.x, y - origin.y])) } : {}) };
  const ring = (r) => r.map(([x, y]) => [x - origin.x, y - origin.y]);
  const sideIdx = (sides) => (sides ?? ['top', 'bottom']).map(sideIndex);
  const outline = ir.board.outline.map((o) => ({ outer: ring(o.outer), ...(o.holes?.length ? { holes: o.holes.map(ring) } : {}) }));
  const keepouts = ir.keepouts ?? [];
  const placementBlocked = keepouts.filter((k) => k.rules?.placement !== false).map((k) => ({ shape: shift(k.shape), sides: sideIdx(k.sides), ...(k.maxHeight != null ? { maxHeight: k.maxHeight } : {}) }));
  const routingBlocked = keepouts.filter((k) => k.rules?.routing !== false && k.maxHeight == null).map((k) => ({ shape: shift(k.shape), sides: sideIdx(k.sides) }));
  // Only rectangular single-piece outlines without holes need no mask.
  const trivial = ir.board.outline.length === 1 && !ir.board.outline[0].holes?.length && isAxisBox(ir.board.outline[0].outer, bx0, by0, bx1, by1);
  canvas.outline = trivial && !ir.rules?.edgeClearance ? undefined : outline;
  if (ir.rules?.edgeClearance) canvas.edgeClearance = ir.rules.edgeClearance;
  if (placementBlocked.length) canvas.blocked = placementBlocked;
  if (!canvas.outline) delete canvas.outline;
  components.forEach((c, i) => { const h = ir.footprints[i].height; if (h !== undefined) c.bodyHeight = h; });

  const nets = signalNets.map(({ net, refs }) => ({ id: net.name, pins: refs.map((r) => ({ componentId: ir.footprints[r.fi].id, pinId: `p${r.index}` })) }));
  const policy = Object.fromEntries(signalNets.filter(({ net }) => net.priority !== undefined).map(({ net }) => [net.name, { priority: net.priority }]));

  // Every pad, in the component body frame, for routing evaluation.
  const routingPads = [];
  ir.footprints.forEach((f, fi) => (f.pads ?? []).forEach((p, k) => {
    const [lx, ly] = bodyFrame[fi].pinOf(p);
    routingPads.push({ comp: fi, lx, ly, w: p.size[0], h: p.size[1], rot: bodyFrame[fi].bake ? (p.rotation ?? 0) - bodyFrame[fi].deg : (p.rotation ?? 0), tht: p.type === 'through', hole: p.type === 'npth', net: padNet[padRefs[fi][k].index], padIndex: padRefs[fi][k].index });
  }));
  const power = powerNets.map(({ net, refs }) => ({
    name: net.name,
    pads: refs.map((r) => { const [x, y] = bodyFrame[r.fi].pinOf(r.pad); return { comp: r.fi, padIndex: r.index, x, y, anchor: (ir.footprints[r.fi].pads ?? []).length >= ANCHOR_PADS }; }),
  }));
  const plan = (ir.modules ?? []).length ? {
    modules: ir.modules.map((m) => {
      const region = m.region ? (ir.regions ?? []).find((r) => r.id === m.region) : null;
      const box = region ? shapeBox(region.shape) : null;
      return {
        name: m.name ?? m.id, id: m.id,
        members: m.footprints.map((id) => ir.footprints.findIndex((f) => f.id === id)).filter((i) => i >= 0 && !components[i].fixed),
        side: m.side ?? 'auto', cohesion: m.cohesion ?? 0.4,
        region: box ? { x: box[0] - origin.x, y: box[1] - origin.y, width: box[2] - box[0], height: box[3] - box[1] } : null,
      };
    }).filter((m) => m.members.length),
  } : null;
  if (plan) { const inModule = new Set(plan.modules.flatMap((m) => m.members)); plan.unassigned = components.map((_, i) => i).filter((i) => !components[i].fixed && !inModule.has(i)); }

  const area = components.reduce((s, c) => s + c.width * c.height, 0);
  return {
    input: { canvas, components, nets },
    originalLayout, placed, origin, sides, policy, plan, power, mechanical,
    contours: ir.board.outline.flatMap((o) => [o.outer, ...(o.holes ?? [])]).map((c) => c.map(([x, y]) => [x - origin.x, y - origin.y])),
    // Evaluation routing layers: every copper layer except planes (at least the two outer ones).
    routing: { canvas, pads: routingPads, netCount: nets.length, outline, blocked: routingBlocked, layers: Math.max(2, (ir.board.copperLayers ?? []).filter((l) => l.type !== 'plane').length) },
    // The IR exactly as given (its yAxis and coordinates are used for results).
    bodyFrame, ir: irIn,
    stats: {
      footprints: components.length,
      bottom: sides.filter((s) => s < 0).length,
      locked: components.filter((c) => c.fixed).length,
      mechanical: mechanical.filter(Boolean).length,
      nets: nets.length, pins: nets.reduce((s, n) => s + n.pins.length, 0),
      droppedPower: powerNets.length, droppedDegree: 0,
      offQuarter: ir.footprints.filter((f) => f.placement && !isQuarter(f.placement.rotation ?? 0)).length,
      canvas: [+canvas.width.toFixed(1), +canvas.height.toFixed(1)],
      density: area / (canvas.width * canvas.height),
    },
  };
}

/**
 * Engine layout -> placement@1 (footprint anchors in the IR's own coordinates and yAxis).
 * Fixed footprints are returned exactly as given.
 */
export function placementResult(adapted, layout, extra = {}) {
  const ir = adapted.ir, up = (adapted.ir.yAxis ?? 'down') === 'up', src = toYDown(ir);
  const placements = src.footprints.map((f, fi) => {
    const frame = adapted.bodyFrame[fi], comp = adapted.input.components[fi];
    if (comp.fixed && f.placement) return { footprint: f.id, ...pick(ir.footprints[fi].placement) };
    const p = layout[fi], side = p.side ?? sideIndex(f.placement?.side);
    const deg = ((-90 * (p.rotation & 3)) % 360 + 360) % 360;
    // anchor = centre - R(θ)·M(side)·d
    const [mx, my] = side ? [-frame.dx, frame.dy] : [frame.dx, frame.dy];
    const [rx, ry] = rotateDown(mx, my, deg);
    const x = p.x + adapted.origin.x - rx, y = p.y + adapted.origin.y - ry;
    return { footprint: f.id, x: round6(x), y: round6(up ? -y : y), rotation: deg, side: side ? 'bottom' : 'top' };
  });
  return { format: PLACEMENT_FORMAT, board: ir.name ?? null, yAxis: ir.yAxis ?? 'down', placements, ...extra };
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const pick = (pl) => ({ x: pl.x, y: pl.y, rotation: pl.rotation ?? 0, side: pl.side ?? 'top' });
