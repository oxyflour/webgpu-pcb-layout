// Occupancy around ICs: share of the area of bands outside each IC outline (0-1, 1-3, 3-6, 6-10 mm)
// covered by part bodies (same board side as the IC, other side reported separately), and the
// pin density (pins per cm2) in the same bands. ICs = movable parts with >= 8 pins.
// node harness/experiments/ic-bands.mjs --board k60 human L1.json ...
import fs from 'node:fs';
import { loadBoard, legalize, worldPin, rotatedSize } from '../lib/board.mjs';
const argv = process.argv.slice(2), bi = argv.indexOf('--board'), b = loadBoard(argv[bi + 1]), p = b.p, C = p.components;
const files = argv.filter((a, k) => k !== bi && k !== bi + 1), bands = [[0, 1], [1, 3], [3, 6], [6, 10]], step = 0.25;
const ics = C.map((c, i) => !c.fixed && c.pins.length >= 8 ? i : -1).filter((i) => i >= 0);
for (const f of files) {
  const L = f === 'human' ? legalize(b, b.a.originalLayout).layout : (() => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.layout ?? j; })();
  const rects = C.map((c, i) => { const [w, h] = rotatedSize(c, L[i].rotation); return [L[i].x - w / 2, L[i].y - h / 2, L[i].x + w / 2, L[i].y + h / 2, L[i].side]; });
  const pins = p.pins.map((q, pi) => worldPin(p, L, pi));
  const cover = bands.map(() => [0, 0, 0]), pinCount = bands.map(() => 0);
  for (const k of ics) { const [x0, y0, x1, y1, side] = rects[k];
    for (let x = x0 - 10 + step / 2; x < x1 + 10; x += step) for (let y = y0 - 10 + step / 2; y < y1 + 10; y += step) {
      const d = Math.max(x0 - x, x - x1, y0 - y, y - y1, 0) === 0 ? -1 : Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
      const bi2 = bands.findIndex(([a, c]) => d >= a && d < c); if (bi2 < 0) continue;
      cover[bi2][0]++;
      let same = false, other = false; for (let i = 0; i < C.length; i++) { const r = rects[i]; if (i !== k && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) { if (r[4] === side || C[i].twoSided) same = true; else other = true; } }
      if (same) cover[bi2][1]++; if (other) cover[bi2][2]++;
    }
    for (const [x, y] of pins) { const d = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1)); const bi2 = bands.findIndex(([a, c]) => d > 0 && d >= a && d < c); if (bi2 >= 0) pinCount[bi2]++; }
  }
  console.log(f.split('/').slice(-1)[0].padEnd(14), bands.map(([a, c], k) => `${a}-${c}mm: same ${(cover[k][1] / cover[k][0]).toFixed(2)} other ${(cover[k][2] / cover[k][0]).toFixed(2)} pins/cm2 ${(pinCount[k] / (cover[k][0] * step * step / 100)).toFixed(1)}`).join(' | '));
}
