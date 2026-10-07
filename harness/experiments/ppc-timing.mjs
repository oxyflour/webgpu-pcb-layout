// Time Cypress + legalizer on a large board (ICs from human, tool init), without full routing.
import path from 'node:path';
import { loadBoard, legalize } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';
const board = process.argv[2] ?? 'ppc-n3', b = loadBoard(board), H = b.a.originalLayout, plan = {};
b.p.components.forEach((c, i) => { if (!c.fixed && c.pins.length >= 8) plan[c.id] = { x: H[i].x, y: H[i].y, rotation: H[i].rotation }; });
let t = performance.now(); const init = startLayout(b, plan, { seed: 1 }); const initS = (performance.now() - t) / 1000;
const r = await runCypress(b, { jobDir: path.resolve(`harness/results/ppc-timing/${board}`), seed: 1001, init });
t = performance.now(); const leg = legalize(b, r.layout); const legS = (performance.now() - t) / 1000;
console.log(JSON.stringify({ board, planned: Object.keys(plan).length, initS, cypress: r.status, cypressS: r.wallS, solveS: r.solveS, legalizeS: legS, legalFailed: leg.failed }));
