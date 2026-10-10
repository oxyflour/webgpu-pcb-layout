// Which part of the human small-part pose is key information? Start from a tool layout with the
// human IC poses, give the small parts (movable, < 8 pins) parts of their human pose, legalize,
// evaluate (5 grid phases, native exact).
//   all       : human x, y, rotation                   pos : human x, y, tool rotation
//   rot       : tool x, y, human rotation              nosig / sig : all, only parts without / with signal nets
//   jit<S>    : all, x and y + uniform noise in [-S, S] mm (seeded)
//   rotjit<S> : jit<S> with the tool rotation
//   far<D> / near<D> : only parts whose tool position is > D / <= D mm from the human one
//   rotdiff   : only parts whose tool rotation differs from the human one (mod 180 deg)
//   gjit<S>   : all, one common uniform offset in [-S, S] mm per human cluster (small parts linked
//               by pins <= 3 mm apart in the human layout; a part alone is its own cluster)
//   box:x0,y0,x1,y1 : only parts whose human centre lies in that rectangle (mm)
//   ring      : only parts within 1 mm of an IC outline (same side) in the tool layout but not in the human one
// node harness/experiments/pose-ablation.mjs --board k60 --layout final-layout.json --variants all,pos,rot --seed 1 --out FILE [--save DIR]
import fs from 'node:fs';
import { loadBoard, legalize, evaluateRobust, rotatedSize, worldPin } from '../lib/board.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), p = b.p, C = p.components, H = b.a.originalLayout, src = arg('layout'), seed = Number(arg('seed', 1));
const j = JSON.parse(fs.readFileSync(src, 'utf8')), L0 = legalize(b, j.layout ?? j).layout;
const sigParts = new Set(); for (const net of p.nets) for (const pi of net.pins) sigParts.add(p.pins[pi].componentIndex);
const small = (i) => !C[i].fixed && C[i].pins.length < 8;
const dH = (i) => Math.hypot(L0[i].x - H[i].x, L0[i].y - H[i].y);
const ics = C.map((c, i) => !c.fixed && c.pins.length >= 8 ? i : -1).filter((i) => i >= 0);
const box = (L, i) => { const [w, h] = rotatedSize(C[i], L[i].rotation); return [L[i].x - w / 2, L[i].y - h / 2, L[i].x + w / 2, L[i].y + h / 2]; };
const inRing = (L, i) => ics.some((k) => { if (L[k].side !== L[i].side) return false; const a = box(L, k), c = box(L, i); return Math.max(a[0] - c[2], c[0] - a[2], a[1] - c[3], c[1] - a[3]) < 1; });
const HL = legalize(b, H).layout;
// Human clusters of small parts: union of linked small parts whose pins are <= 3 mm apart.
const cl = [...Array(C.length).keys()], find = (x) => cl[x] === x ? x : (cl[x] = find(cl[x]));
for (const net of p.nets) { const ps = net.pins.filter((pi) => small(p.pins[pi].componentIndex)); if (new Set(net.pins.map((pi) => p.pins[pi].componentIndex)).size > 30) continue;
  for (const a of ps) for (const c of ps) { const i = p.pins[a].componentIndex, k = p.pins[c].componentIndex; if (i === k) continue;
    const [x1, y1] = worldPin(p, H, a), [x2, y2] = worldPin(p, H, c); if (Math.hypot(x1 - x2, y1 - y2) <= 3) cl[find(i)] = find(k); } }
let s = seed * 2654435761 >>> 0; const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
for (const v of arg('variants', 'none,all').split(',')) {
  const jm = v.match(/^(rot|g)?jit([\d.]+)$/), S = jm ? Number(jm[2]) : 0, goff = new Map();
  const fm = v.match(/^(far|near)([\d.]+)$/);
  const pick = (i) => small(i) && (v === 'nosig' ? !sigParts.has(i) : v === 'sig' ? sigParts.has(i) : fm ? (fm[1] === 'far' ? dH(i) > Number(fm[2]) : dH(i) <= Number(fm[2]))
    : v.startsWith('box:') ? (([x0, y0, x1, y1]) => H[i].x >= x0 && H[i].x < x1 && H[i].y >= y0 && H[i].y < y1)(v.slice(4).split(';').map(Number))
    : v === 'rotdiff' ? L0[i].rotation % 2 !== H[i].rotation % 2 : v === 'ring' ? inRing(L0, i) && !inRing(HL, i) : v !== 'none');
  const L = L0.map((l, i) => {
    if (!pick(i)) return { ...l };
    if (v === 'rot') return { ...l, rotation: H[i].rotation };
    const q = { ...H[i] };
    if (v === 'pos' || jm?.[1] === 'rot') q.rotation = l.rotation;
    if (S && jm[1] === 'g') { const r = find(i); if (!goff.has(r)) goff.set(r, [(rnd() * 2 - 1) * S, (rnd() * 2 - 1) * S]); q.x += goff.get(r)[0]; q.y += goff.get(r)[1]; }
    else if (S) { q.x += (rnd() * 2 - 1) * S; q.y += (rnd() * 2 - 1) * S; }
    return q;
  });
  const leg = legalize(b, L);
  if (arg('save')) { fs.mkdirSync(arg('save'), { recursive: true }); fs.writeFileSync(`${arg('save')}/${v}-${seed}.json`, JSON.stringify(leg.layout)); }
  const m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
  const row = { board: b.name, layout: src, seed, variant: v, parts: C.filter((c, i) => pick(i)).length, rotDiff: C.filter((c, i) => small(i) && L0[i].rotation % 2 !== H[i].rotation % 2).length,
    legalizerMoved: leg.moved, clean: m.clean, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
  fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
}
