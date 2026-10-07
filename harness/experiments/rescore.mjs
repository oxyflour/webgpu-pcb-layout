// Re-score saved final layouts of agent runs with the in-tool routing of large boards
// (incremental, <= 20 rounds, weighted A* 1.5), for a like-for-like comparison with the
// standalone baseline evaluated the same way. One output file per run; existing ones are kept.
// node harness/experiments/rescore.mjs --board ppc-n3 RUN_DIR...   (RUN_DIR contains final-layout.json)
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, evaluate, legalOk } from '../lib/board.mjs';

const argv = process.argv.slice(2), board = argv[argv.indexOf('--board') + 1];
const dirs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--board');
const b = loadBoard(board);
for (const dir of dirs) {
  const outFile = path.join(dir, 'rescore-fast.json');
  if (fs.existsSync(outFile)) { console.log(`${dir}: kept existing ${outFile}`); continue; }
  const L = JSON.parse(fs.readFileSync(path.join(dir, 'final-layout.json'), 'utf8')), t0 = performance.now();
  const m = evaluate(b, L, { fast: true, deadlineS: 3600 });
  const row = { dir, board, legal: legalOk(m), routeSeconds: (performance.now() - t0) / 1000, ...m };
  fs.writeFileSync(outFile, JSON.stringify(row, null, 1));
  console.log(JSON.stringify({ dir, clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, rounds: m.routeRounds, converged: m.routeConverged, s: row.routeSeconds.toFixed(0) }));
}
