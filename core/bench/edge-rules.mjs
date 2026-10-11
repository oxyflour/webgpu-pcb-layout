// Placement rules a layout engineer applies before anything else: connectors sit on the board
// edge with their long side along it, mounting holes sit in the corners. Classification uses
// the footprint library and reference only (never the input placement).
import { rotatedSize, sharesSide } from '../src/problem.js';

const CONN_LIB = /conn|usb|rj\d\d|header|pin_?head|jack|terminal|socket|barrel|hdmi|sd_?card|micro_?sd|sim_?card|dsub|db\d|idc|molex|jst|bnc|sma/i;
const CONN_REF = /^(J|P|CN|CON|USB)\d/i;
const HOLE_LIB = /mounting|hole/i;
const HOLE_REF = /^(H|MH)\d/i;

/** Component indices of movable connectors and mounting holes. */
export function edgeParts(adapted, problem) {
  const fps = adapted.ir?.footprints ?? [];
  const connectors = [], holes = [];
  problem.components.forEach((c, i) => {
    if (c.fixed) return;
    const lib = fps[i]?.library ?? '', ref = c.id;
    if (HOLE_LIB.test(lib) || HOLE_REF.test(ref)) holes.push(i);
    else if (CONN_LIB.test(lib) || CONN_REF.test(ref)) connectors.push(i);
  });
  return { connectors, holes };
}

/**
 * Moves connectors to the nearest board edge (long side parallel to it) and holes to the
 * nearest free corner, without overlapping each other or already fixed parts.
 * @returns {layout, fixed: Map<index, {x, y, rotation, side}>}
 */
export function snapToEdges(adapted, problem, layout, { inset = 0.2, gap = 0.3 } = {}) {
  const W = problem.canvas.width, H = problem.canvas.height;
  const { connectors, holes } = edgeParts(adapted, problem);
  const out = layout.map((p) => ({ ...p }));
  // Fixed real parts are obstacles; helper hubs (soft anchors, ids starting with '~') are not.
  const placed = problem.components.map((c, i) => (c.fixed && !c.id.startsWith('~') ? i : -1)).filter((i) => i >= 0);
  const box = (i, p) => { const [w, h] = rotatedSize(problem.components[i], p.rotation); return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2]; };
  const clash = (i, p) => placed.some((j) => {
    if (!sharesSide(problem, i, p, j, out[j])) return false;
    const a = box(i, p), b = box(j, out[j]);
    return a[0] < b[2] + gap && b[0] < a[2] + gap && a[1] < b[3] + gap && b[1] < a[3] + gap;
  });
  const rotations = (i) => (problem.components[i].rotatable === false ? [out[i].rotation] : [0, 1, 2, 3]);

  // Holes: corners first (nearest free one), then the nearest edge like a connector.
  const corners = [[0, 0], [W, 0], [0, H], [W, H]];
  const edgeQueue = [...connectors];
  for (const i of holes.sort((a, b) => problem.components[b].width * problem.components[b].height - problem.components[a].width * problem.components[a].height)) {
    const [w, h] = rotatedSize(problem.components[i], out[i].rotation);
    const opts = corners.map(([cx, cy]) => ({ x: cx ? cx - w / 2 - inset : w / 2 + inset, y: cy ? cy - h / 2 - inset : h / 2 + inset }))
      .map((q) => ({ ...q, d: Math.hypot(q.x - out[i].x, q.y - out[i].y) })).sort((a, b) => a.d - b.d);
    const free = opts.find((q) => !clash(i, { ...out[i], x: q.x, y: q.y }));
    if (free) { out[i] = { ...out[i], x: free.x, y: free.y }; placed.push(i); } else edgeQueue.push(i);
  }

  // Connectors: biggest first, each to the edge needing the shortest move, then slid along
  // the edge to the nearest position that clashes with nothing placed so far.
  const area = (i) => problem.components[i].width * problem.components[i].height;
  for (const i of edgeQueue.sort((a, b) => area(b) - area(a))) {
    const p = out[i], cands = [];
    for (const r of rotations(i)) {
      const [w, h] = rotatedSize(problem.components[i], r);
      // edge: [axis along the edge, fixed perpendicular coordinate]
      if (h >= w || problem.components[i].rotatable === false) { cands.push({ r, along: 'y', x: w / 2 + inset, y: p.y, half: h / 2, lim: H }); cands.push({ r, along: 'y', x: W - w / 2 - inset, y: p.y, half: h / 2, lim: H }); }
      if (w >= h || problem.components[i].rotatable === false) { cands.push({ r, along: 'x', x: p.x, y: h / 2 + inset, half: w / 2, lim: W }); cands.push({ r, along: 'x', x: p.x, y: H - h / 2 - inset, half: w / 2, lim: W }); }
    }
    // Prefer short moves, then the current rotation.
    cands.forEach((c) => { c.cost = Math.hypot(c.x - p.x, c.y - p.y) + (c.r === p.rotation ? 0 : 0.01); });
    cands.sort((a, b) => a.cost - b.cost);
    let done = false;
    for (const c of cands) {
      const start = c.along === 'x' ? c.x : c.y;
      for (let step = 0; step <= c.lim * 4 && !done; step++) {
        for (const sgn of step ? [1, -1] : [1]) {
          const v = Math.min(c.lim - c.half, Math.max(c.half, start + sgn * step * 0.25));
          const q = { ...p, rotation: c.r, x: c.along === 'x' ? v : c.x, y: c.along === 'y' ? v : c.y };
          if (!clash(i, q)) { out[i] = q; placed.push(i); done = true; break; }
        }
      }
      if (done) break;
    }
  }
  const fixed = new Map();
  for (const i of placed) if (!problem.components[i].fixed) fixed.set(i, { x: out[i].x, y: out[i].y, rotation: out[i].rotation, side: out[i].side ?? 0 });
  return { layout: out, fixed, connectors: edgeQueue.length, holes: holes.length };
}
