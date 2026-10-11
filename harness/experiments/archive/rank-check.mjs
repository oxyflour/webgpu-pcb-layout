// Does a faster routing mode rank layouts like the reference? Score every layout with the
// reference (exact router, native build = bit-identical to JS, median of 3 grid phases, cached) and with the
// candidate mode, report Spearman rank correlation of vias / viaSites and the time per layout.
// node harness/experiments/rank-check.mjs --board ppc-n3 --mode native-layer-inc LAYOUT_FILE...
import fs from 'node:fs';
import { loadBoard, evaluateRobust } from '../../lib/board.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'ppc-n3')), mode = arg('mode'), files = argv.filter((a, i) => !a.startsWith('--') && !['--board', '--mode'].includes(argv[i - 1]));
const MODES = {
  'js-exact': {},
  'native-exact': { router: 'native' },
  'native-layer': { router: 'native', layerHeuristic: true },
  'native-layer-inc': { router: 'native', layerHeuristic: true, incremental: true },
  'js-weighted': { fast: 'weighted' },
};
const refCache = 'harness/results/rank-ref.json', ref = fs.existsSync(refCache) ? JSON.parse(fs.readFileSync(refCache, 'utf8')) : {};
const rows = [];
for (const f of files) {
  const L = f === 'human' ? b.a.originalLayout : JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!ref[f]) { const m = await evaluateRobust(b, L, { router: 'native' }); ref[f] = { clean: m.clean, vias: m.vias, viaSites: m.viaSites }; fs.writeFileSync(refCache, JSON.stringify(ref, null, 1)); }
  const t = performance.now(), m = await evaluateRobust(b, L, MODES[mode]);
  rows.push({ f: f.slice(-45), ref: ref[f], cand: { clean: m.clean, vias: m.vias, viaSites: m.viaSites }, s: +((performance.now() - t) / 1000).toFixed(1) });
  console.log(JSON.stringify(rows.at(-1)));
}
const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((a, c) => a[0] - c[0]), r = new Array(v.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
const spearman = (a, c) => { const ra = rank(a), rc = rank(c), n = a.length; return 1 - 6 * ra.reduce((s, x, i) => s + (x - rc[i]) ** 2, 0) / (n * (n * n - 1)); };
console.log(JSON.stringify({ mode, layouts: rows.length, spearmanVias: +spearman(rows.map((r) => r.ref.vias), rows.map((r) => r.cand.vias)).toFixed(3), spearmanViaSites: +spearman(rows.map((r) => r.ref.viaSites), rows.map((r) => r.cand.viaSites)).toFixed(3), spearmanRefViasVsCandSites: +spearman(rows.map((r) => r.ref.vias), rows.map((r) => r.cand.viaSites)).toFixed(3), cleanDiffMax: Math.max(...rows.map((r) => Math.abs(r.ref.clean - r.cand.clean))), meanS: +(rows.reduce((s, r) => s + r.s, 0) / rows.length).toFixed(1) }));
