// Rotation rule of the tool init vs the human, with perfect context (all other parts at their
// human pose, part at its human position): the init's choice (pins closest to the pins they
// connect to) vs the human rotation, split by 180 deg (flipped) / 90 deg (other axis), by kind.
// node harness/experiments/rot-rule.mjs --board k60
import { loadBoard, worldPin, rotatedSize } from '../lib/board.mjs';
const argv = process.argv.slice(2), b = loadBoard(argv[argv.indexOf('--board') + 1]), p = b.p, C = p.components, H = b.a.originalLayout;
const netOfPin = new Map(); p.nets.forEach((nt) => { if (new Set(nt.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30) nt.pins.forEach((pi) => netOfPin.set(pi, nt)); });
const fp = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
const stats = {};
for (let i = 0; i < C.length; i++) {
  if (C[i].fixed || C[i].pins.length >= 8 || C[i].rotatable === false || !C[i].pins.some((pi) => netOfPin.has(pi))) continue;
  const L = H.map((q) => ({ ...q })); let best = null;
  for (let r = 0; r < 4; r++) { L[i] = { ...H[i], rotation: r }; let cost = 0;
    for (const pi of C[i].pins) { const nt = netOfPin.get(pi); if (!nt) continue; const [x, y] = worldPin(p, L, pi);
      for (const q of nt.pins) { if (p.pins[q].componentIndex === i) continue; const [u, v] = worldPin(p, L, q); cost += Math.abs(u - x) + Math.abs(v - y); } }
    if (!best || cost < best.cost - 1e-9) best = { r, cost }; }
  const d = ((best.r - H[i].rotation) % 4 + 4) % 4, [w, h] = [C[i].width, C[i].height];
  const kind = `${fp.get(C[i].id).pads.length}pads-${C[i].pins.length}sig${Math.abs(w - h) < 0.05 ? '-square' : ''}`;
  stats[kind] ??= { n: 0, same: 0, flip: 0, axis: 0 }; const s = stats[kind]; s.n++; if (d === 0) s.same++; else if (d === 2) s.flip++; else s.axis++;
}
console.log('| Part kind (pads, signal pins) | Parts (count) | Rule = human (count) | Rule flipped 180 deg (count) | Rule on the other axis (count) |\n|---|---|---|---|---|');
for (const [k, s] of Object.entries(stats).sort((a, c) => c[1].n - a[1].n)) console.log(`| ${k} | ${s.n} | ${s.same} | ${s.flip} | ${s.axis} |`);
