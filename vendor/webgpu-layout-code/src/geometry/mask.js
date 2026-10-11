import { rotatedSize } from '../problem.js';

/**
 * Placement masks: where parts may not go, per board side.
 *
 * problem.canvas may carry (canvas coordinates, y-down):
 *   outline: [{outer: Point[], holes?: Point[][]}]   area outside every outer ring or
 *                                                     inside a hole is blocked
 *   edgeClearance: mm                                 outline/hole blocks grow by this much
 *   blocked: [{shape, sides?: [0|1...], maxHeight?}]  keepouts; with maxHeight they only
 *                                                     block parts taller than it
 * Shapes: {type:'rect',x,y,width,height} | {type:'circle',center,radius} |
 *         {type:'polygon',points,holes?}.
 *
 * Each distinct (side, maxHeight) pair becomes a mask layer; componentLayers[i] has a
 * bit per layer that applies to component i (by its height). Layers are rasterized at
 * `resolution` mm and turned into summed-area tables so the blocked area under any
 * axis-aligned rectangle is O(1).
 */
const canvasCache = new WeakMap(), problemCache = new WeakMap();

/** Masks of a normalized problem, cached per problem (and per canvas geometry). */
export function placementMasks(problem, options = {}) {
  if (!problem.canvas.outline && !problem.canvas.blocked?.length) return null;
  let m = problemCache.get(problem);
  if (!m) { m = buildPlacementMasks(problem, options); problemCache.set(problem, m); }
  return m;
}

export function buildPlacementMasks(problem, options = {}) {
  const canvas = problem.canvas, W = canvas.width, H = canvas.height;
  const outline = canvas.outline ?? null, blocked = canvas.blocked ?? [];
  if (!outline && !blocked.length) return null;
  // Rasterized layers depend only on the canvas geometry: share them between problems.
  const key = outline ?? blocked;
  const cached = canvasCache.get(key);
  if (cached && cached.W === W && cached.H === H && cached.edge === (canvas.edgeClearance ?? 0) && cached.blocked === blocked && (options.resolution === undefined || options.resolution === cached.masks.res) && (options.gw === undefined || (options.gw === cached.masks.gw && options.gh === cached.masks.gh))) {
    return { ...cached.masks, componentLayers: componentLayersOf(problem, cached.masks.layers) };
  }
  const res = options.resolution ?? Math.max(0.1, Math.min(0.5, Math.max(W, H) / 1024));
  // options.gw/gh force the grid size (callers indexing the grids with their own layout).
  const gw = options.gw ?? Math.ceil(W / res), gh = options.gh ?? Math.ceil(H / res), cells = gw * gh;

  // Layer 0/1: outline + holes + height-independent keepouts, for the top/bottom side.
  const layers = [{ side: 0, maxHeight: null }, { side: 1, maxHeight: null }];
  const layerOf = (side, maxHeight) => {
    let k = layers.findIndex((l) => l.side === side && l.maxHeight === maxHeight);
    if (k < 0) { k = layers.length; layers.push({ side, maxHeight }); }
    return k;
  };
  const grids = [];
  const grid = (k) => (grids[k] ??= new Uint8Array(cells));
  grid(0); grid(1);

  if (outline) {
    const inside = new Uint8Array(cells);
    for (const piece of outline) {
      fillPolygon(inside, gw, gh, res, piece.outer, 1);
      for (const hole of piece.holes ?? []) fillPolygon(inside, gw, gh, res, hole, 0);
    }
    let out = inside.map((v) => v ? 0 : 1);
    const grow = Math.round((canvas.edgeClearance ?? 0) / res);
    if (grow > 0) out = dilate(out, gw, gh, grow);
    for (let c = 0; c < cells; c++) if (out[c]) { grids[0][c] = 1; grids[1][c] = 1; }
  }
  for (const b of blocked) {
    const sides = b.sides ?? [0, 1];
    const mask = new Uint8Array(cells);
    fillShape(mask, gw, gh, res, b.shape);
    for (const side of sides) {
      const g = grid(layerOf(side, b.maxHeight ?? null));
      for (let c = 0; c < cells; c++) if (mask[c]) g[c] = 1;
    }
  }
  if (layers.length > 32) throw new Error('at most 32 mask layers (side x maxHeight combinations) are supported');

  // Summed-area tables, (gw+1) x (gh+1), counts of blocked cells.
  const sats = grids.map((g) => {
    const sat = new Uint32Array((gw + 1) * (gh + 1));
    for (let y = 0; y < gh; y++) {
      let row = 0;
      for (let x = 0; x < gw; x++) { row += g[y * gw + x]; sat[(y + 1) * (gw + 1) + x + 1] = sat[y * (gw + 1) + x + 1] + row; }
    }
    return sat;
  });
  const masks = { res, gw, gh, layers, grids, sats };
  canvasCache.set(key, { W, H, edge: canvas.edgeClearance ?? 0, blocked, masks });
  return { ...masks, componentLayers: componentLayersOf(problem, layers) };
}

