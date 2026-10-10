// Net crossings of a layout: every signal net (2-30 parts) as the minimum spanning tree of its
// pins (straight segments); count segment pairs of different nets that intersect. Split by
// whether both segments touch a small part (< 8 pins) and by the layer side of the pads (top /
// bottom only when both ends are SMD pads on one side, else 'both').
// node harness/experiments/crossings.mjs --board k60 layout.json ...   ('human' = the KiCad layout)
import fs from 'node:fs';
import { loadBoard, legalize, worldPin } from '../lib/board.mjs';
const argv = process.argv.slice(2), bi = argv.indexOf('--board'), b = loadBoard(argv[bi + 1]), p = b.p, C = p.components;
const files = argv.filter((a, k) => k !== bi && k !== bi + 1);
function segments(L) {
  const segs = [];
  p.nets.forEach((net, ni) => {
    if (new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size > 30 || net.pins.length < 2) return;
    const pts = net.pins.map((pi) => [...worldPin(p, L, pi), pi]), inT = new Array(pts.length).fill(false), best = pts.map(() => [Infinity, -1]);
    inT[0] = true; for (let k = 1; k < pts.length; k++) best[k] = [Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]), 0];
    for (let it = 1; it < pts.length; it++) {
      let u = -1; for (let k = 0; k < pts.length; k++) if (!inT[k] && (u < 0 || best[k][0] < best[u][0])) u = k;
      inT[u] = true; const a = pts[best[u][1]], c = pts[u];
      segs.push({ ni, a, c, small: C[p.pins[a[2]].componentIndex].pins.length < 8 || C[p.pins[c[2]].componentIndex].pins.length < 8 });
      for (let k = 0; k < pts.length; k++) if (!inT[k]) { const d = Math.hypot(pts[k][0] - c[0], pts[k][1] - c[1]); if (d < best[k][0]) best[k] = [d, u]; }
    }
  });
  return segs;
}
const cross = (s, t) => { const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(s.a, s.c, t.a) * o(s.a, s.c, t.c) < 0 && o(t.a, t.c, s.a) * o(t.a, t.c, s.c) < 0; };
function crossings(L) {
  const segs = segments(L); let all = 0, smallBoth = 0, len = 0;
  for (const s of segs) len += Math.hypot(s.a[0] - s.c[0], s.a[1] - s.c[1]);
  for (let u = 0; u < segs.length; u++) for (let v = u + 1; v < segs.length; v++) if (segs[u].ni !== segs[v].ni && cross(segs[u], segs[v])) { all++; if (segs[u].small && segs[v].small) smallBoth++; }
  return { segments: segs.length, crossings: all, crossingsSmallSmall: smallBoth, mstLengthMm: Math.round(len) };
}
for (const f of files) {
  const L = f === 'human' ? b.a.originalLayout : f === 'human-legal' ? legalize(b, b.a.originalLayout).layout : (() => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.layout ?? j; })();
  console.log(JSON.stringify({ layout: f, ...crossings(L) }));
}
