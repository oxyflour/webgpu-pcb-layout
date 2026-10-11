// How many anchors does a small part (<= 4 signal pins, movable) hang on in the human layout?
// Anchor = graph neighbour with pin-to-pin distance <= T mm. Also: share of all its neighbours
// that are far (> 10 mm) — links a one-by-one outward placement could ignore.
import { loadBoard, BOARDS, worldPin } from '../../lib/board.mjs';
const argv = process.argv.slice(2), T = 3;
console.log(['board', 'small parts (count)', 'neighbours per part (median)', '0 anchors <=3mm (share)', '1 anchor (share)', '2 anchors (share)', '>=3 anchors (share)', 'nearest neighbour is an IC (share)', 'links >10mm (share of small-part links)'].join('\t'));
for (const name of argv.length ? argv : Object.keys(BOARDS)) {
  const b = loadBoard(name), p = b.p, n = p.components.length, H = b.a.originalLayout;
  const sig = new Array(n).fill(0), m = new Map(), adj = Array.from({ length: n }, () => new Set());
  for (const net of p.nets) { const ps = net.pins.map((pi) => [p.pins[pi].componentIndex, ...worldPin(p, H, pi)]); const cs = new Set(ps.map((x) => x[0])); if (cs.size < 2 || cs.size > 30) continue;
    for (const a of ps) { sig[a[0]]++; for (const c of ps) if (a[0] !== c[0]) { adj[a[0]].add(c[0]); const k = a[0] * 1e5 + c[0], v = Math.hypot(a[1] - c[1], a[2] - c[2]); if (!(m.get(k) <= v)) m.set(k, v); } } }
  const d = (i, j) => m.get(i * 1e5 + j);
  const small = [...Array(n).keys()].filter((i) => !p.components[i].fixed && sig[i] >= 1 && sig[i] <= 4 && adj[i].size);
  const anc = small.map((i) => [...adj[i]].filter((j) => d(i, j) <= T).length);
  const sh = (f) => (small.filter((_, k) => f(anc[k])).length / small.length).toFixed(2);
  const ic = small.filter((i) => { const nn = [...adj[i]].reduce((a, j) => d(i, j) < d(i, a) ? j : a); return sig[nn] >= 8; }).length;
  const links = small.flatMap((i) => [...adj[i]].map((j) => d(i, j)));
  const deg = small.map((i) => adj[i].size).sort((a, c) => a - c);
  console.log([name, small.length, deg[deg.length >> 1], sh((x) => x === 0), sh((x) => x === 1), sh((x) => x === 2), sh((x) => x >= 3), (ic / small.length).toFixed(2), (links.filter((x) => x > 10).length / links.length).toFixed(2)].join('\t'));
}
