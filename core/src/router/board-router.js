// Multi-layer PathFinder router used to evaluate placements on real boards (benchmarks)
// and to show routing in the editor (web/route-worker.js).
//
// Grid model: square cells of `cell` mm on L routing layers (board.layers, default 2):
// layer 0 is the top copper, L-1 the bottom, the rest inner signal layers. Pads are the
// only obstacles: SMD pads occupy the outer layer of their footprint's side, through-hole
// pads every layer; a cell claimed by several pads goes to the nearest pad centre. A net
// may use its own pad cells and any free cell; a via between adjacent layers costs
// `viaCost` cells. Nets are grown as
// trees with A* (multi-source from the tree) and negotiated with present/history
// congestion costs until no cell is shared or `maxRounds` is reached.
import { rotateQuarter, localPin } from '../problem.js';
import { buildPlacementMasks } from '../geometry/mask.js';

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
 * Settings of the evaluation routing (the routed clean-net metric of every bench script): one track per cell of the
 * board's track pitch (trace width + clearance of its default rules, 0.4 mm when unknown) and up to 40 negotiation
 * rounds (stops when converged). The earlier metric (0.4 mm on every board, 12 rounds) was noisy: layouts that do route
 * often had not converged after 12 rounds, so the clean count changed by up to 11 nets when the layout moved by
 * 0.01-0.13 mm (PROGRESS.md, grid-shift noise). `full`: also the board's rules (routing.rules: pad clearance, net-class
 * widths, through-hole vias of their real diameter, see options.rules); slower and stricter than reality on our router
 * (human pic layout 286/310), used as the final check, while the via count of the pitch-only routing is in the layout
 * objective (bench/copilot/trajectory.mjs --via-weight). EVAL_ROUTING=legacy restores the old metric for comparisons.
 */
export function evaluationRouting(board, { full = false } = {}) {
  if (globalThis.process?.env?.EVAL_ROUTING === 'legacy') return { cell: 0.4, maxRounds: 12 };
  if (!full) return { cell: board.pitch ?? 0.4, maxRounds: 40, rules: null };
  // Full rules, calibrated on the human layouts and their real routing (bench/copilot/calibrate-router.mjs): routes the
  // human pic layout 303/310 with 322 vias (real: 304 nets connected by tracks, 322 vias) and k60 308/318 with 303 vias
  // (real: 307, 236). Pads without the half-clearance band, slower present-cost growth, stronger history, 80 rounds,
  // vias cost 10 cells (the defaults gave 286/310 and 282/318).
  return { cell: board.pitch ?? 0.4, maxRounds: 80, rules: board.rules ? { ...board.rules, padBand: 0 } : null, presentGrowth: 1.3, historyGain: 1, viaCost: 10 };
}

/**
 * @param board.canvas {width,height}
 * @param board.pads [{comp, lx, ly, w, h, rot, tht, hole, net}] pad geometry in the
 *        component body frame; rot = pad angle relative to the footprint (degrees);
 *        net = routed net index, or -1 for pads that only obstruct.
 * @param board.netCount number of routed nets
 * @param layout [{x,y,rotation,side?}]; pads are mirrored for side 1. Without a
 *        `side`, `sides` (+1 top | -1 bottom) only chooses the SMD layer.
 * @param options.cell grid cell (mm), options.maxRounds, options.onRound({round, maxRounds, overflow})
 */
