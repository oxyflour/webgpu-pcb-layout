// Worker of tool-route.mjs: route one grid phase of the (already legal) layout with evaluate().
import { parentPort, workerData } from 'node:worker_threads';
import { evaluate } from '../lib/board.mjs';
import { editorBoard } from './editor-board.mjs';

const { name, text, layout, opts } = workerData;
const { perNet, overflowBins, ...m } = evaluate(editorBoard(name, text).b, layout, { detail: true, paths: true, ...opts });
parentPort.postMessage({ ...m, status: perNet.map((n) => ({ clean: 1, overflow: 2, open: 3 })[n.status] ?? 0) });
