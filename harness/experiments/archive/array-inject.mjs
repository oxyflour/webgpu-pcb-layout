// Key-information test (AGENTS.md): copy the human arrangement of passive arrays (findArrays) or of
// whole IC modules (buildModules) into an agent layout, relative to an anchor part, and write the
// result; evaluate it with cleanup-check.mjs next to the original. The anchor is the array's IC
// nearest to the array in the human layout (modules: the module's IC). The human offsets and
// rotations are turned by the anchor's rotation change (mirrored when the anchor is on the other side).
// node harness/experiments/array-inject.mjs --board k60 --layouts a.json,b.json --variant arrays|modules --outdir DIR
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard } from '../../lib/board.mjs';
import { findArrays, buildModules } from './lib/modules.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), variant = arg('variant', 'arrays'), outdir = arg('outdir');
const H = b.a.originalLayout, C = b.p.components;
const rotQ = (x, y, r) => [[x, y], [-y, x], [-x, -y], [y, -x]][((r % 4) + 4) % 4];

let groups;
if (variant === 'arrays') groups = findArrays(b).map((g) => {
  const cx = g.members.reduce((s, i) => s + H[i].x, 0) / g.members.length, cy = g.members.reduce((s, i) => s + H[i].y, 0) / g.members.length;
  const d = (j) => Math.hypot(H[j].x - cx, H[j].y - cy);
  return { anchor: d(g.ics[0]) <= d(g.ics[1]) ? g.ics[0] : g.ics[1], members: g.members };
});
else groups = [...buildModules(b).modules].filter(([, m]) => m.length).map(([ic, m]) => ({ anchor: ic, members: m }));

fs.mkdirSync(outdir, { recursive: true });
for (const src of arg('layouts').split(',')) {
  const j = JSON.parse(fs.readFileSync(src, 'utf8')), A = (Array.isArray(j) ? j : j.layout).map((l) => ({ ...l }));
  let moved = 0, skipped = 0, dist = 0;
  for (const g of groups) {
    const ha = H[g.anchor], aa = A[g.anchor];
    // Anchor on the other side: mirror the group in the anchor's local x (member side flips,
    // local rotation t -> -t), see worldPin: a bottom part is mirrored in local x before rotation.
    const flip = ha.side !== aa.side;
    if (flip) skipped++;
    for (const i of g.members) {
      let [ux, uy] = rotQ(H[i].x - ha.x, H[i].y - ha.y, -ha.rotation), t = H[i].rotation - ha.rotation;
      if (flip) { ux = -ux; t = -t; }
      const [x, y] = rotQ(ux, uy, aa.rotation), nx = aa.x + x, ny = aa.y + y;
      dist += Math.hypot(nx - A[i].x, ny - A[i].y); moved++;
      A[i] = { x: nx, y: ny, rotation: (((aa.rotation + t) % 4) + 4) % 4, side: flip ? 1 - H[i].side : H[i].side };
    }
  }
  const name = `${b.name}-${src.replace(/[\/:.]+/g, '_').replace(/^_+/, '').slice(-60)}-${variant}.json`;
  const file = path.join(outdir, name);
  fs.writeFileSync(file, JSON.stringify(A));
  console.log(JSON.stringify({ board: b.name, src, variant, groups: groups.length, mirroredGroups: skipped, partsMoved: moved, meanMoveMm: moved ? Math.round(dist / moved * 100) / 100 : 0, file }));
}
