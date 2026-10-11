// Fine geometric structure of a layout. For every 2-pin connection (net with exactly 2 pins)
// touching a small part (< 8 pins): straight = the two pins share x or y within tol; also the
// share of small parts whose centre shares x or y (within tol) with another small part on the
// same side within 10 mm (rows / columns), and the median gap to the nearest same-side neighbour.
// node harness/experiments/alignment.mjs --board k60 [--tol 0.05] human L.json ...
import fs from 'node:fs';
import { loadBoard, legalize, worldPin, rotatedSize } from '../../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, tol = Number(arg('tol', 0.05));
const files = argv.filter((a, k) => !a.startsWith('--') && !argv[k - 1]?.startsWith('--'));
const small = (i) => !C[i].fixed && C[i].pins.length < 8;
for (const f of files) {
  const L = f === 'human' ? b.a.originalLayout : f === 'human-legal' ? legalize(b, b.a.originalLayout).layout : (() => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j.layout ?? j; })();
  let two = 0, straight = 0, straightBig = 0, twoBig = 0;
  for (const net of p.nets) { if (net.pins.length !== 2) continue; const [a, c] = net.pins, i = p.pins[a].componentIndex, k = p.pins[c].componentIndex; if (!small(i) && !small(k)) continue;
    const [x1, y1] = worldPin(p, L, a), [x2, y2] = worldPin(p, L, c), s = Math.abs(x1 - x2) < tol || Math.abs(y1 - y2) < tol;
    two++; straight += s; if (!small(i) || !small(k)) { twoBig++; straightBig += s; } }
  const sm = C.map((c, i) => i).filter(small); let rowed = 0; const gaps = [];
  const box = (i) => { const [w, h] = rotatedSize(C[i], L[i].rotation); return [L[i].x - w / 2, L[i].y - h / 2, L[i].x + w / 2, L[i].y + h / 2]; };
  for (const i of sm) { let r = false, g = Infinity; const a = box(i);
    for (const k of sm) { if (k === i || L[k].side !== L[i].side) continue; const dx = Math.abs(L[i].x - L[k].x), dy = Math.abs(L[i].y - L[k].y); if (Math.max(dx, dy) > 10) continue;
      if (dx < tol || dy < tol) r = true; const c = box(k); g = Math.min(g, Math.max(c[0] - a[2], a[0] - c[2], c[1] - a[3], a[1] - c[3], 0)); }
    rowed += r; if (g < Infinity) gaps.push(g); }
  gaps.sort((x, y) => x - y);
  console.log(`${f.split('/').slice(-2).join('/').padEnd(28)} 2-pin links straight ${(straight / two).toFixed(2)} (to IC/connector ${(straightBig / twoBig).toFixed(2)}, n=${two}) | small parts in a row/column ${(rowed / sm.length).toFixed(2)} | nearest-neighbour gap p25/p50 ${gaps[gaps.length >> 2].toFixed(2)}/${gaps[gaps.length >> 1].toFixed(2)} mm`);
}
