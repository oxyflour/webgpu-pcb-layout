// Reverse key-information test: in the HUMAN layout, permute the parts of every passive array
// (findArrays) over the array's own slots. Slots, sizes and rotations stay (members have the same
// size), so the layout stays legal and only the order changes: the pin order the human chose to
// avoid crossings is lost. node harness/experiments/array-shuffle.mjs --board ppc-n3 --seeds 1,2,3 --outdir DIR
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard } from '../../lib/board.mjs';
import { findArrays } from './lib/modules.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), outdir = arg('outdir'), H = b.a.originalLayout, arrays = findArrays(b);
fs.mkdirSync(outdir, { recursive: true });
for (const seed of arg('seeds', '1').split(',').map(Number)) {
  let s = seed * 7919 + 1; const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  const A = H.map((l) => ({ ...l }));
  let parts = 0;
  for (const g of arrays) {
    const m = g.members, perm = [...m];
    for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    m.forEach((i, k) => { A[perm[k]] = { ...H[i] }; }); parts += m.length;
  }
  const file = path.join(outdir, `${b.name}-human-shuffle${seed}.json`);
  fs.writeFileSync(file, JSON.stringify(A));
  console.log(JSON.stringify({ board: b.name, seed, arrays: arrays.length, parts, file }));
}