export function routeBoard(board, layout, sides, options = {}) {
  const cell = options.cell ?? 0.3, viaCost = options.viaCost ?? 6, maxRounds = options.maxRounds ?? 12;
  const margin = (options.windowMargin ?? 12) * (options.footprint ?? 1);
  // options.footprint (cells, default 1): a track occupies a footprint x footprint block of cells anchored at its
  // centreline cell, so with cell = pitch / footprint (pitch = trace width + clearance) tracks keep the board's pitch on
  // a finer grid (less quantization of pad positions than one track per cell of a full pitch). Two nets conflict when
  // their blocks overlap; a block may not cover foreign pads or closed cells.
  const fp = options.footprint ?? 1;
  // options.viaRound: 'round' (default) or 'floor' for the via block size in cells (see options.rules).
  const viaSize = options.viaRound === 'floor' ? Math.floor : Math.round;
  // options.rules {trace, clearance, via, netRules?} (mm, routing.rules of src/ir/to-problem.js): pads grow by half the
  // clearance (the cells they overlap belong to the pad's net), a net's track covers a
  // k x k block with k = round((trace + clearance) / cell) of its class, and a via is a through-hole block of
  // round((via + clearance) / cell) cells on every layer. Without rules: one cell per track and per via.
  const rules = options.rules ?? null;
  const L = Math.max(2, board.layers ?? 2), BOTTOM = L - 1;
  const W = Math.ceil(board.canvas.width / cell), H = Math.ceil(board.canvas.height / cell), P = W * H, N = L * P;
  const owner = new Int32Array(N).fill(-1), ownerPad = new Int32Array(N).fill(-1), ownerDist = new Float32Array(N).fill(Infinity);
  // Outside the outline, board holes and routing keepouts are closed to every net.
  if (board.outline || board.blocked?.length) {
    // Same grid as the router (sizes forced: ceil() of the canvas could differ by a column).
    const m = buildPlacementMasks({ canvas: { width: W * cell, height: H * cell, outline: board.outline, blocked: board.blocked ?? [] }, components: [] }, { resolution: cell, gw: W, gh: H });
    // Mask side 0 -> top layer, side 1 -> bottom layer; cells blocked on both sides
    // (outline, holes, two-sided keepouts) are blocked on the inner layers too.
    const top = m.grids[m.layers.findIndex((l) => l.side === 0 && l.maxHeight === null)], bot = m.grids[m.layers.findIndex((l) => l.side === 1 && l.maxHeight === null)];
    for (let c = 0; c < P; c++) {
      if (top[c]) owner[c] = -2;
      if (bot[c]) owner[BOTTOM * P + c] = -2;
      if (top[c] && bot[c]) for (let l = 1; l < BOTTOM; l++) owner[l * P + c] = -2;
    }
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
    // Cells the pad overlaps; with rules, the pad grown by half the clearance (tracks and vias cover their width plus
    // clearance as blocks, so the other half is in their blocks; a conflict is an overlap of blocks).
    const e = rules ? rules.padBand ?? rules.clearance / 2 : 0;
    return [Math.max(0, Math.floor((cx - hx - e) / cell)), Math.max(0, Math.floor((cy - hy - e) / cell)), Math.min(W - 1, Math.floor((cx + hx + e) / cell)), Math.min(H - 1, Math.floor((cy + hy + e) / cell))];
  });
  const bottom = (c) => layout[c].side === undefined ? sides[c] < 0 : layout[c].side === 1;
  const allLayers = Array.from({ length: L }, (_, l) => l);
  const padLayers = board.pads.map((pad) => pad.tht || pad.hole ? allLayers : [bottom(pad.comp) ? BOTTOM : 0]);
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
  // options.rasterOnly: the rasterized grid without routing (src/router/global-router.js builds its coarse grid from it).
  if (options.rasterOnly) return { grid: { W, H, L, P, cell }, owner, padCells, netPads, padCenter };

  const usage = options.sharedUsage ?? new Uint16Array(N), history = options.sharedHistory ?? new Float32Array(N);
  // Blocks: k x k cells centred on the track / via cell (offsets lo..hi in x and y).
  const blocks = new Map();
  const blockOf = (k) => {
    if (!blocks.has(k)) { const lo = -((k - 1) >> 1), hi = lo + k - 1, offs = []; for (let dy = lo; dy <= hi; dy++) for (let dx = lo; dx <= hi; dx++) offs.push(dy * W + dx); blocks.set(k, { k, lo, hi, offs }); }
    return blocks.get(k);
  };
  const nr = (n) => rules?.netRules?.[n] ?? rules;
  const netBlock = Array.from({ length: board.netCount }, (_, n) => blockOf(rules ? Math.max(1, Math.round((nr(n).trace + nr(n).clearance) / cell)) : fp));
  const netVia = Array.from({ length: board.netCount }, (_, n) => blockOf(rules && nr(n).via ? Math.max(1, viaSize((nr(n).via + nr(n).clearance) / cell)) : netBlock[n].k));
  // Per via block size and column (x, y): -1 if the block is free on every layer, the net if only that net's pads are
  // in it, -2 otherwise (closed cells, other nets' pads, or the block leaves the grid).
  const viaCols = new Map();
  const viaColOf = (b) => {
    if (viaCols.has(b.k)) return viaCols.get(b.k);
    const col = new Int32Array(P).fill(-1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const q = y * W + x;
      if (x + b.lo < 0 || x + b.hi >= W || y + b.lo < 0 || y + b.hi >= H) { col[q] = -2; continue; }
      let v = -1;
      for (let l = 0; l < L && v !== -2; l++) for (const o of b.offs) { const w = owner[l * P + q + o]; if (w === -1) continue; if (w < 0 || (v !== -1 && v !== w)) { v = -2; break; } v = w; }
      col[q] = v;
    }
    viaCols.set(b.k, col);
    return col;
  };
  const g = new Float64Array(N), gen = new Int32Array(N), from = new Int32Array(N), mark = new Int32Array(N);
  let curGen = 0, markGen = 0;
  const heap = new MinHeap(1 << 16);
  const AW = options.astarWeight ?? 1;
  // Negotiation (PathFinder): present-congestion factor, its growth per round, history cost added per round of overuse.
  let pres = options.presentFactor ?? 0.6;
  const presentGrowth = options.presentGrowth ?? 1.6, historyGain = options.historyGain ?? 0.4;
  const stats = options.stats ?? null;
  if (stats) Object.assign(stats, { searches: 0, pops: 0, windowCells: 0, cells: N });

  // A* from `sources` to any cell marked `targetMark`, inside the window.
  function search(net, sources, targetMark, tx, ty, win) {
    curGen++;
    options.onWindow?.(win);
    // options.stats: counters for profiling (searches, cells popped, window cells).
    if (stats) { stats.searches++; stats.windowCells += (win[2] - win[0] + 1) * (win[3] - win[1] + 1) * L; }
    heap.n = 0;
    const [wx0, wy0, wx1, wy1] = win;
    for (const s of sources) { gen[s] = curGen; g[s] = 0; from[s] = -1; const q = s % P; heap.push(AW * (Math.abs(q % W - tx) + Math.abs(((q / W) | 0) - ty)), s); }
    // The six neighbours are expanded in a fixed order without a closure per popped cell (the closure version spent
    // most of the routing time allocating and calling it); results are identical.
    const nb = new Int32Array(6), nx = new Int32Array(6), ny = new Int32Array(6), nbase = new Float64Array(6);
    const tb = netBlock[net], vb = netVia[net], vcol = vb.k > 1 || tb.k > 1 ? viaColOf(vb) : null;
    while (heap.n) {
      const c = heap.pop();
      if (stats) stats.pops++;
      if (mark[c] === targetMark) return c;
      const gc = g[c], l = (c / P) | 0, q = c - l * P, x = q % W, y = (q / W) | 0;
      let k = 0;
      if (x > wx0) { nb[k] = c - 1; nx[k] = x - 1; ny[k] = y; nbase[k++] = 1; }
      if (x < wx1) { nb[k] = c + 1; nx[k] = x + 1; ny[k] = y; nbase[k++] = 1; }
      if (y > wy0) { nb[k] = c - W; nx[k] = x; ny[k] = y - 1; nbase[k++] = 1; }
      if (y < wy1) { nb[k] = c + W; nx[k] = x; ny[k] = y + 1; nbase[k++] = 1; }
      const planar = k;
      if (l > 0) { nb[k] = c - P; nx[k] = x; ny[k] = y; nbase[k++] = viaCost * tb.k; }
      if (l < BOTTOM) { nb[k] = c + P; nx[k] = x; ny[k] = y; nbase[k++] = viaCost * tb.k; }
      for (let j = 0; j < k; j++) {
        const n = nb[j], o = owner[n];
        if (o !== -1 && o !== net) continue;
        let use = usage[n], hist = history[n];
        if (j >= planar && vcol) {
          // Via: its block must be free (or this net's pads) on every layer; cost from the two layers it joins.
          const v = vcol[q];
          if (v !== -1 && v !== net) continue;
          for (const off of vb.offs) { const a = c + off, b2 = n + off; use += usage[a] + usage[b2]; if (history[a] > hist) hist = history[a]; if (history[b2] > hist) hist = history[b2]; }
        } else if (j < planar && tb.k > 1) {
          if (nx[j] + tb.lo < 0 || nx[j] + tb.hi >= W || ny[j] + tb.lo < 0 || ny[j] + tb.hi >= H) continue;
          let ok = true;
          for (const off of tb.offs) { if (off === 0) continue; const m = n + off, om = owner[m]; if (om !== -1 && om !== net) { ok = false; break; } use += usage[m]; if (history[m] > hist) hist = history[m]; }
          if (!ok) continue;
        }
        const ng = gc + nbase[j] * (1 + hist) * (1 + pres * use);
        if (gen[n] === curGen && g[n] <= ng) continue;
        gen[n] = curGen; g[n] = ng; from[n] = c;
        heap.push(AW === 1 ? ng + Math.abs(nx[j] - tx) + Math.abs(ny[j] - ty) : ng + AW * (Math.abs(nx[j] - tx) + Math.abs(ny[j] - ty)), n);
      }
    }
    return -1;
  }

  function routeNet(net) {
    const pads = netPads[net];
    if (pads.length < 2) return { complete: true, cells: [], paths: [] };
    const cells = [], paths = [], taken = new Set();
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
      const tb = netBlock[net], vb = netVia[net], take = (m) => { if (owner[m] === -1 && !taken.has(m)) { taken.add(m); cells.push(m); } };
      path.forEach((c, k) => {
        if (inTree.has(c)) return;
        inTree.add(c);
        if (tb.k === 1) take(c); else for (const off of tb.offs) take(c + off);
        // A layer change: the via's block on every layer.
        if (k > 0 && Math.abs(c - path[k - 1]) === P && (vb.k > 1 || tb.k > 1)) { const q = c % P; for (let l = 0; l < L; l++) for (const off of vb.offs) take(l * P + q + off); }
      });
      for (const c of padCells[target]) inTree.add(c);
      connected.push(target);
    }
    return { complete, cells, paths };
  }

  if (options.exposeRouter) return { routeNet, usage, history, setPres: (v) => { pres = v; }, pres, presentGrowth, historyGain, grid: { W, H, L, P, N, cell }, netPads, padCenter, netBlock, netVia, margin };
  const routes = new Array(board.netCount).fill(null);
  const order = [...Array(board.netCount).keys()].filter((n) => netPads[n].length >= 2);
  // Short nets first; later rounds keep the same order (PathFinder negotiates via costs).
  const span = (n) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of netPads[n]) { const [x, y] = padCenter[p]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 - x0 + y1 - y0; };
  order.sort((a, b) => span(a) - span(b));
  let rounds = 0, overflow = 0, prevOverflow = Infinity, fullRound = true;
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    if (options.jacobi) {
      // Jacobi negotiation (options.jacobi): every net is routed against the other nets' routes of the previous round
      // (its own old route taken out while it searches), and usage is rebuilt once all nets are done. Nets of one round
      // no longer depend on each other, so they can be routed in parallel (the default, Gauss-Seidel, lets each net see
      // the routes of the nets before it in the same round).
      const next = new Array(board.netCount).fill(null);
      for (const n of order) {
        if (routes[n]) for (const c of routes[n].cells) usage[c]--;
        next[n] = routeNet(n);
        if (routes[n]) for (const c of routes[n].cells) usage[c]++;
      }
      usage.fill(0);
      for (const n of order) { routes[n] = next[n]; for (const c of routes[n].cells) usage[c]++; }
    } else for (const n of order) {
      // options.incremental: after the first round only nets that are incomplete or use an overflowing cell are ripped
      // up and rerouted (the others keep their routes), as in incremental PathFinder variants.
      // A round whose overflow did not drop is followed by a full round (every net rerouted), so conflicts between
      // nets that keep their routes can still be resolved (incremental alone left ppc-n3 at 1605/1607).
      if (options.incremental && !fullRound && routes[n] && routes[n].complete && !routes[n].cells.some((c) => usage[c] > 1)) continue;
      if (routes[n]) for (const c of routes[n].cells) usage[c]--;
      routes[n] = routeNet(n);
      for (const c of routes[n].cells) usage[c]++;
    }
    overflow = 0;
    for (let c = 0; c < N; c++) if (usage[c] > 1) { overflow++; history[c] += historyGain * (usage[c] - 1); }
    options.onRound?.({ round: rounds, maxRounds, overflow });
    if (options.deadline && performance.now() > options.deadline) break;
    if (!overflow) break;
    fullRound = overflow >= prevOverflow; prevOverflow = overflow;
    pres *= presentGrowth;
  }

  let clean = 0, complete = 0, vias = 0, length = 0, viaSites = 0;
  // Per net: 0 = nothing to route, 1 = clean, 2 = complete but sharing cells, 3 = incomplete.
  const status = new Uint8Array(board.netCount);
  // Optional observation only: count the exact same path transitions as the total,
  // including one-cell segments that disappear from rendered polylines.
  const netStats = options.diagnostics ? Array.from({ length: board.netCount }, () => ({ vias: 0, lengthMm: 0, viaPoints: [] })) : null;
  for (const n of order) {
    const r = routes[n];
    const isClean = r.complete && r.cells.every((c) => usage[c] <= 1);
    status[n] = isClean ? 1 : r.complete ? 2 : 3;
    if (r.complete) complete++;
    if (isClean) clean++;
    for (const path of r.paths) for (let k = 1; k < path.length; k++) {
      if (Math.abs(path[k] - path[k - 1]) === P) {
        vias++;
        if (!(k > 1 && Math.abs(path[k - 1] - path[k - 2]) === P)) viaSites++;
        if (netStats) {
          const q = path[k] % P;
          netStats[n].vias++;
          netStats[n].viaPoints.push([(q % W + .5) * cell, (((q / W) | 0) + .5) * cell]);
        }
      } else { length += cell; if (netStats) netStats[n].lengthMm += cell; }
    }
  }
  return {
    grid: { W, H, cell, layers: L }, rounds, overflow, nets: order.length, complete, clean, vias, viaSites, length, status,
    ...(netStats ? { netStats } : {}),
    /**
     * Polylines per net as [{layer, points:[[x,y],...], via?}] in mm; `via` marks a
     * polyline that starts where the path changed layer.
     */
    polylines: () => routes.map((r) => r ? r.paths.flatMap((path) => {
      const out = []; let cur = null;
      for (const c of path) {
        const l = (c / P) | 0, q = c - l * P, pt = [(q % W + .5) * cell, (((q / W) | 0) + .5) * cell];
        if (!cur || cur.layer !== l) { if (cur && cur.points.length > 1) out.push(cur); cur = { layer: l, points: [pt], ...(cur ? { via: true } : {}) }; } else cur.points.push(pt);
      }
      if (cur && cur.points.length > 1) out.push(cur);
      return out;
    }) : []),
  };
}
