// Crossing removal on a legal layout (from experiments/uncross.mjs, RESULTS.md "What in the human
// small-part poses matters"): greedy discrete moves that lower
//   cost = straight-line crossings of every signal net's spanning-tree segments + lambda * tree length (mm)
// Moves keep legality by construction: 180 deg turn of a movable 2-pin part (same body box), and
// a position swap of two movable parts with the same rotated footprint size on the same side within
// radius mm. Parts in keep (indices, e.g. the agent's plan) do not move. Signal net = >= 2 pins
// on <= 30 parts (power nets excluded). group[i] (optional): swap only parts of the same group
// (editor modules). Segments sit in a uniform grid so a move only tests nearby segments (ppc-n3,
// 2207 parts: 4 passes 22 s, 1 pass 5.5 s). Stops at deadlineMs.
// Geometry is injected (like start-layout.mjs) so the browser editor can use it too; b needs only b.p.
export const createUncross = ({ worldPin, rotatedSize }) => function uncross(b, layout, { lambda = 0.2, radius = 10, passes = 4, deadlineMs = 30000, keep = [], group = null } = {}) {
  const t0 = performance.now(), p = b.p, C = p.components, n = C.length, L = layout.map((q) => ({ ...q }));
  const nets = p.nets.map((net) => net.pins.length >= 2 && new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size <= 30 ? net.pins : null);
  const netsOf = Array.from({ length: n }, () => new Set()); nets.forEach((ps, ni) => ps && ps.forEach((pi) => netsOf[p.pins[pi].componentIndex].add(ni)));
  // Prim spanning tree of the net's pins; segment = [x1, y1, x2, y2, minx, maxx, miny, maxy]
  const netSegs = (ni) => { const ps = nets[ni], pts = ps.map((pi) => worldPin(p, L, pi)), inT = new Array(pts.length).fill(false), best = pts.map((q) => [Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]), 0]), out = [];
    inT[0] = true; for (let it = 1; it < pts.length; it++) { let u = -1; for (let k = 0; k < pts.length; k++) if (!inT[k] && (u < 0 || best[k][0] < best[u][0])) u = k;
      inT[u] = true; const a = pts[best[u][1]], c = pts[u]; out.push([a[0], a[1], c[0], c[1], Math.min(a[0], c[0]), Math.max(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[1], c[1])]);
      for (let k = 0; k < pts.length; k++) if (!inT[k]) { const d = Math.hypot(pts[k][0] - c[0], pts[k][1] - c[1]); if (d < best[k][0]) best[k] = [d, u]; } }
    return out; };
  const o = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const X = (s, t) => s[5] >= t[4] && t[5] >= s[4] && s[7] >= t[6] && t[7] >= s[6] && o(s[0], s[1], s[2], s[3], t[0], t[1]) * o(s[0], s[1], s[2], s[3], t[2], t[3]) < 0 && o(t[0], t[1], t[2], t[3], s[0], s[1]) * o(t[0], t[1], t[2], t[3], s[2], s[3]) < 0;
  // Grid: cell -> Set of nets with a segment bbox touching it.
  const G = 5, GW = Math.ceil(p.canvas.width / G) + 2, GH = Math.ceil(p.canvas.height / G) + 2, grid = Array.from({ length: GW * GH }, () => new Set());
  const cl = (v, m) => Math.max(0, Math.min(m - 1, Math.floor(v / G) + 1));
  const cellsOf = (s, f) => { for (let gy = cl(s[6], GH); gy <= cl(s[7], GH); gy++) for (let gx = cl(s[4], GW); gx <= cl(s[5], GW); gx++) f(gy * GW + gx); };
  const segs = nets.map(() => []), lens = new Float64Array(nets.length);
  const put = (ni, list) => { for (const s of segs[ni]) cellsOf(s, (c) => grid[c].delete(ni)); segs[ni] = list; lens[ni] = list.reduce((a, s) => a + Math.hypot(s[2] - s[0], s[3] - s[1]), 0); for (const s of list) cellsOf(s, (c) => grid[c].add(ni)); };
  nets.forEach((ps, ni) => ps && put(ni, netSegs(ni)));
  const near = (s) => { const out = new Set(); cellsOf(s, (c) => { for (const nj of grid[c]) out.add(nj); }); return out; };
  // Cost terms involving the net set A (pairs inside A counted once).
  const local = (A) => { let x = 0, l = 0; for (const ni of A) { l += lens[ni]; for (const s of segs[ni]) for (const nj of near(s)) { if (nj === ni || (A.has(nj) && nj < ni)) continue; for (const t of segs[nj]) if (X(s, t)) x++; } } return x + lambda * l; };
  const total = () => { let x = 0, l = 0; nets.forEach((_, ni) => { l += lens[ni]; for (const s of segs[ni]) for (const nj of near(s)) if (nj > ni) for (const t of segs[nj]) if (X(s, t)) x++; }); return { crossings: x, treeMm: Math.round(l) }; };
  const before = total();
  const kept = new Set(keep), movable = [...Array(n).keys()].filter((i) => !C[i].fixed && !kept.has(i) && netsOf[i].size);
  const size = movable.map((i) => rotatedSize(C[i], L[i].rotation).map((v) => v.toFixed(3)).join('x')), sizeOf = new Map(movable.map((i, k) => [i, size[k]]));
  const tryMove = (parts, apply, undo) => {
    const A = new Set(parts.flatMap((i) => [...netsOf[i]])), c0 = local(A), old = [...A].map((ni) => segs[ni]);
    apply(); for (const ni of A) put(ni, netSegs(ni));
    if (local(A) < c0 - 1e-6) return true;
    undo(); [...A].forEach((ni, k) => put(ni, old[k])); return false;
  };
  // Swap candidates: movable parts bucketed by footprint size and side, neighbours from a part grid.
  const late = () => performance.now() - t0 > deadlineMs;
  let flips = 0, swaps = 0, pass = 0, timedOut = false;
  outer: for (; pass < passes; pass++) {
    let changed = 0;
    for (const i of movable) if (C[i].pins.length === 2 && C[i].rotatable !== false) {
      if (late()) { timedOut = true; break outer; }
      const r = L[i].rotation; if (tryMove([i], () => L[i].rotation = (r + 2) % 4, () => L[i].rotation = r)) { flips++; changed++; }
    }
    const R = radius, cells = new Map(), key = (x, y) => `${Math.floor(x / R)},${Math.floor(y / R)}`;
    for (const i of movable) { const k = key(L[i].x, L[i].y); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
    for (const i of movable) {
      if (late()) { timedOut = true; break outer; }
      const cx = Math.floor(L[i].x / R), cy = Math.floor(L[i].y / R), cand = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of cells.get(`${cx + dx},${cy + dy}`) ?? []) cand.push(j);
      for (const j of cand) {
        if (j <= i || (group && group[i] !== group[j]) || L[i].side !== L[j].side || C[i].sides !== C[j].sides || sizeOf.get(i) !== sizeOf.get(j) || Math.hypot(L[i].x - L[j].x, L[i].y - L[j].y) > radius) continue;
        const a = { ...L[i] }, c = { ...L[j] };
        // swap positions; each keeps its own rotation (same rotated footprint size)
        if (tryMove([i, j], () => { L[i] = { ...L[i], x: c.x, y: c.y }; L[j] = { ...L[j], x: a.x, y: a.y }; }, () => { L[i] = a; L[j] = c; })) { swaps++; changed++; }
      }
    }
    if (!changed) break;
  }
  const after = total();
  return { layout: L, flips, swaps, passes: pass, timedOut, crossings: [before.crossings, after.crossings], treeMm: [before.treeMm, after.treeMm], ms: Math.round(performance.now() - t0) };
};
