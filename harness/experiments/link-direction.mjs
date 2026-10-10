// Is the template offset d1 (parent pin -> own linked pin, experiments/templates.mjs) explained by
// context? Human layouts, Prim-tree parents. For parts whose d1 > 0.5 mm: cosine between d1 and
// the direction from the parent pin to the centroid of the part's OTHER linked pins (other nets,
// human poses), and the error of the predictor d1 = |class median d1| x that direction.
// Also the share of parts with no other link (direction undefined).
// node harness/experiments/link-direction.mjs [board ...]
import { loadBoard, BOARDS, worldPin } from '../lib/board.mjs';
import { analyse } from './templates.mjs';
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
console.log('| Board | Small parts with d1 > 0.5 mm (count) | No other link (share) | cos(d1, direction to other links): p25 / p50 (1 = same direction) | cos > 0.7 (share) | d1 error, zero predictor, p50 (mm) | d1 error, |d1| along that direction (oracle length), p50 (mm) |\n|---|---|---|---|---|---|---|');
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BOARDS)) {
  const b = loadBoard(name), H = b.a.originalLayout, A = analyse(b), { p } = A;
  const cs = [], ez = [], ed = []; let none = 0, N = 0;
  for (const [i, par] of A.tree()) {
    const [px, py] = worldPin(p, H, par.c), [qx, qy] = worldPin(p, H, par.a), d1 = [qx - px, qy - py], l1 = Math.hypot(...d1);
    if (l1 <= 0.5) continue; N++;
    const netOfPar = p.nets.findIndex((nt) => nt.pins.includes(par.a));
    const others = A.links[i].filter(([a, c]) => !p.nets[netOfPar].pins.includes(c)).map(([, c]) => worldPin(p, H, c));
    if (!others.length) { none++; continue; }
    const ox = others.reduce((s, v) => s + v[0], 0) / others.length - px, oy = others.reduce((s, v) => s + v[1], 0) / others.length - py, lo = Math.hypot(ox, oy) || 1;
    const c = (d1[0] * ox + d1[1] * oy) / (l1 * lo); cs.push(c);
    ez.push(l1); ed.push(Math.hypot(d1[0] - l1 * ox / lo, d1[1] - l1 * oy / lo));
  }
  console.log(`| ${name} | ${N} | ${(none / N).toFixed(2)} | ${q(cs, .25).toFixed(2)} / ${q(cs, .5).toFixed(2)} | ${(cs.filter((c) => c > 0.7).length / cs.length).toFixed(2)} | ${q(ez, .5).toFixed(1)} | ${q(ed, .5).toFixed(1)} |`);
}
