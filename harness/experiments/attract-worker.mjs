// Worker of attract.mjs: load the board once, then route one grid phase per message.
// message {id, layout, offset, maxRounds} -> {id, vias, clean, ovf1, cells: [[x, y] mm, ...] (round-1 overflow, grid offset removed)}
import { parentPort, workerData } from 'node:worker_threads';
import { loadBoard, shiftedRouting } from '../lib/board.mjs';
import { routeBoardNative } from '../lib/native-router.mjs';
import { evaluationRouting } from '../../core/src/router/board-router.js';

const b = loadBoard(workerData.name);
parentPort.on('message', ({ id, layout, offset, maxRounds, cells }) => {
  const sr = shiftedRouting(b, layout, 0, offset);
  const r = routeBoardNative(sr.board, sr.layout, b.a.sides, { ...evaluationRouting(sr.board), ...(maxRounds ? { maxRounds } : {}), emitOverflow: !!cells });
  const out = { id, vias: r.vias, clean: r.clean, ovf1: r.roundOverflow[0] };
  if (cells) { const W = r.grid.W, P = r.overflowCells.P, c = r.grid.cell; out.cells = r.overflowCells.round1.map((k) => { const q = k % P; return [(q % W + 0.5) * c - offset[0], (Math.floor(q / W) + 0.5) * c - offset[1]]; }); }
  parentPort.postMessage(out);
});
