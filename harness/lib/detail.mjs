// Detailed placement after the legalizer: greedy local search on small parts (movable, < 8 pins),
// legal moves only (no body overlap at 0.1 mm clearance on a shared side, inside the canvas):
// shift 0.4-2 mm, quarter / half turn, swap with a same-size part within 6 mm. A move is kept when
//   cost = HPWL (mm, all nets, benchmark definition) + nu * channel deficit (mm)
// drops (simulated annealing: a worse move is kept with probability exp(-d / T), T falls geometrically
// from T0 to T0 / 1000 over the time budget; T0 = 0 is greedy). A fourth move, relocate, jumps the part
// next to its partners (mean of the other pins of its nets with <= 30 parts, +-1.5 mm).
// Channel deficit = sum over facing pad pairs (different parts and nets, shared layer, overlapping in
// the other axis) of max(0, 0.8 mm - gap) (a 0.4-0.8 mm gap passes 0 or 1 track on the 0.4 mm routing
// grid depending on the grid phase; human k60: 161 such pairs, tool 598). Neighbour queries use a
// 4 mm bucket grid of part bodies.
// experiments/attract.mjs (obj hpwlg) is the offline version; RESULTS.md "Attraction test".
import { rotatedSize, worldPin } from './board.mjs';
import { loadConstraints } from './constraints.mjs';
// Optional human-practice terms (RESULTS.md "New metrics against the human layout"):
//   kappa (default 0.5) * distance (mm) of every decoupling capacitor's supply pad to the nearest supply pad of
//   its assigned IC(s) (lib/constraints.mjs: constraint file, else same schematic sheet, else any IC on the
//   supply) beyond decapFreeMm, + 10 x kappa per mm beyond a decap's maxMm; chi: crystal nets count (1 + chi) x HPWL.
const analyses = new WeakMap();

