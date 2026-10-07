// Worker of evaluateRobust: load the board and route one grid phase.
import { parentPort, workerData } from 'node:worker_threads';
import { loadBoard, evaluate } from './board.mjs';

const { name, layout, opts } = workerData;
parentPort.postMessage(evaluate(loadBoard(name), layout, opts));
