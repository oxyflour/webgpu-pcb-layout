// Shared geometry of router pads and nets (one implementation for the detail pass, the constraints
// and the metrics). Pads are entries of board.a.routing.pads ({comp, lx, ly, w, h, rot, tht, hole, net});
// positions follow the core router's rasterization (core/src/router/board-router.js).
import { rotateQuarter, localPin } from '../../core/src/problem.js';

// Pad centre in layout L (mm).
export function padCentre(L, pad) {
  const q = L[pad.comp], [rx, ry] = rotateQuarter(...localPin(pad.lx, pad.ly, q.side), q.rotation);
  return [q.x + rx, q.y + ry];
}

// Pad box [x0, y0, x1, y1, layers] in layout L; layers: 1 top, 2 bottom, 3 both (through-hole / hole).
export function padBox(L, pad) {
  const q = L[pad.comp], [x, y] = padCentre(L, pad), a = pad.rot * Math.PI / 180;
  let hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h), hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h);
  if (q.rotation & 1) [hx, hy] = [hy, hx];
  return [x - hx, y - hy, x + hx, y + hy, pad.tht || pad.hole ? 3 : q.side === 1 ? 2 : 1];
}

// Euclidean minimum spanning tree of points [[x, y], ...] (Prim from the first point): [[a, c], ...].
export function spanningSegments(pts) {
  const inT = pts.map(() => false), best = pts.map((q) => [Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]), 0]), out = [];
  if (!pts.length) return out;
  inT[0] = true;
  for (let it = 1; it < pts.length; it++) {
    let u = -1; for (let k = 0; k < pts.length; k++) if (!inT[k] && (u < 0 || best[k][0] < best[u][0])) u = k;
    inT[u] = true; out.push([pts[best[u][1]], pts[u]]);
    for (let k = 0; k < pts.length; k++) if (!inT[k]) { const d = Math.hypot(pts[k][0] - pts[u][0], pts[k][1] - pts[u][1]); if (d < best[k][0]) best[k] = [d, u]; }
  }
  return out;
}

// Value at fraction f of the sorted values, 2 decimals (null when empty).
export function quantile(values, f) {
  if (!values.length) return null;
  const s = [...values].sort((a, c) => a - c);
  return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2);
}
