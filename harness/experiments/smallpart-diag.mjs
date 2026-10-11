// Where do the extra vias of searched layouts sit, compared with the human layout? Per-net vias of
// the median-via phase (evaluateRobust, native exact, 5 phases), grouped by net class.
// node harness/experiments/smallpart-diag.mjs --board k60 --out FILE human L1.json L2.json ...
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust } from '../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const files = argv.filter((a, k) => !a.startsWith('--') && !(k > 0 && argv[k - 1].startsWith('--')));
const b = loadBoard(arg('board')), p = b.p, C = p.components;
const isIc = (i) => C[i].pins.length >= 8, isSmall = (i) => !C[i].fixed && C[i].pins.length < 8;
const cls = p.nets.map((net) => { const parts = [...new Set(net.pins.map((pi) => p.pins[pi].componentIndex))];
  const ic = parts.filter(isIc).length, sm = parts.filter(isSmall).length, other = parts.length - ic - sm;
  return parts.length > 30 ? 'big (>30 parts)' : ic >= 2 ? (sm ? 'IC-IC + small' : 'IC-IC') : ic === 1 ? (sm === 0 ? 'IC + other' : sm === 1 && !other ? 'IC + 1 small' : 'IC + 2+ small/other') : sm ? 'small/other only' : 'other'; });
const rows = [];
for (const f of files) {
  const L = f === 'human' ? legalize(b, b.a.originalLayout).layout : legalize(b, ((j) => j.layout ?? j)(JSON.parse(fs.readFileSync(f, "utf8")))).layout;
  const m = await evaluateRobust(b, L, { router: 'native', detail: true });
  const by = {}; m.perNet.forEach((r, ni) => { const k = cls[ni]; by[k] ??= { nets: 0, vias: 0, lenMm: 0, notClean: 0 }; by[k].nets++; by[k].vias += r.vias; by[k].lenMm += r.lengthMm; if (r.status !== 'clean') by[k].notClean++; });
  for (const v of Object.values(by)) v.lenMm = Math.round(v.lenMm);
  const row = { board: b.name, layout: f, clean: m.clean, vias: m.vias, by, perNetVias: m.perNet.map((r) => r.vias) };
  rows.push(row); fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n');
  console.log(f, m.clean, m.vias, JSON.stringify(by));
}