/** Bit k set when mask layer k applies to the component (height-limited layers only to taller parts). */
function componentLayersOf(problem, layers) {
  return Uint32Array.from(problem.components, (c) => {
    let bits = 0;
    layers.forEach((l, k) => { if (l.maxHeight === null || (c.bodyHeight ?? 0) > l.maxHeight) bits |= 1 << k; });
    return bits;
  });
}

/** Blocked cell count of the layers in `bits` for `side` (or both sides) over a cell rectangle. */
export function blockedCells(masks, bits, side, twoSided, [x0, y0, x1, y1]) {
  let count = 0;
  masks.layers.forEach((l, k) => { if ((bits & (1 << k)) && (twoSided || l.side === side)) count += satSum(masks.sats[k], masks.gw, x0, y0, x1, y1); });
  return count;
}

/** Blocked cell count inside cell rectangle [x0, x1) x [y0, y1) of a SAT. */
function satSum(sat, gw, x0, y0, x1, y1) {
  const W1 = gw + 1;
  return sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
}

/** Cell-rectangle of a body [x0, y0, x1, y1] (mm): cells whose centre lies inside it. */
export function maskCellRect(masks, x0, y0, x1, y1) {
  const { res, gw, gh } = masks;
  const cx0 = Math.min(gw, Math.max(0, Math.ceil(x0 / res - 0.5))), cy0 = Math.min(gh, Math.max(0, Math.ceil(y0 / res - 0.5)));
  const cx1 = Math.min(gw, Math.max(cx0, Math.ceil(x1 / res - 0.5))), cy1 = Math.min(gh, Math.max(cy0, Math.ceil(y1 / res - 0.5)));
  return [cx0, cy0, cx1, cy1];
}

/**
 * Blocked area (mm²) under component i at `placement`, summed over the layers that
 * apply to it and the sides it occupies (both for twoSided parts).
 */
export function blockedArea(masks, problem, i, placement) {
  if (!masks) return 0;
  const c = problem.components[i], [w, h] = rotatedSize(c, placement.rotation);
  const [x0, y0, x1, y1] = maskCellRect(masks, placement.x - w / 2, placement.y - h / 2, placement.x + w / 2, placement.y + h / 2);
  return blockedCells(masks, masks.componentLayers[i], placement.side ? 1 : 0, c.twoSided, [x0, y0, x1, y1]) * masks.res * masks.res;
}

export function fillShape(mask, gw, gh, res, shape) {
  if (shape.type === 'rect') {
    fillPolygon(mask, gw, gh, res, [[shape.x, shape.y], [shape.x + shape.width, shape.y], [shape.x + shape.width, shape.y + shape.height], [shape.x, shape.y + shape.height]], 1);
  } else if (shape.type === 'circle') {
    const [cx, cy] = shape.center, r2 = shape.radius * shape.radius;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { const dx = (x + .5) * res - cx, dy = (y + .5) * res - cy; if (dx * dx + dy * dy <= r2) mask[y * gw + x] = 1; }
  } else {
    fillPolygon(mask, gw, gh, res, shape.points, 1);
    for (const hole of shape.holes ?? []) fillPolygon(mask, gw, gh, res, hole, 0);
  }
}

/** Scanline fill (even-odd) of cell centres inside `ring` with `value`. */
export function fillPolygon(mask, gw, gh, res, ring, value) {
  for (let y = 0; y < gh; y++) {
    const py = (y + .5) * res, xs = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py)) xs.push(xi + (py - yi) / (yj - yi) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] / res - 0.5)), x1 = Math.min(gw - 1, Math.floor(xs[k + 1] / res - 0.5));
      for (let x = x0; x <= x1; x++) mask[y * gw + x] = value;
    }
  }
}

/** Square dilation by r cells (separable max filter). */
function dilate(mask, gw, gh, r) {
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < gh; y++) {
    let last = -Infinity;
    for (let x = 0; x < gw; x++) { if (mask[y * gw + x]) last = x; if (x - last <= r) tmp[y * gw + x] = 1; }
    last = Infinity;
    for (let x = gw - 1; x >= 0; x--) { if (mask[y * gw + x]) last = x; if (last - x <= r) tmp[y * gw + x] = 1; }
  }
  for (let x = 0; x < gw; x++) {
    let last = -Infinity;
    for (let y = 0; y < gh; y++) { if (tmp[y * gw + x]) last = y; if (y - last <= r) out[y * gw + x] = 1; }
    last = Infinity;
    for (let y = gh - 1; y >= 0; y--) { if (tmp[y * gw + x]) last = y; if (last - y <= r) out[y * gw + x] = 1; }
  }
  return out;
}
