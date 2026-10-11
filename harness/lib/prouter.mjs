// Parallel PathFinder with the exact result of the sequential (Gauss-Seidel) board router.
//
// A net's A* only reads usage inside its search windows. Consecutive nets (router order) whose
// predicted windows do not overlap form a wave; workers route a wave at once against the shared
// usage (with all wave members' old routes removed). Results are then applied in router order:
// a net is accepted only if no cell whose usage differs between the wave state and the exact
// sequential state at its turn (new routes of earlier members, old routes of later members, ...)
// lies in the area it actually explored; otherwise it is rerouted on the main thread in the
// exact sequential state. The round loop (incremental rip-up, history, present-cost growth,
// stop rules) and the final statistics copy src/router/board-router.js.
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { routeBoard } from '../../core/src/router/board-router.js';

const WORKER = new URL('./route-worker.mjs', import.meta.url);

export async function routeBoardParallel(board, layout, sides, options = {}, { threads = Number(process.env.ROUTE_THREADS ?? Math.max(2, Math.min(8, os.cpus().length - 2))), stats = null, block = 0 } = {}) {
  // block > 0: approximate mode. Consecutive blocks of `block` nets are routed in parallel
  // without seeing each other and accepted without verification (not identical to sequential).
  const cell = options.cell ?? 0.3, L = Math.max(2, board.layers ?? 2), W = Math.ceil(board.canvas.width / cell), H = Math.ceil(board.canvas.height / cell), P = W * H, N = L * P;
  const usageSab = new SharedArrayBuffer(N * 2), historySab = new SharedArrayBuffer(N * 4);
  const { deadline, onRound, diagnostics, ...plain } = options;
  const R = routeBoard(board, layout, sides, { ...plain, exposeRouter: true, sharedUsage: new Uint16Array(usageSab), sharedHistory: new Float32Array(historySab) });
  const { usage, history, netPads, padCenter, netBlock, netVia, margin } = R;
  const maxRounds = options.maxRounds ?? 12;
  let pres = R.pres;

  const workers = await Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { board, layout, sides, options: plain, usageSab, historySab } });
    w.pending = null;
    w.on('error', (e) => { if (w.pending) w.pending.reject(e); else reject(e); });
    w.once('message', () => resolve(w));
  })));
  const ask = (w, msg) => new Promise((resolve, reject) => { w.pending = { reject }; w.once('message', (m) => { w.pending = null; resolve(m); }); w.postMessage(msg); });

  try {
    const routes = new Array(board.netCount).fill(null);
    const order = [...Array(board.netCount).keys()].filter((n) => netPads[n].length >= 2);
    const span = (n) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of netPads[n]) { const [x, y] = padCenter[p]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 - x0 + y1 - y0; };
    order.sort((a, b) => span(a) - span(b));
    // Cell halo of a net's blocks (track / via) around its search windows.
    const halo = (n) => Math.max(netBlock[n].k, netVia[n].k) + 1;
    const predicted = order.length ? new Map(order.map((n) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of netPads[n]) { const [x, y] = padCenter[p]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const e = margin + halo(n);
      return [n, [Math.floor(x0 / cell) - e, Math.floor(y0 / cell) - e, Math.floor(x1 / cell) + e, Math.floor(y1 / cell) + e]];
    })) : new Map();
    const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    const inBox = (c, box) => { const q = c % P, x = q % W, y = (q / W) | 0; return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]; };
    const counters = { waves: 0, parallel: 0, rerouted: 0 };

    // missing[c]: old-route cells of wave members not yet applied (removed in the wave state,
    // still present in the sequential state).
    const missing = new Uint16Array(N);
    let rounds = 0, overflow = 0, prevOverflow = Infinity, fullRound = true;
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      const needsRoute = (n) => !(options.incremental && !fullRound && routes[n] && routes[n].complete && !routes[n].cells.some((c) => usage[c] + missing[c] > 1));
      for (let i = 0; i < order.length;) {
        // Build a wave of consecutive nets with pairwise disjoint predicted windows.
        const wave = [], boxes = [];
        // A net that conflicts with a dispatched one stays in the wave but is routed on the main
        // thread at its turn (the apply step reroutes it in the exact sequential state).
        for (; i < order.length && wave.length < (block || threads * 16); i++) {
          const n = order[i], route = needsRoute(n);
          const local = !block && route && boxes.some((b) => overlap(b, predicted.get(n)));
          wave.push({ n, route, local });
          if (route && !local) boxes.push(predicted.get(n));
        }
        const routed = wave.filter((m) => m.route);
        for (const m of routed) if (routes[m.n]) for (const c of routes[m.n].cells) { usage[c]--; missing[c]++; }
        // Dispatch round-robin; one net alone is routed on the main thread.
        const results = new Map();
        if (routed.length > 1) {
          const parts = workers.map(() => []);
          routed.filter((m) => !m.local).forEach((m, k) => parts[k % workers.length].push(m.n));
          const replies = await Promise.all(parts.map((nets, k) => nets.length ? ask(workers[k], { pres, nets }) : { out: [] }));
          for (const r of replies) for (const o of r.out) results.set(o.n, o);
          counters.parallel += routed.filter((m) => !m.local).length;
        }
        counters.waves++;
        // Apply in router order, checking each result against the exact sequential state.
        const dirty = [];                      // cells whose usage differs from the wave state
        const laterOld = (k) => wave.slice(k + 1).filter((m) => m.route && routes[m.n]).map((m) => routes[m.n].cells);
        wave.forEach((m, k) => {
          const n = m.n, removed = m.route;
          const route = needsRoute(n);
          if (removed && routes[n]) for (const c of routes[n].cells) missing[c]--;
          if (!route) {
            if (removed && routes[n]) { for (const c of routes[n].cells) usage[c]++; dirty.push(routes[n].cells); }
            return;
          }
          const res = results.get(n);
          const box = res?.box && [res.box[0] - halo(n), res.box[1] - halo(n), res.box[2] + halo(n), res.box[3] + halo(n)];
          const clean = res && box && block ? true : res && box && !dirty.some((cs) => cs.some((c) => inBox(c, box))) && !laterOld(k).some((cs) => cs.some((c) => inBox(c, box)));
          let r;
          if (clean) r = { complete: res.complete, cells: Array.from(res.cells), paths: res.paths.map((p) => Array.from(p)) };
          else {
            // Exact sequential state: later members' old routes back, own old route out.
            const later = laterOld(k);
            for (const cs of later) for (const c of cs) usage[c]++;
            if (!removed && routes[n]) for (const c of routes[n].cells) usage[c]--;
            R.setPres(pres); r = R.routeNet(n);
            for (const cs of later) for (const c of cs) usage[c]--;
            if (results.has(n)) counters.rerouted++; else counters.local = (counters.local ?? 0) + 1;
          }
          for (const c of r.cells) usage[c]++;
          dirty.push(r.cells);
          routes[n] = r;
        });
      }
      overflow = 0;
      for (let c = 0; c < N; c++) if (usage[c] > 1) { overflow++; history[c] += R.historyGain * (usage[c] - 1); }
      onRound?.({ round: rounds, maxRounds, overflow });
      if (deadline && performance.now() > deadline) break;
      if (!overflow) break;
      fullRound = overflow >= prevOverflow; prevOverflow = overflow;
      pres *= R.presentGrowth;
    }
    if (stats) Object.assign(stats, counters);

    let clean = 0, complete = 0, vias = 0, length = 0;
    const status = new Uint8Array(board.netCount);
    const netStats = diagnostics ? Array.from({ length: board.netCount }, () => ({ vias: 0, lengthMm: 0, viaPoints: [] })) : null;
    for (const n of order) {
      const r = routes[n];
      const isClean = r.complete && r.cells.every((c) => usage[c] <= 1);
      status[n] = isClean ? 1 : r.complete ? 2 : 3;
      if (r.complete) complete++;
      if (isClean) clean++;
      for (const path of r.paths) for (let k = 1; k < path.length; k++) {
        if (Math.abs(path[k] - path[k - 1]) === P) {
          vias++;
          if (netStats) { const q = path[k] % P; netStats[n].vias++; netStats[n].viaPoints.push([(q % W + .5) * cell, (((q / W) | 0) + .5) * cell]); }
        } else { length += cell; if (netStats) netStats[n].lengthMm += cell; }
      }
    }
    return { grid: { W, H, cell, layers: L }, rounds, overflow, nets: order.length, complete, clean, vias, length, status, ...(netStats ? { netStats } : {}) };
  } finally { await Promise.all(workers.map((w) => w.terminate())); }
}
