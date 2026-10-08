// sweep-eval.mjs helper for boards > 1000 parts: evaluateRobust with the tool routing (3 phases),
// one row per grid phase in the why-stable output shape. node sweep-eval-big.mjs BOARD FILE|human
import fs from 'node:fs';
import { loadBoard, legalize, evaluate, toolRouting } from '../lib/board.mjs';

const [board, src] = process.argv.slice(2), b = loadBoard(board);
const L = src === 'human' ? b.a.originalLayout : legalize(b, (({ layout }) => layout)((() => { const j = JSON.parse(fs.readFileSync(src, 'utf8')); return Array.isArray(j) ? { layout: j } : j; })())).layout;
for (const k of [0, 1, 2]) {
  const m = evaluate(b, L, { ...toolRouting(b), ...(k ? { offset: [k * 0.4 / 3, k * 0.4 / 3] } : {}) });
  console.log(JSON.stringify({ clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, overflowR1: m.margin?.overflowRound1, zeroAtRound: m.margin?.roundsToZero ?? null }));
}
