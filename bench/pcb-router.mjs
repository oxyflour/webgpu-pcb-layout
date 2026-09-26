// Two-layer PathFinder router used to evaluate placements on real KiCad boards.
//
// Grid model: square cells of `cell` mm on F.Cu (layer 0) and B.Cu (layer 1). Pads are
// the only obstacles: SMD pads occupy their footprint's side, through-hole pads both
// layers; a cell claimed by several pads goes to the nearest pad centre. A net may use
// its own pad cells and any free cell; vias cost `viaCost` cells. Nets are grown as
// trees with A* (multi-source from the tree) and negotiated with present/history
// congestion costs until no cell is shared or `maxRounds` is reached.
import { rotateQuarter, localPin } from '../src/problem.js';
import { buildPlacementMasks } from '../src/geometry/mask.js';

class MinHeap {
  constructor(cap = 1024) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) { const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2); k.set(this.k); v.set(this.v); this.k = k; this.v = v; }
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

/**
 * @param board.canvas {width,height}
 * @param board.pads [{comp, lx, ly, w, h, rot, tht, hole, net}] pad geometry in the
 *        component body frame; rot = pad angle relative to the footprint (degrees);
 *        net = routed net index, or -1 for pads that only obstruct.
 * @param board.netCount number of routed nets
 * @param layout [{x,y,rotation,side?}]; pads are mirrored for side 1. Without a
 *        `side`, `sides` (+1 top | -1 bottom) only chooses the SMD layer.
 */
