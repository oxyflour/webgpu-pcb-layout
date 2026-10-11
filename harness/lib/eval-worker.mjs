// Worker of evaluateRobust: load the board and route one grid phase.
import { parentPort, workerData } from 'node:worker_threads';
import { loadBoard, evaluate, registerBoard, BOARDS } from './board.mjs';

// file: boards registered only in the parent process (registerBoard) are registered here too.
const { name, file, layout, opts } = workerData;
if (!BOARDS[name] && file) registerBoard(name, file);
parentPort.postMessage(evaluate(loadBoard(name), layout, opts));
