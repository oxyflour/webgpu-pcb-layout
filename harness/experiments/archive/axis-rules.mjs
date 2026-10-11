// Which rule predicts the human orientation AXIS of small 2-pad parts (perfect context: the part at
// its human position, all other parts at their human poses)? Agreement with the human axis (share):
//   pins   : current init rule (signal pins closest to the pins they connect to)
//   fit    : the axis whose footprint overlaps the other parts least (0.1 mm clearance, same side)
//   rows   : the axis of the majority of 2-pad neighbours within 3 mm (same side)
//   edge   : long axis perpendicular to the nearest IC edge (radial) if within 5 mm of an IC
//   fit>pins : fit, ties (both fit / both overlap equally) broken by pins
// node harness/experiments/axis-rules.mjs [board ...]
import { loadBoard, BOARDS, worldPin, rotatedSize } from '../../lib/board.mjs';
console.log('| Board | 2-pad small parts (count) | pins rule (share) | fit rule (share) | fit, both fit (share of parts) | rows rule (share) | IC-edge rule (share, parts near an IC) | fit>pins (share) |\n|---|---|---|---|---|---|---|---|');
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BOARDS)) {
  const b = loadBoard(name), p = b.p, C = p.components, H = b.a.originalLayout, n = C.length, fp = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
  const netOfPin = new Map(); p.nets.forEach((nt) => { if (new Set(nt.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30) nt.pins.forEach((pi) => netOfPin.set(pi, nt)); });
  const box = (i, q) => { const [w, h] = rotatedSize(C[i], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
  const shares = (i, j) => C[i].twoSided || C[j].twoSided || H[i].side === H[j].side;
  const ics = [...Array(n).keys()].filter((i) => C[i].pins.length >= 8);
  const axis = (r) => r % 2;
  let N = 0, ok = { pins: 0, fit: 0, rows: 0, rowsN: 0, edge: 0, edgeN: 0, fp: 0 }, both = 0;
  for (let i = 0; i < n; i++) {
    const f = fp.get(C[i].id); if (C[i].fixed || f.pads.length !== 2 || C[i].rotatable === false || Math.abs(C[i].width - C[i].height) < 0.05) continue;
    N++; const hA = axis(H[i].rotation), L = H.map((q) => ({ ...q }));
    // pins rule
    let best = null;
    for (let r = 0; r < 4; r++) { L[i] = { ...H[i], rotation: r }; let cost = 0;
      for (const pi of C[i].pins) { const nt = netOfPin.get(pi); if (!nt) continue; const [x, y] = worldPin(p, L, pi); for (const q of nt.pins) { if (p.pins[q].componentIndex === i) continue; const [u, v] = worldPin(p, L, q); cost += Math.abs(u - x) + Math.abs(v - y); } }
      if (!best || cost < best.cost - 1e-9) best = { r, cost }; }
    const pinsA = best && C[i].pins.length ? axis(best.r) : null; if (pinsA === hA) ok.pins++;
    // fit rule
    const ov = [0, 1].map((a) => { const a0 = box(i, { ...H[i], rotation: a }); let s = 0; for (let j = 0; j < n; j++) { if (j === i || !shares(i, j)) continue; const c = box(j, H[j]); const ox = Math.min(a0[2], c[2] + 0.1) - Math.max(a0[0], c[0] - 0.1), oy = Math.min(a0[3], c[3] + 0.1) - Math.max(a0[1], c[1] - 0.1); if (ox > 0 && oy > 0) s += ox * oy; } return s; });
    const fitA = ov[0] < ov[1] - 1e-9 ? 0 : ov[1] < ov[0] - 1e-9 ? 1 : null; if (fitA === hA) ok.fit++; if (fitA === null) both++;
    if ((fitA ?? pinsA) === hA) ok.fp++;
    // rows rule
    const nb = [...Array(n).keys()].filter((j) => j !== i && shares(i, j) && fp.get(C[j].id).pads.length === 2 && Math.hypot(H[j].x - H[i].x, H[j].y - H[i].y) < 3 && Math.abs(C[j].width - C[j].height) > 0.05);
    if (nb.length) { ok.rowsN++; const v = nb.reduce((s, j) => s + (axis(H[j].rotation) === 1 ? 1 : -1), 0); if (v !== 0 && (v > 0 ? 1 : 0) === hA) ok.rows++; }
    // IC-edge rule
    let e = null; for (const k of ics) { if (!shares(i, k)) continue; const c = box(k, H[k]); const dx = Math.max(c[0] - H[i].x, 0, H[i].x - c[2]), dy = Math.max(c[1] - H[i].y, 0, H[i].y - c[3]), d = Math.hypot(dx, dy); if (d < 5 && (!e || d < e.d)) e = { d, radialX: dx >= dy }; }
    if (e) { ok.edgeN++; const longX = 0; /* rotation 0: long axis = x if width > height */ const longAxisXat0 = C[i].width > C[i].height; const want = e.radialX === longAxisXat0 ? 0 : 1; if (want === hA) ok.edge++; }
  }
  const s = (x, d = N) => (x / d).toFixed(2);
  console.log(`| ${name} | ${N} | ${s(ok.pins)} | ${s(ok.fit)} | ${s(both)} | ${s(ok.rows, ok.rowsN)} (n=${ok.rowsN}) | ${s(ok.edge, ok.edgeN)} (n=${ok.edgeN}) | ${s(ok.fp)} |`);
}