export function routeBoard(board, layout, sides, options = {}) {
  const cell = options.cell ?? 0.3, viaCost = options.viaCost ?? 6, maxRounds = options.maxRounds ?? 12;
  const margin = options.windowMargin ?? 12;
  const W = Math.ceil(board.canvas.width / cell), H = Math.ceil(board.canvas.height / cell), P = W * H, N = 2 * P;
  const owner = new Int32Array(N).fill(-1), ownerPad = new Int32Array(N).fill(-1), ownerDist = new Float32Array(N).fill(Infinity);
  // Outside the outline, board holes and routing keepouts are closed to every net.
  if (board.outline || board.blocked?.length) {
    const m = buildPlacementMasks({ canvas: { width: W * cell, height: H * cell, outline: board.outline, blocked: board.blocked ?? [] }, components: [] }, { resolution: cell });
    m.layers.forEach((l, k) => { const g = m.grids[k]; for (let c = 0; c < P; c++) if (g[c]) owner[l.side * P + c] = -2; });
  }

  // Rasterize pads (nearest-centre wins shared cells).
  const padCenter = board.pads.map((pad) => {
    const pl = layout[pad.comp], [rx, ry] = rotateQuarter(...localPin(pad.lx, pad.ly, pl.side), pl.rotation);
    return [pl.x + rx, pl.y + ry];
  });
  const padBox = board.pads.map((pad, pi) => {
    const a = pad.rot * Math.PI / 180;
    let hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h);
    let hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h);
    if (layout[pad.comp].rotation & 1) [hx, hy] = [hy, hx];
    const [cx, cy] = padCenter[pi];
    return [Math.max(0, Math.floor((cx - hx) / cell)), Math.max(0, Math.floor((cy - hy) / cell)), Math.min(W - 1, Math.floor((cx + hx) / cell)), Math.min(H - 1, Math.floor((cy + hy) / cell))];
  });
  const bottom = (c) => layout[c].side === undefined ? sides[c] < 0 : layout[c].side === 1;
  const padLayers = board.pads.map((pad) => pad.tht || pad.hole ? [0, 1] : [bottom(pad.comp) ? 1 : 0]);
  board.pads.forEach((pad, pi) => {
    const [x0, y0, x1, y1] = padBox[pi], [cx, cy] = padCenter[pi];
    for (const l of padLayers[pi]) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const c = l * P + y * W + x, d = Math.hypot((x + .5) * cell - cx, (y + .5) * cell - cy);
      if (d < ownerDist[c]) { ownerDist[c] = d; owner[c] = pad.hole ? -2 : pad.net >= 0 ? pad.net : -2; ownerPad[c] = pi; }
    }
  });
  // Terminal cells of every routed pad; a pad that lost all its cells keeps its centre.
  const padCells = board.pads.map(() => []);
  for (let c = 0; c < N; c++) if (ownerPad[c] >= 0 && owner[c] >= 0) padCells[ownerPad[c]].push(c);
  board.pads.forEach((pad, pi) => {
    if (pad.net < 0 || pad.hole || padCells[pi].length) return;
    const [cx, cy] = padCenter[pi], x = Math.min(W - 1, Math.max(0, Math.floor(cx / cell))), y = Math.min(H - 1, Math.max(0, Math.floor(cy / cell)));
    for (const l of padLayers[pi]) { const c = l * P + y * W + x; owner[c] = pad.net; ownerPad[c] = pi; padCells[pi].push(c); }
  });
  const netPads = Array.from({ length: board.netCount }, () => []);
  board.pads.forEach((pad, pi) => { if (pad.net >= 0 && !pad.hole) netPads[pad.net].push(pi); });

  const usage = new Uint16Array(N), history = new Float32Array(N);
  const g = new Float64Array(N), gen = new Int32Array(N), from = new Int32Array(N), mark = new Int32Array(N);
  let curGen = 0, markGen = 0;
  const heap = new MinHeap(1 << 16);
  let pres = options.presentFactor ?? 0.6;

  // A* from `sources` to any cell marked `targetMark`, inside the window.
  function search(net, sources, targetMark, tx, ty, win) {
    curGen++;
    heap.n = 0;
    const [wx0, wy0, wx1, wy1] = win;
    for (const s of sources) { gen[s] = curGen; g[s] = 0; from[s] = -1; const q = s % P; heap.push(Math.abs(q % W - tx) + Math.abs(((q / W) | 0) - ty), s); }
    while (heap.n) {
      const c = heap.pop();
      if (mark[c] === targetMark) return c;
      const gc = g[c], l = c >= P ? 1 : 0, q = c - l * P, x = q % W, y = (q / W) | 0;
      const step = (n, nx, ny, base) => {
        const o = owner[n];
        if (o !== -1 && o !== net) return;
        const cost = base * (1 + history[n]) * (1 + pres * usage[n]);
        const ng = gc + cost;
        if (gen[n] === curGen && g[n] <= ng) return;
        gen[n] = curGen; g[n] = ng; from[n] = c;
        heap.push(ng + Math.abs(nx - tx) + Math.abs(ny - ty), n);
      };
      if (x > wx0) step(c - 1, x - 1, y, 1);
      if (x < wx1) step(c + 1, x + 1, y, 1);
      if (y > wy0) step(c - W, x, y - 1, 1);
      if (y < wy1) step(c + W, x, y + 1, 1);
      step(l ? c - P : c + P, x, y, viaCost);
    }
    return -1;
  }

  function routeNet(net) {
    const pads = netPads[net];
    if (pads.length < 2) return { complete: true, cells: [], paths: [] };
    const cells = [], paths = [];
    const inTree = new Set(padCells[pads[0]]);
    const connected = [pads[0]], remaining = pads.slice(1);
    let complete = true;
    while (remaining.length) {
      // Next pad: closest (by centre) to any connected pad.
      let bi = 0, bd = Infinity;
      remaining.forEach((p, k) => { for (const q of connected) { const d = Math.abs(padCenter[p][0] - padCenter[q][0]) + Math.abs(padCenter[p][1] - padCenter[q][1]); if (d < bd) { bd = d; bi = k; } } });
      const target = remaining.splice(bi, 1)[0];
      markGen++; for (const c of padCells[target]) mark[c] = markGen;
      const tx = Math.min(W - 1, Math.max(0, Math.floor(padCenter[target][0] / cell))), ty = Math.min(H - 1, Math.max(0, Math.floor(padCenter[target][1] / cell)));
      let x0 = tx, y0 = ty, x1 = tx, y1 = ty;
      for (const c of inTree) { const q = c % P, x = q % W, y = (q / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      let hit = search(net, inTree, markGen, tx, ty, [Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.min(W - 1, x1 + margin), Math.min(H - 1, y1 + margin)]);
      if (hit < 0) hit = search(net, inTree, markGen, tx, ty, [0, 0, W - 1, H - 1]);
      if (hit < 0) { complete = false; continue; }
      const path = [];
      for (let c = hit; c >= 0; c = from[c]) path.push(c);
      path.reverse(); paths.push(path);
      for (const c of path) if (!inTree.has(c)) { inTree.add(c); if (owner[c] === -1) cells.push(c); }
      for (const c of padCells[target]) inTree.add(c);
      connected.push(target);
    }
    return { complete, cells, paths };
  }

  const routes = new Array(board.netCount).fill(null);
  const order = [...Array(board.netCount).keys()].filter((n) => netPads[n].length >= 2);
  // Short nets first; later rounds keep the same order (PathFinder negotiates via costs).
  const span = (n) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of netPads[n]) { const [x, y] = padCenter[p]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 - x0 + y1 - y0; };
  order.sort((a, b) => span(a) - span(b));
  let rounds = 0, overflow = 0;
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    for (const n of order) {
      if (routes[n]) for (const c of routes[n].cells) usage[c]--;
      routes[n] = routeNet(n);
      for (const c of routes[n].cells) usage[c]++;
    }
    overflow = 0;
    for (let c = 0; c < N; c++) if (usage[c] > 1) { overflow++; history[c] += 0.4 * (usage[c] - 1); }
    if (!overflow) break;
    pres *= 1.6;
  }

  let clean = 0, complete = 0, vias = 0, length = 0;
  // Per net: 0 = nothing to route, 1 = clean, 2 = complete but sharing cells, 3 = incomplete.
  const status = new Uint8Array(board.netCount);
  for (const n of order) {
    const r = routes[n];
    const isClean = r.complete && r.cells.every((c) => usage[c] <= 1);
    status[n] = isClean ? 1 : r.complete ? 2 : 3;
    if (r.complete) complete++;
    if (isClean) clean++;
    for (const path of r.paths) for (let k = 1; k < path.length; k++) { if (Math.abs(path[k] - path[k - 1]) === P) vias++; else length += cell; }
  }
  return {
    grid: { W, H, cell }, rounds, overflow, nets: order.length, complete, clean, vias, length, status,
    /** Polylines per net as [{layer, points:[[x,y],...]}] in mm. */
    polylines: () => routes.map((r) => r ? r.paths.flatMap((path) => {
      const out = []; let cur = null;
      for (const c of path) {
        const l = c >= P ? 1 : 0, q = c - l * P, pt = [(q % W + .5) * cell, (((q / W) | 0) + .5) * cell];
        if (!cur || cur.layer !== l) { if (cur && cur.points.length > 1) out.push(cur); cur = { layer: l, points: [pt] }; } else cur.points.push(pt);
      }
      if (cur && cur.points.length > 1) out.push(cur);
      return out;
    }) : []),
  };
}
