// Small parts in the frame of their anchor IC pin, human vs tool layout. Anchor = the pin of a
// part with >= 8 pins (IC or connector) linked to the small part with the shortest human
// pin-to-pin distance. Frame: n = outward normal of the IC edge the pin is on, t = tangent.
//   r = outward offset of the small part's centre from the anchor pin (mm), tau = |tangential|
//   radial = long axis of the part along n; order = for two parts on the same IC edge, their
//   order along t matches the order of their anchor pins (concordant pairs, share)
// node harness/experiments/pin-frame.mjs --board k60 --layout final-layout.json
import fs from 'node:fs';
import { loadBoard, legalize, worldPin, rotatedSize } from '../../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, H = b.a.originalLayout;
const lays = { human: H }; if (arg('layout')) { const j = JSON.parse(fs.readFileSync(arg('layout'), 'utf8')); lays.tool = legalize(b, j.layout ?? j).layout; }
const small = (i) => !C[i].fixed && C[i].pins.length < 8, big = (i) => C[i].pins.length >= 8;
// anchor per small part: [smallPin, bigPin] with min human distance
const anchor = new Map();
for (const net of p.nets) { const cs = new Set(net.pins.map((pi) => p.pins[pi].componentIndex)); if (cs.size < 2 || cs.size > 30) continue;
  for (const a of net.pins) { const i = p.pins[a].componentIndex; if (!small(i)) continue;
    for (const c of net.pins) { const k = p.pins[c].componentIndex; if (!big(k)) continue;
      const [x1, y1] = worldPin(p, H, a), [x2, y2] = worldPin(p, H, c), d = Math.hypot(x1 - x2, y1 - y2);
      if (!(anchor.get(i)?.d <= d)) anchor.set(i, { a, c, k, d }); } } }
const frame = (L, k, c) => { // outward normal of the IC edge carrying pin c
  const [x, y] = worldPin(p, L, c), [w, h] = rotatedSize(C[k], L[k].rotation), dx = (x - L[k].x) / (w / 2 || 1), dy = (y - L[k].y) / (h / 2 || 1);
  const n = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
  return { x, y, n, t: [-n[1], n[0]], edge: `${k}:${n}` }; };
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
console.log(`small parts with an anchor: ${anchor.size} of ${C.filter((c, i) => small(i)).length}; anchor = connector/fixed: ${[...anchor.values()].filter((v) => C[v.k].fixed).length}`);
for (const [name, L] of Object.entries(lays)) {
  const R = [], T = [], rad = [], inside = [], sameEdge = [], pinDist = [], perEdge = new Map();
  for (const [i, { a, c, k }] of anchor) {
    const f = frame(L, k, c), fh = frame(H, k, c);
    const r = (L[i].x - f.x) * f.n[0] + (L[i].y - f.y) * f.n[1], tau = (L[i].x - f.x) * f.t[0] + (L[i].y - f.y) * f.t[1];
    R.push(r); T.push(Math.abs(tau)); inside.push(r < 0);
    const [w, h] = rotatedSize(C[i], L[i].rotation); if (Math.abs(w - h) > 0.2) rad.push((w > h) === (f.n[0] !== 0));
    const [px, py] = worldPin(p, L, a); pinDist.push(Math.hypot(px - f.x, py - f.y));
    // is the small part's own linked pin its pin nearest to the IC (pins pointing at the IC)?
    if (!perEdge.has(fh.edge)) perEdge.set(fh.edge, []); perEdge.get(fh.edge).push({ pinT: f.x * f.t[0] + f.y * f.t[1], partT: L[i].x * f.t[0] + L[i].y * f.t[1], r });
  }
  let con = 0, tot = 0;
  for (const list of perEdge.values()) for (let u = 0; u < list.length; u++) for (let v = u + 1; v < list.length; v++) { const dp = list[u].pinT - list[v].pinT, dq = list[u].partT - list[v].partT; if (Math.abs(dp) < 0.01) continue; tot++; con += dp * dq > 0; }
  const f2 = (x) => x.toFixed(2);
  console.log(`${name.padEnd(6)} r p10/p50/p90 ${f2(q(R, .1))}/${f2(q(R, .5))}/${f2(q(R, .9))} mm | |tau| p50/p90 ${f2(q(T, .5))}/${f2(q(T, .9))} | under IC (r<0) ${f2(inside.filter(Boolean).length / inside.length)} | radial ${f2(rad.filter(Boolean).length / rad.length)} | own pin to anchor pin p50/p90 ${f2(q(pinDist, .5))}/${f2(q(pinDist, .9))} | order kept ${f2(con / tot)} (${tot} pairs)`);
}
