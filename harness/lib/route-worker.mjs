// Worker of the parallel router: builds the same router (shared usage/history arrays) and
// routes the nets it is sent, reporting each net's route and the area its searches explored.
import { parentPort, workerData } from 'node:worker_threads';
import { routeBoard } from './router-gen.mjs';

const { board, layout, sides, options, usageSab, historySab } = workerData;
let wins = null;
const R = routeBoard(board, layout, sides, { ...options, exposeRouter: true, sharedUsage: new Uint16Array(usageSab), sharedHistory: new Float32Array(historySab), onWindow: (w) => { wins.push(w); } });
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ pres, nets }) => {
  R.setPres(pres);
  const out = [];
  for (const n of nets) {
    wins = [];
    const r = R.routeNet(n);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const w of wins) { x0 = Math.min(x0, w[0]); y0 = Math.min(y0, w[1]); x1 = Math.max(x1, w[2]); y1 = Math.max(y1, w[3]); }
    out.push({ n, complete: r.complete, cells: Int32Array.from(r.cells), paths: r.paths.map((p) => Int32Array.from(p)), box: wins.length ? [x0, y0, x1, y1] : null });
  }
  parentPort.postMessage({ out });
});
