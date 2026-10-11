// Does weighted A* keep the ranking of candidates? Route stored candidates exactly and with w.
// node harness/experiments/astar-rank.mjs --board ppc-n3 --w 1.5 --part 0/3 --out FILE CAND_DIR...
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard } from '../../lib/board.mjs';
import { routeBoard, evaluationRouting } from '../../../core/src/router/board-router.js';
const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board', 'ppc-n3'), w = Number(arg('w', 1.5)), [k, m] = arg('part', '0/1').split('/').map(Number), out = arg('out');
const dirs = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => /^c\d+\.json$/.test(f)).map((f) => path.join(d, f))).sort().filter((_, i) => i % m === k);
const b = loadBoard(board), rb = { ...b.a.routing, pitch: 0.4 };
for (const f of files) {
  const L = JSON.parse(fs.readFileSync(f, 'utf8')).layout, row = { file: f };
  for (const [name, aw] of [['exact', 1], ['weighted', w]]) { const t = performance.now(); const r = routeBoard(rb, L, b.a.sides, { ...evaluationRouting(rb), incremental: true, maxRounds: 20, astarWeight: aw }); row[name] = { clean: r.clean, vias: r.vias, s: +((performance.now() - t) / 1000).toFixed(1) }; }
  fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
}