export function detailPlace(b, layout, { nu = 2, T0 = 3, relocate = 0.15, evals = Infinity, budgetS = 30, seed = 1, gap = 0.8, clearance = 0.1, kappa = 0.5, decapFreeMm = 0, chi = 0 } = {}) {
  const p = b.p, C = p.components, n = C.length, L = layout.map((q) => ({ ...q })), t0 = performance.now();
  let s = seed * 2654435761 >>> 0; const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296), pickOf = (a) => a[Math.floor(rnd() * a.length)];
  const small = [...Array(n).keys()].filter((i) => !C[i].fixed && C[i].pins.length < 8);
  if (!small.length) return { layout: L, evals: 0, accepted: 0 };
  const W = p.canvas.width, H = p.canvas.height;
  const box = (i, q = L[i]) => { const [w, h] = rotatedSize(C[i], q.rotation); return [q.x - w / 2, q.y - h / 2, q.x + w / 2, q.y + h / 2]; };
  const shares = (i, j) => C[i].twoSided || C[j].twoSided || L[i].side === L[j].side;
  // Bucket grid of part bodies (4 mm cells); `where[i]` = cells holding part i, updated on accepted moves.
  const G = 4, gw = Math.ceil(W / G) + 1, gh = Math.ceil(H / G) + 1, buckets = Array.from({ length: gw * gh }, () => []), where = new Array(n), mark = new Int32Array(n);
  let stamp = 0;
  const cellRange = (a) => [Math.max(0, Math.min(gw - 1, Math.floor(a[0] / G))), Math.max(0, Math.min(gh - 1, Math.floor(a[1] / G))), Math.max(0, Math.min(gw - 1, Math.floor(a[2] / G))), Math.max(0, Math.min(gh - 1, Math.floor(a[3] / G)))];
  const insert = (i) => { const [x0, y0, x1, y1] = cellRange(box(i)); where[i] = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { buckets[y * gw + x].push(i); where[i].push(y * gw + x); } };
  const remove = (i) => { for (const c of where[i]) { const bk = buckets[c], k = bk.indexOf(i); bk[k] = bk[bk.length - 1]; bk.pop(); } };
  for (let i = 0; i < n; i++) insert(i);
  // Visit every part whose cells meet rectangle a (each once per stamp).
  const visit = (a, fn) => { const [x0, y0, x1, y1] = cellRange(a); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (const j of buckets[y * gw + x]) if (mark[j] !== stamp) { mark[j] = stamp; fn(j); } };
  const legalAt = (i, skip = -1) => { const a = box(i); if (a[0] < 0 || a[1] < 0 || a[2] > W || a[3] > H) return false;
    let ok = true; stamp++; visit([a[0] - clearance, a[1] - clearance, a[2] + clearance, a[3] + clearance], (j) => { if (!ok || j === i || j === skip || !shares(i, j)) return; const c = box(j); if (a[0] < c[2] + clearance && c[0] < a[2] + clearance && a[1] < c[3] + clearance && c[1] < a[3] + clearance) ok = false; }); return ok; };
  // HPWL per net.
  const netsOf = Array.from({ length: n }, () => new Set()); p.nets.forEach((net, ni) => net.pins.forEach((pi) => netsOf[p.pins[pi].componentIndex].add(ni)));
  const hp = (ni) => { const ps = p.nets[ni].pins; if (ps.length < 2) return 0; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pi of ps) { const [x, y] = worldPin(p, L, pi); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return x1 - x0 + y1 - y0; };
  const hpN = p.nets.map((_, ni) => hp(ni));
  // Decoupling and crystal terms.
  const CN = kappa || chi ? (analyses.get(b) ?? (analyses.set(b, loadConstraints(b)), analyses.get(b))) : null, HA = CN?.analysis;
  const wN = new Float64Array(p.nets.length).fill(1); if (chi) for (const ni of HA.groups.crystal) wN[ni] = 1 + chi;
  const decaps = kappa ? CN.decaps.map((d) => { const ics = new Set(d.ics); return { ...d, ic: HA.icPadsOn[d.net].filter((q) => ics.has(HA.padOf[q].comp)) }; }).filter((d) => d.ic.length) : [];
  const decapOwn = new Int32Array(n).fill(-1); decaps.forEach((d, k) => { decapOwn[d.comp] = k; });
  const decapsBy = Array.from({ length: n }, () => []); decaps.forEach((d, k) => { decapsBy[d.comp].push(k); for (const q of new Set(d.ic.map((q) => HA.padOf[q].comp))) decapsBy[q].push(k); });
  const centre = (rp) => { const q = L[rp.comp], [rx, ry] = rq(q.side ? -rp.lx : rp.lx, rp.ly, q.rotation); return [q.x + rx, q.y + ry]; };
  const decapDist = (k) => { const d = decaps[k], [x, y] = centre(HA.padOf[d.pad].rp); let best = Infinity; for (const q of d.ic) { const [u, v] = centre(HA.padOf[q].rp), e = Math.hypot(u - x, v - y); if (e < best) best = e; } return Math.max(0, best - decapFreeMm) + (d.maxMm != null ? 10 * Math.max(0, best - d.maxMm) : 0); };
  const decapOf = (parts) => { if (!kappa) return 0; const ks = new Set(parts.flatMap((i) => decapsBy[i])); let s = 0; for (const k of ks) s += decapDist(k); return s; };
  // Channel deficit (router pad geometry, as src/router/board-router.js rasterizes it).
  const RP = b.a.routing.pads, padsOf = Array.from({ length: n }, () => []); RP.forEach((pad, pi) => padsOf[pad.comp].push(pi));
  const rq = (x, y, r) => { r = ((r % 4) + 4) % 4; return r === 0 ? [x, y] : r === 1 ? [-y, x] : r === 2 ? [-x, -y] : [y, -x]; };
  const padBox = (pi) => { const pad = RP[pi], q = L[pad.comp], [rx, ry] = rq(q.side ? -pad.lx : pad.lx, pad.ly, q.rotation), a = pad.rot * Math.PI / 180;
    let hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h), hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h); if (q.rotation & 1) [hx, hy] = [hy, hx];
    const x = q.x + rx, y = q.y + ry; return [x - hx, y - hy, x + hx, y + hy, pad.tht || pad.hole ? 3 : q.side === 1 ? 2 : 1]; };
  const pairPen = (pi, a, pj, c) => { if (RP[pi].comp === RP[pj].comp || (RP[pi].net >= 0 && RP[pi].net === RP[pj].net) || !(a[4] & c[4])) return 0;
    const ox = Math.min(a[2], c[2]) - Math.max(a[0], c[0]), oy = Math.min(a[3], c[3]) - Math.max(a[1], c[1]);
    const g = ox > 0 && oy <= 0 ? -oy : oy > 0 && ox <= 0 ? -ox : ox > 0 && oy > 0 ? 0 : Infinity; return g < gap ? gap - g : 0; };
  // Deficit of the pairs involving the pads of `parts` (pairs inside `parts` once); only parts whose
  // body is within `gap` + 2 mm of a moved part can contribute.
  const chanOf = (parts) => { const S = new Set(parts), mine = parts.flatMap((i) => padsOf[i]), mb = mine.map(padBox), r = gap + 2; let sum = 0;
    const near = [...parts]; stamp++; for (const i of parts) mark[i] = stamp;
    for (const i of parts) { const a = box(i); visit([a[0] - r, a[1] - r, a[2] + r, a[3] + r], (j) => near.push(j)); }
    for (const j of near) { if (!padsOf[j].length) continue;
      for (const pj of padsOf[j]) { const cb = padBox(pj); for (let k = 0; k < mine.length; k++) { if (S.has(j) && pj <= mine[k]) continue; sum += pairPen(mine[k], mb[k], pj, cb); } } }
    return sum; };
  const sig = p.nets.map((net) => new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30);
  const partnerMean = (i) => { let sx = 0, sy = 0, k = 0; for (const ni of netsOf[i]) { if (!sig[ni]) continue; for (const pi of p.nets[ni].pins) { if (p.pins[pi].componentIndex === i) continue; const [x, y] = worldPin(p, L, pi); sx += x; sy += y; k++; } } return k ? [sx / k, sy / k] : null; };
  const sizeKey = (i, r) => rotatedSize(C[i], r).map((v) => v.toFixed(2)).join();
  let tried = 0, accepted = 0, delta = 0;
  while (tried < evals && (performance.now() - t0) / 1000 < budgetS) {
    const i = pickOf(small), old = { ...L[i] }, kind = rnd(); let j = -1, oldJ = null;
    // relocate: next to the partners' mean; a decoupling capacitor jumps next to a supply pad of its IC.
    if (kind < relocate) { const own = decapOwn[i], m = own >= 0 ? centre(HA.padOf[pickOf(decaps[own].ic)].rp) : partnerMean(i); if (!m) continue; L[i] = { ...old, x: m[0] + (rnd() * 2 - 1) * 1.5, y: m[1] + (rnd() * 2 - 1) * 1.5 }; }
    else if (kind < relocate + (1 - relocate) * 0.55) { const st = pickOf([0.4, 0.8, 1.2, 2]), dir = pickOf([[1, 0], [-1, 0], [0, 1], [0, -1]]); L[i] = { ...old, x: old.x + dir[0] * st, y: old.y + dir[1] * st }; }
    else if (kind < relocate + (1 - relocate) * 0.8) { if (C[i].rotatable === false) continue; L[i] = { ...old, rotation: (old.rotation + pickOf([1, 2, 3])) % 4 }; }
    else { const sz = sizeKey(i, old.rotation);
      const others = small.filter((k) => k !== i && L[k].side === old.side && Math.abs(L[k].x - old.x) < 6 && Math.abs(L[k].y - old.y) < 6 && Math.hypot(L[k].x - old.x, L[k].y - old.y) < 6 && [0, 1].some((r) => sizeKey(k, (L[k].rotation + r) % 4) === sz));
      if (!others.length) continue; j = pickOf(others); oldJ = { ...L[j] };
      const rj = sizeKey(j, oldJ.rotation) === sz ? oldJ.rotation : (oldJ.rotation + 1) % 4, ri = sz === sizeKey(j, oldJ.rotation) ? old.rotation : (old.rotation + 1) % 4;
      L[i] = { ...old, x: oldJ.x, y: oldJ.y, rotation: ri }; L[j] = { ...oldJ, x: old.x, y: old.y, rotation: rj }; }
    if (!legalAt(i, j) || (j >= 0 && !legalAt(j, i))) { L[i] = old; if (j >= 0) L[j] = oldJ; continue; }
    tried++;
    const parts = j >= 0 ? [i, j] : [i], nw = parts.map((k) => L[k]);
    L[i] = old; if (j >= 0) L[j] = oldJ;
    const g0 = nu ? chanOf(parts) : 0;
    L[i] = nw[0]; if (j >= 0) L[j] = nw[1];
    const g1 = nu ? chanOf(parts) : 0, c1 = decapOf(parts);
    L[i] = old; if (j >= 0) L[j] = oldJ; const c0 = decapOf(parts); L[i] = nw[0]; if (j >= 0) L[j] = nw[1];
    const A = new Set(parts.flatMap((k) => [...netsOf[k]])), oldH = [...A].map((ni) => hpN[ni]);
    let dh = 0; for (const ni of A) { const v = hp(ni); dh += (v - hpN[ni]) * wN[ni]; hpN[ni] = v; }
    const d = dh + nu * (g1 - g0) + kappa * (c1 - c0);
    const T = T0 ? T0 * Math.pow(1e-3, Math.min(1, (performance.now() - t0) / 1000 / budgetS)) : 0;
    if (d < -1e-6 || (T > 0 && rnd() < Math.exp(-d / T))) { accepted++; delta += d; for (const k of parts) { remove(k); insert(k); } }
    else { [...A].forEach((ni, k) => { hpN[ni] = oldH[k]; }); L[i] = old; if (j >= 0) L[j] = oldJ; }
  }
  return { layout: L, evals: tried, accepted, costDelta: Math.round(delta), seconds: Math.round((performance.now() - t0) / 100) / 10 };
}
