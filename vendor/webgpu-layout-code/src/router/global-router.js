// Coarse global router: a fast routability estimate for the interactive loop. The detailed evaluation router
// (board-router.js) negotiates every net on a 0.4 mm grid with capacity 1 per cell; on 10-layer boards one routing
// takes minutes. Here the same rasterization (pads, outline, keepouts) is grouped into global cells of k x k fine cells
// with a track capacity each (free fine cells / k, per layer), and nets are routed with the same negotiation scheme
// (rip-up and reroute, present and history costs) on that much smaller grid. A net is counted clean when none of its
// global cells is over capacity. The aim is the RANKING of candidate layouts, checked against the detailed router on
// saved layouts (bench/copilot/global-check.mjs); the detailed router stays the final check.
import { routeBoard } from './board-router.js';

class Heap {
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
    for (;;) { let c = 2 * i + 1; if (c >= this.n) break; if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++; if (this.k[c] >= key) break; this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c; }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

/**
 * @param options.gcell fine cells per global cell side (default 3: 1.2 mm with the 0.4 mm fine grid)
 * @param options.cell fine grid (mm, default 0.4, as the evaluation router), options.maxRounds (default 12)
 * @returns {{ nets, clean, complete, overflow, overflowCells, rounds, ms, grid }}
 */
export function globalRoute(board, layout, sides, options = {}) {
  const t0 = performance.now(), k = options.gcell ?? 3, maxRounds = options.maxRounds ?? 12;
  const fine = routeBoard(board, layout, sides, { cell: options.cell ?? 0.4, rasterOnly: true });
  const { W, H, L, P } = fine.grid, GW = Math.ceil(W / k), GH = Math.ceil(H / k), GP = GW * GH, GN = L * GP;
  const gOf = (c) => { const l = (c / P) | 0, q = c - l * P, x = q % W, y = (q / W) | 0; return l * GP + ((y / k) | 0) * GW + ((x / k) | 0); };
  // Capacity: free fine cells / k tracks per global cell and layer.
  const free = new Float32Array(GN);
  for (let c = 0; c < L * P; c++) if (fine.owner[c] === -1) free[gOf(c)]++;
  const cap = free.map((f) => f / k);
  // Terminals: the global cells of each pad's fine cells.
  const padG = fine.padCells.map((cells) => [...new Set(cells.map(gOf))]);
  const order = [...fine.netPads.keys()].filter((n) => fine.netPads[n].length >= 2);
  const span = (n) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of fine.netPads[n]) { const [x, y] = fine.padCenter[p]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 - x0 + y1 - y0; };
  order.sort((a, b) => span(a) - span(b));
  const usage = new Float32Array(GN), history = new Float32Array(GN), terminalOf = new Int32Array(GN).fill(-1);
  const g = new Float64Array(GN), gen = new Int32Array(GN), from = new Int32Array(GN), mark = new Int32Array(GN);
  let curGen = 0, markGen = 0, pres = options.presentFactor ?? 0.6;
  const viaCost = options.viaCost ?? 6 / k, margin = Math.ceil((options.windowMargin ?? 12) / k), heap = new Heap(1 << 14);
  const xyOf = (m) => { const q = m % GP; return [q % GW, (q / GW) | 0]; };
  function search(net, sources, tx, ty, win) {
    curGen++; heap.n = 0;
    const [wx0, wy0, wx1, wy1] = win;
    for (const s of sources) { gen[s] = curGen; g[s] = 0; from[s] = -1; const [x, y] = xyOf(s); heap.push(Math.abs(x - tx) + Math.abs(y - ty), s); }
    while (heap.n) {
      const m = heap.pop();
      if (mark[m] === markGen) return m;
      const gm = g[m], l = (m / GP) | 0, q = m - l * GP, x = q % GW, y = (q / GW) | 0;
      for (let d = 0; d < 6; d++) {
        let n, nx = x, ny = y, base = 1;
        if (d === 0) { if (x <= wx0) continue; n = m - 1; nx--; } else if (d === 1) { if (x >= wx1) continue; n = m + 1; nx++; }
        else if (d === 2) { if (y <= wy0) continue; n = m - GW; ny--; } else if (d === 3) { if (y >= wy1) continue; n = m + GW; ny++; }
        else if (d === 4) { if (l === 0) continue; n = m - GP; base = viaCost; } else { if (l === L - 1) continue; n = m + GP; base = viaCost; }
        // Cells without track capacity are closed, except the net's own terminals.
        if (cap[n] < 0.5 && terminalOf[n] !== net) continue;
        const over = Math.max(0, usage[n] + 1 - cap[n]);
        const ng = gm + base * (1 + history[n]) * (1 + pres * over);
        if (gen[n] === curGen && g[n] <= ng) continue;
        gen[n] = curGen; g[n] = ng; from[n] = m;
        heap.push(ng + Math.abs(nx - tx) + Math.abs(ny - ty), n);
      }
    }
    return -1;
  }
  function routeNet(net) {
    const pads = fine.netPads[net];
    for (const p of pads) for (const m of padG[p]) terminalOf[m] = net;
    // Pin access inside a terminal's own global cell is local (fine escape), so with options.freeTerminals those cells
    // do not take track capacity.
    const tree = new Set(padG[pads[0]]), cells = new Set(options.freeTerminals ? [] : padG[pads[0]]);
    const connected = [pads[0]], remaining = pads.slice(1);
    let complete = true;
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      remaining.forEach((p, j) => { for (const q of connected) { const d = Math.abs(fine.padCenter[p][0] - fine.padCenter[q][0]) + Math.abs(fine.padCenter[p][1] - fine.padCenter[q][1]); if (d < bd) { bd = d; bi = j; } } });
      const target = remaining.splice(bi, 1)[0];
      markGen++; for (const m of padG[target]) mark[m] = markGen;
      if (padG[target].some((m) => tree.has(m))) { connected.push(target); continue; }
      const [tx, ty] = xyOf(padG[target][0]);
      let x0 = tx, y0 = ty, x1 = tx, y1 = ty;
      for (const m of tree) { const [x, y] = xyOf(m); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      let hit = search(net, tree, tx, ty, [Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.min(GW - 1, x1 + margin), Math.min(GH - 1, y1 + margin)]);
      if (hit < 0) hit = search(net, tree, tx, ty, [0, 0, GW - 1, GH - 1]);
      if (hit < 0) { complete = false; continue; }
      for (let m = hit; m >= 0; m = from[m]) { tree.add(m); if (terminalOf[m] !== net || !options.freeTerminals) cells.add(m); }
      for (const m of padG[target]) tree.add(m);
      connected.push(target);
    }
    return { complete, cells: [...cells] };
  }
  const routes = new Array(fine.netPads.length).fill(null);
  let rounds = 0, overflow = 0, overflowCells = 0, first = null;
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    for (const n of order) {
      if (routes[n]) for (const m of routes[n].cells) usage[m]--;
      routes[n] = routeNet(n);
      for (const m of routes[n].cells) usage[m]++;
    }
    overflow = 0; overflowCells = 0;
    for (let m = 0; m < GN; m++) { const o = usage[m] - Math.max(cap[m], 1); if (o > 1e-6) { overflow += o; overflowCells++; history[m] += 0.4 * o; } }
    if (round === 0) first = { overflow, overflowCells };
    options.onRound?.({ round: rounds, overflow, overflowCells });
    if (!overflowCells) break;
    pres *= 1.6;
  }
  // Continuous congestion measures (for ranking when every net is clean on the coarse grid): squared excess of usage
  // over 70% of capacity, and wire / via cells.
  let clean = 0, complete = 0, wire = 0, hot = 0;
  for (let m = 0; m < GN; m++) { const c = Math.max(cap[m], 1), e = usage[m] - 0.7 * c; if (e > 0) hot += (e / c) ** 2; }
  for (const n of order) for (const m of routes[n].cells) wire++;
  for (const n of order) { const r = routes[n]; if (r.complete) complete++; if (r.complete && r.cells.every((m) => usage[m] <= Math.max(cap[m], 1) + 1e-6)) clean++; }
  return { nets: order.length, clean, complete, overflow: +overflow.toFixed(2), overflowCells, first, wire, hot: +hot.toFixed(2), rounds, ms: performance.now() - t0, grid: { GW, GH, L, gcellMm: k * fine.grid.cell } };
}
