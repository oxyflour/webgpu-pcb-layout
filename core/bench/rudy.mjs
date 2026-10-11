// RUDY routing-demand estimate: each signal net spreads its HPWL uniformly over its bounding box (padded by one
// track); capacity per bin = layers x bin area / track pitch, minus the pin area in the bin. Utilisation > 1 means the
// bin needs more track length than it has. On acc its overflow ranks routed clean nets with Spearman -0.90
// (bench/routability-diag.mjs).
import { worldPin } from '../src/problem.js';

/**
 * @returns {{ util: Float64Array, gw, gh, cw, ch, binOf(x, y): number, over: number, top10: number }}
 */
export function rudyMap(problem, layout, { gw = 40, gh = null, layers = 2, pitch = 0.5, pinArea = 0.4, nets = problem.nets } = {}) {
  const W = problem.canvas.width, H = problem.canvas.height;
  gh ??= Math.max(8, Math.round(gw * H / W));
  const cw = W / gw, ch = H / gh, demand = new Float64Array(gw * gh), pins = new Float64Array(gw * gh);
  const cx = (x) => Math.max(0, Math.min(gw - 1, Math.floor(x / cw))), cy = (y) => Math.max(0, Math.min(gh - 1, Math.floor(y / ch)));
  for (const net of nets) {
    if (net.pins.length < 2) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pi of net.pins) { const [x, y] = worldPin(problem, layout, pi); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); pins[cy(y) * gw + cx(x)]++; }
    x0 -= pitch; y0 -= pitch; x1 += pitch; y1 += pitch;
    const dens = ((x1 - x0) + (y1 - y0)) / ((x1 - x0) * (y1 - y0));
    for (let gx = cx(x0); gx <= cx(x1); gx++) for (let gy = cy(y0); gy <= cy(y1); gy++) {
      const ox = Math.min(x1, (gx + 1) * cw) - Math.max(x0, gx * cw), oy = Math.min(y1, (gy + 1) * ch) - Math.max(y0, gy * ch);
      if (ox > 0 && oy > 0) demand[gy * gw + gx] += dens * ox * oy;
    }
  }
  const full = layers * cw * ch / pitch;
  const util = demand.map((d, i) => d / Math.max(0.1 * full, full - pins[i] * pinArea / pitch));
  const over = util.reduce((s, u) => s + Math.max(0, u - 1) ** 2, 0), top = [...util].sort((a, b) => b - a).slice(0, Math.ceil(util.length / 10));
  return { util, gw, gh, cw, ch, binOf: (x, y) => cy(y) * gw + cx(x), over, top10: top.reduce((s, u) => s + u, 0) / top.length };
}
