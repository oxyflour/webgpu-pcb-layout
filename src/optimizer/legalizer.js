import { rotatedSize } from '../problem.js';
import { placementMasks, maskCellRect, blockedCells } from '../geometry/mask.js';

/**
 * Greedy overlap legalizer for mixed-size, double-sided placements.
 *
 * Each board side gets an occupancy grid of `cell` mm. Fixed parts are stamped first,
 * then movable parts in decreasing area order take the free position closest to
 * where the global/detailed placer left them (rings of increasing Chebyshev radius,
 * nearest Euclidean candidate first within a ring). Through-hole (`twoSided`) parts
 * need both sides free. Rotation and side are kept. Masked cells (outline, holes,
 * keepouts, height limits that apply to the part) are never used.
 *
 * @returns {layout, moved, failed, maxDisplacement, meanDisplacement}
 */
export function legalizeLayout(problem, layout, options = {}) {
  const W = problem.canvas.width, H = problem.canvas.height;
  const cell = options.cell ?? Math.max(0.05, Math.min(0.25, Math.min(W, H) / 800));
  const clearance = options.clearance ?? 0.1;
  const maxRadius = Math.ceil((options.maxRadius ?? Math.max(W, H)) / cell);
  const GW = Math.ceil(W / cell), GH = Math.ceil(H / cell);
  const occ = [new Uint8Array(GW * GH), new Uint8Array(GW * GH)];
  const out = layout.map((p) => ({ ...p }));

  // Footprint of a part in cells when centred at cell (cx, cy): [x0, y0, x1, y1] inclusive.
  const span = (i) => {
    const [w, h] = rotatedSize(problem.components[i], out[i].rotation);
    return [Math.ceil((w + clearance) / cell), Math.ceil((h + clearance) / cell)];
  };
  const sidesOf = (i) => problem.components[i].twoSided ? [0, 1] : [out[i].side ? 1 : 0];
  const rectAt = (sw, sh, cx, cy) => {
    const x0 = cx - (sw >> 1), y0 = cy - (sh >> 1);
    return [x0, y0, x0 + sw - 1, y0 + sh - 1];
  };
  const inside = ([x0, y0, x1, y1]) => x0 >= 0 && y0 >= 0 && x1 < GW && y1 < GH;
  // Optional per-part region {x,y,width,height}: candidates must lie inside it when it fits.
  const regionCells = (i) => {
    const r = options.regions?.[i];
    if (!r) return null;
    return [Math.ceil(r.x / cell), Math.ceil(r.y / cell), Math.floor((r.x + r.width) / cell) - 1, Math.floor((r.y + r.height) / cell) - 1];
  };
  const masks = placementMasks(problem);
  // Occupancy rectangle (cells) -> no masked cell of a layer applying to part i under it.
  const unmasked = (i, [x0, y0, x1, y1], sides) => !masks || blockedCells(masks, masks.componentLayers[i], sides[0], sides.length > 1,
    maskCellRect(masks, x0 * cell, y0 * cell, (x1 + 1) * cell, (y1 + 1) * cell)) === 0;
  const within = (rect, rc) => !rc || (rect[0] >= rc[0] && rect[1] >= rc[1] && rect[2] <= rc[2] && rect[3] <= rc[3]);
  const free = ([x0, y0, x1, y1], sides) => {
    for (const s of sides) {
      const o = occ[s];
      for (let y = y0; y <= y1; y++) { const row = y * GW; for (let x = x0; x <= x1; x++) if (o[row + x]) return false; }
    }
    return true;
  };
  const stamp = ([x0, y0, x1, y1], sides) => {
    for (const s of sides) {
      const o = occ[s];
      for (let y = Math.max(0, y0); y <= Math.min(GH - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(GW - 1, x1); x++) o[y * GW + x] = 1;
    }
  };
  const toCell = (i) => [Math.round(out[i].x / cell - 0.5), Math.round(out[i].y / cell - 0.5)];
  const fromRect = (i, [x0, y0, x1, y1]) => {
    out[i].x = (x0 + x1 + 1) / 2 * cell;
    out[i].y = (y0 + y1 + 1) / 2 * cell;
  };

  const movable = [];
  // options.ignore: indices that neither occupy space nor get moved (e.g. zero-area terminals).
  const ignore = new Set(options.ignore ?? []);
  problem.components.forEach((c, i) => {
    if (ignore.has(i)) return;
    if (c.fixed) { const [sw, sh] = span(i), [cx, cy] = toCell(i); stamp(rectAt(sw, sh, cx, cy), sidesOf(i)); }
    else movable.push(i);
  });
  movable.sort((a, b) => problem.components[b].width * problem.components[b].height - problem.components[a].width * problem.components[a].height);

  let moved = 0, failed = 0, outsideRegion = 0, maxDisp = 0, sumDisp = 0;
  for (const i of movable) {
    const [sw, sh] = span(i), [cx, cy] = toCell(i), sides = sidesOf(i);
    let rc = regionCells(i);
    if (rc && (rc[2] - rc[0] + 1 < sw || rc[3] - rc[1] + 1 < sh)) { rc = null; outsideRegion++; }
    const ox = out[i].x, oy = out[i].y;
    let best = null;
    for (let r = 0; r <= maxRadius && !best; r++) {
      // Candidates on the ring at Chebyshev distance r, nearest first.
      const ring = [];
      if (r === 0) ring.push([cx, cy]);
      else for (let k = -r; k <= r; k++) ring.push([cx + k, cy - r], [cx + k, cy + r], ...(k > -r && k < r ? [[cx - r, cy + k], [cx + r, cy + k]] : []));
      ring.sort((a, b) => (a[0] - cx) ** 2 + (a[1] - cy) ** 2 - ((b[0] - cx) ** 2 + (b[1] - cy) ** 2));
      for (const [x, y] of ring) {
        const rect = rectAt(sw, sh, x, y);
        if (inside(rect) && within(rect, rc) && free(rect, sides) && unmasked(i, rect, sides)) { best = rect; break; }
      }
    }
    // A full region falls back to the nearest free spot anywhere.
    if (!best && rc) {
      outsideRegion++;
      for (let r = 0; r <= maxRadius && !best; r++) for (let k = -r; k <= r && !best; k++) for (const [x, y] of [[cx + k, cy - r], [cx + k, cy + r], [cx - r, cy + k], [cx + r, cy + k]]) { const rect = rectAt(sw, sh, x, y); if (inside(rect) && free(rect, sides) && unmasked(i, rect, sides)) { best = rect; break; } }
    }
    if (!best) { failed++; continue; }
    stamp(best, sides);
    fromRect(i, best);
    const d = Math.hypot(out[i].x - ox, out[i].y - oy);
    if (d > 1e-9) moved++;
    maxDisp = Math.max(maxDisp, d); sumDisp += d;
  }
  return { layout: out, moved, failed, outsideRegion, maxDisplacement: maxDisp, meanDisplacement: movable.length ? sumDisp / movable.length : 0 };
}
