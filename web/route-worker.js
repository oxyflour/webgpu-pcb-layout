// Routing worker for web/editor.html: routes the current placement with the board router
// (CPU, seconds on larger boards). The page terminates and restarts it when the placement
// changes before a result arrives, so it never holds up editing.
import { routeBoard } from '../src/router/board-router.js';

let board = null, sides = null;

self.onmessage = ({ data: m }) => {
  if (m.type === 'init') { board = m.routing; sides = m.sides; return; }
  if (m.type !== 'route') return;
  const t0 = performance.now();
  const r = routeBoard(board, m.layout, sides, {
    cell: m.cell ?? 0.4,
    onRound: ({ round, maxRounds, overflow }) => self.postMessage({ type: 'progress', seq: m.seq, round, maxRounds, overflow, elapsedMs: performance.now() - t0 }),
  });
  // Tracks per layer as flat coordinates: polyline k of layer l spans points
  // starts[k] .. starts[k+1]-1 and belongs to net nets[k]. Vias as x, y pairs.
  const perLayer = Array.from({ length: r.grid.layers }, () => ({ coords: [], starts: [], nets: [] }));
  const vias = [];
  r.polylines().forEach((polys, net) => {
    for (const p of polys) {
      const L = perLayer[p.layer];
      L.starts.push(L.coords.length / 2); L.nets.push(net);
      for (const [x, y] of p.points) L.coords.push(x, y);
      if (p.via) vias.push(p.points[0][0], p.points[0][1]);
    }
  });
  const layers = perLayer.map((L) => ({ coords: new Float32Array(L.coords), starts: Uint32Array.from([...L.starts, L.coords.length / 2]), nets: Int32Array.from(L.nets) }));
  const viaArray = new Float32Array(vias), status = r.status;
  self.postMessage({
    type: 'result', seq: m.seq, ms: performance.now() - t0,
    stats: { nets: r.nets, clean: r.clean, complete: r.complete, vias: r.vias, length: r.length, rounds: r.rounds, overflow: r.overflow, layers: r.grid.layers, cell: r.grid.cell },
    layers, vias: viaArray, status,
  }, [...layers.flatMap((l) => [l.coords.buffer, l.starts.buffer, l.nets.buffer]), viaArray.buffer, status.buffer]);
};
