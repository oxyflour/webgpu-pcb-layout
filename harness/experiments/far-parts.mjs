// Profile of the small parts the tool misplaces (> --far mm from their human position): reference
// prefix, signal pins, linked partners, and where the human / tool puts them relative to the
// partners. For parts with >= 2 partners: position along the segment between the partner with
// the fewest pins (A, t = 0) and the farthest other partner (B, t = 1), projected.
// node harness/experiments/far-parts.mjs --board k60 --layout L.json [--far 5]
import fs from 'node:fs';
import { loadBoard, legalize, worldPin } from '../lib/board.mjs';
const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, n = C.length, H = legalize(b, b.a.originalLayout).layout, far = Number(arg('far', 5));
const j = JSON.parse(fs.readFileSync(arg('layout'), 'utf8')), T = j.layout ?? j;
const partners = Array.from({ length: n }, () => new Set()), sig = new Array(n).fill(0);
for (const net of p.nets) { const cs = [...new Set(net.pins.map((pi) => p.pins[pi].componentIndex))]; if (cs.length < 2 || cs.length > 30) continue; for (const pi of net.pins) sig[p.pins[pi].componentIndex]++; for (const a of cs) for (const c of cs) if (a !== c) partners[a].add(c); }
const small = [...Array(n).keys()].filter((i) => !C[i].fixed && C[i].pins.length < 8);
const d = (L, i, M, k) => Math.hypot(L[i].x - M[k].x, L[i].y - M[k].y);
const groups = { far: [], near: [] };
for (const i of small) groups[d(T, i, H, i) > far ? 'far' : 'near'].push(i);
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
for (const [g, list] of Object.entries(groups)) {
  const prefix = {}; for (const i of list) { const k = C[i].id.replace(/[0-9_].*$/, ''); prefix[k] = (prefix[k] ?? 0) + 1; }
  const np = list.map((i) => partners[i].size), noSig = list.filter((i) => !sig[i]).length;
  const hasIc = list.filter((i) => [...partners[i]].some((k) => C[k].pins.length >= 8)).length;
  const onlySmall = list.filter((i) => partners[i].size && [...partners[i]].every((k) => C[k].pins.length < 8)).length;
  const tH = [], tT = [], span = [];
  for (const i of list) { const ps = [...partners[i]]; if (ps.length < 2) continue;
    const A = ps.reduce((a, k) => C[k].pins.length < C[a].pins.length ? k : a), B = ps.filter((k) => k !== A).reduce((a, k) => d(H, k, H, A) > d(H, a, H, A) ? k : a);
    const proj = (L) => { const ux = L[B].x - L[A].x, uy = L[B].y - L[A].y, l2 = ux * ux + uy * uy || 1; return ((L[i].x - L[A].x) * ux + (L[i].y - L[A].y) * uy) / l2; };
    tH.push(proj(H)); tT.push(proj(T)); span.push(d(H, A, H, B)); }
  const err = list.map((i) => d(T, i, H, i));
  console.log(`${g}: ${list.length} parts, error p50 ${q(err, .5).toFixed(1)} mm | prefix ${JSON.stringify(prefix)} | no signal net ${noSig} | partners p50 ${q(np, .5)} | linked to an IC/connector (>=8 pins) ${hasIc} | only small partners ${onlySmall}`);
  console.log(`   >=2 partners: ${tH.length}; partner span p50 ${q(span, .5).toFixed(1)} mm; t (0 = fewest-pin partner) human p25/p50/p75 ${[.25, .5, .75].map((f) => q(tH, f).toFixed(2)).join('/')} tool ${[.25, .5, .75].map((f) => q(tT, f).toFixed(2)).join('/')}`);
}
