// No-agent tool layouts for a sweep: start layout (centroid, empty plan) -> legalizer -> detail
// pass (30 s; 60 s on boards > 1000 parts), as `place` does without a plan. Saves
// <out>/<board>-<seed>.json for experiments/sweep-eval.mjs. Resumable (skips existing files).
// node harness/experiments/noagent.mjs --out harness/results/sweep-eval-v12/tool [--boards a,b] [--jobs 2]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, needsFastRouting } from '../lib/board.mjs';
import { startLayout } from '../lib/init.mjs';
import { detailPlace } from '../lib/detail.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const out = path.resolve(arg('out')), seeds = arg('seeds', '1000,8919,16838').split(',').map(Number);
const boards = arg('boards', 'z3r0,pico,edk,edu-fpga,fsl-mini,edu-k60,edu-nxp,safety,pic,nxp,rx,k60,acc,ppc-n3').split(',');
fs.mkdirSync(out, { recursive: true });
const tasks = boards.flatMap((board) => seeds.map((seed) => ({ board, seed }))).filter((t) => !fs.existsSync(path.join(out, `${t.board}-${t.seed}.json`)));
const worker = async () => {
  for (let t; (t = tasks.shift());) {
    const b = loadBoard(t.board), leg = legalize(b, startLayout(b, {}, { seed: t.seed }));
    const d = detailPlace(b, leg.layout, { budgetS: needsFastRouting(b) ? 60 : 30, seed: t.seed }), L = legalize(b, d.layout).layout;
    fs.writeFileSync(path.join(out, `${t.board}-${t.seed}.json`), JSON.stringify(L));
    console.log(JSON.stringify({ ...t, evals: d.evals, accepted: d.accepted, seconds: d.seconds }));
    await new Promise((r) => setImmediate(r));
  }
};
await Promise.all(Array.from({ length: Number(arg('jobs', 1)) }, worker));
