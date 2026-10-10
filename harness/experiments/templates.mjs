// Placement templates learned from human layouts (leave one board out). For each small part
// (movable, < 8 signal pins, >= 1 signal pin) its parent comes from a Prim tree on the human layout:
// grown from the known parts (fixed parts, ICs = movable >= 8 signal pins), each step attaches the
// unplaced small part with the shortest human pin-to-pin link to a placed part (parent = that
// part); P = the parent's pin, Q = the own pin on that net. Frame at P: n = outward
// axis direction (P - parent centre snapped to x or y), t = n turned 90 deg. Learned per class:
//   d1 = Q - P in (n, t);  d2 = own centre - Q in (n, t).
// Class keys, finest first (backoff when < 3 samples): prefix|signal pins|pads|size|gnd|supply|
// parent big/small|net parts, then shorter prefixes of that key.
// Levels (all: human IC poses (movable, >= 8 signal pins), the rest of the board = tool init):
//   oracle      : human parent, human d1/d2 (reconstructs the human small-part poses; sanity)
//   learned     : human parent, d1/d2 = class medians from the other boards
//   learned-d2  : human parent, d1 = 0 (own pin on the parent pin), learned d2
//   tool        : tool init only (baseline)
// node harness/experiments/templates.mjs --board k60 --level learned --seed 1 --out FILE [--cypress]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, BOARDS, legalize, evaluateRobust, worldPin, needsFastRouting } from '../lib/board.mjs';
import { startLayout } from '../lib/init.mjs';
import { runCypress } from '../lib/cypress.mjs';

const GROUND = /^\/?(GND|AGND|DGND|PGND|VSS|GNDA|GNDD|EARTH|CHASSIS)/i;
const SUPPLY = /^\/?[+-]|VCC|VDD|VBAT|VIN|3V3|5V|1V8|VREF/i;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Per board: parents, frames and the class of every small part.
export function analyse(b, L = b.a.originalLayout) {
  const p = b.p, C = p.components, n = C.length;
  const sig = new Array(n).fill(0), fp = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
  const links = Array.from({ length: n }, () => []); // [ownPin, otherPin, netParts]
  for (const net of p.nets) {
    const cs = new Set(net.pins.map((pi) => p.pins[pi].componentIndex));
    if (cs.size < 2 || cs.size > 30) continue;
    for (const a of net.pins) {
      sig[p.pins[a].componentIndex]++;
      for (const c of net.pins) if (p.pins[a].componentIndex !== p.pins[c].componentIndex) links[p.pins[a].componentIndex].push([a, c, cs.size]);
    }
  }
  const small = (i) => !C[i].fixed && sig[i] > 0 && sig[i] < 8;
  const parentOf = (i, LL = L) => {
    let best = null;
    for (const [a, c, k] of links[i]) {
      const [x1, y1] = worldPin(p, LL, a), [x2, y2] = worldPin(p, LL, c), d = Math.hypot(x1 - x2, y1 - y2);
      if (!best || d < best.d) best = { a, c, k, d, j: p.pins[c].componentIndex };
    }
    return best;
  };
  const cls = (i, par) => {
    const f = fp.get(C[i].id), nets = f.pads.map((q) => q.net ?? '');
    const [w, h] = [C[i].width, C[i].height].sort((x, y) => x - y);
    return [C[i].id.replace(/[0-9_].*$/, ''), sig[i], f.pads.length, `${w.toFixed(1)}x${h.toFixed(1)}`,
      nets.some((x) => GROUND.test(x)) ? 'g' : '-', nets.some((x) => x && !GROUND.test(x) && SUPPLY.test(x)) ? 's' : '-',
      sig[par.j] >= 8 ? 'B' : 's', par.k === 2 ? '2' : par.k <= 4 ? '4' : 'm'];
  };
  // Prim tree (see header): parent link per small part, in attach order.
  const tree = () => {
    const placed = new Uint8Array(n), out = new Map(), best = new Map();
    const relax = (j) => { for (const [c, a, k] of links[j]) { const i = p.pins[a].componentIndex; if (placed[i] || !small(i)) continue;
      const [x1, y1] = worldPin(p, L, a), [x2, y2] = worldPin(p, L, c), d = Math.hypot(x1 - x2, y1 - y2);
      if (!best.has(i) || d < best.get(i).d) best.set(i, { a, c, k, d, j }); } };
    for (let i = 0; i < n; i++) if (!small(i)) { placed[i] = 1; }
    for (let i = 0; i < n; i++) if (placed[i]) relax(i);
    while (best.size) { let bi = -1, bd = Infinity; for (const [i, v] of best) if (v.d < bd) { bd = v.d; bi = i; }
      const v = best.get(bi); best.delete(bi); placed[bi] = 1; out.set(bi, v); relax(bi); }
    return out;
  };
  return { p, C, n, sig, links, small, parentOf, cls, tree };
}
// Frame at pin c of part j in layout L.
export function frame(p, L, j, c) {
  const [x, y] = worldPin(p, L, c), dx = x - L[j].x, dy = y - L[j].y;
  const nrm = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1];
  return { x, y, n: nrm, t: [-nrm[1], nrm[0]] };
}
const toFrame = (f, vx, vy) => [vx * f.n[0] + vy * f.n[1], vx * f.t[0] + vy * f.t[1]];
const fromFrame = (f, a, c) => [a * f.n[0] + c * f.t[0], a * f.n[1] + c * f.t[1]];

export function samples(b) {
  const A = analyse(b), H = b.a.originalLayout, out = [];
  for (const [i, par] of A.tree()) {
    const f = frame(A.p, H, par.j, par.c), [qx, qy] = worldPin(A.p, H, par.a);
    out.push({ key: A.cls(i, par), d1: toFrame(f, qx - f.x, qy - f.y), d2: toFrame(f, H[i].x - qx, H[i].y - qy) });
  }
  return out;
}
export function model(train) {
  const by = new Map();
  for (const s of train) for (let k = s.key.length; k >= 1; k--) { const id = s.key.slice(0, k).join('|'); if (!by.has(id)) by.set(id, []); by.get(id).push(s); }
  return (key) => {
    for (let k = key.length; k >= 1; k--) {
      const g = by.get(key.slice(0, k).join('|'));
      if (g && g.length >= 3) return { d1: [median(g.map((s) => s.d1[0])), median(g.map((s) => s.d1[1]))], d2: [median(g.map((s) => s.d2[0])), median(g.map((s) => s.d2[1]))], level: k, n: g.length };
    }
    return null;
  };
}

if (process.argv[1]?.endsWith('templates.mjs')) {
  const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  const board = arg('board'), level = arg('level', 'learned'), seed = Number(arg('seed', 1)), cypress = argv.includes('--cypress');
  const b = loadBoard(board), H = b.a.originalLayout, A = analyse(b), { p, C, n } = A;
  const plan = {};
  C.forEach((c, i) => { if (!c.fixed && A.sig[i] >= 8) plan[c.id] = { x: H[i].x, y: H[i].y, rotation: H[i].rotation }; });
  let predicted = 0; const levels = [];
  if (level !== 'tool') {
    const cache = path.resolve('harness/results/templates-train.json');
    let all = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null;
    if (!all) { all = {}; for (const nm of Object.keys(BOARDS)) all[nm] = samples(loadBoard(nm)); fs.writeFileSync(cache, JSON.stringify(all)); }
    // ppc-n1 and ppc-n3 are two versions of one design: hold both out for either.
    const predict = model(Object.entries(all).filter(([nm]) => nm !== board && !(board.startsWith('ppc') && nm.startsWith('ppc'))).flatMap(([, s]) => s));
    // Place along the human parent tree from parts with known poses (ICs, fixed parts).
    const L = C.map((c, i) => c.fixed ? { ...c.fixed } : plan[c.id] ? { ...plan[c.id], side: c.sides === 'bottom' ? 1 : 0 } : null);
    const T = A.tree(), par = [];
    for (const [i, v] of T) par[i] = v;
    {
      for (const i of T.keys()) {
        if (!L[par[i].j]) continue;
        const f = frame(p, L, par[i].j, par[i].c);
        let d1, d2;
        if (level === 'oracle') { const fh = frame(p, H, par[i].j, par[i].c), [qx, qy] = worldPin(p, H, par[i].a); d1 = toFrame(fh, qx - fh.x, qy - fh.y); d2 = toFrame(fh, H[i].x - qx, H[i].y - qy); }
        else { const m = predict(A.cls(i, par[i])); if (!m) continue; d1 = level === 'learned-d2' ? [0, 0] : m.d1; d2 = m.d2; levels.push(m.level); }
        const [ox, oy] = fromFrame(f, ...d1), qx = f.x + ox, qy = f.y + oy, [cx, cy] = fromFrame(f, ...d2);
        // Rotation: the quarter turn whose own pin sits at -d2 from the centre (best match).
        const side = C[i].sides === 'bottom' ? 1 : 0; let best = null;
        for (let r = 0; r < 4; r++) {
          if (r && C[i].rotatable === false) break;
          const T = [...L]; T[i] = { x: 0, y: 0, rotation: r, side };
          const [px, py] = worldPin(p, T, par[i].a), e = Math.hypot(px + cx, py + cy);
          if (!best || e < best.e) best = { r, e, px, py };
        }
        L[i] = { x: qx - best.px, y: qy - best.py, rotation: best.r, side };
        plan[C[i].id] = { x: L[i].x, y: L[i].y, rotation: best.r }; predicted++;
      }
    }
  }
  const init = startLayout(b, plan, { seed });
  let Lout = init, cy = null;
  if (cypress) { const r = await runCypress(b, { jobDir: path.resolve(`harness/results/templates/${board}-${level}-${seed}`), seed: 1000 + seed, init, budgetS: needsFastRouting(b) ? 80 : 150 }); cy = r.status; if (r.layout) Lout = r.layout; }
  const leg = legalize(b, Lout);
  const sm = [...Array(n).keys()].filter(A.small), dist = (L) => median(sm.map((i) => Math.hypot(L[i].x - H[i].x, L[i].y - H[i].y)));
  const within2 = sm.filter((i) => Math.hypot(leg.layout[i].x - H[i].x, leg.layout[i].y - H[i].y) <= 2).length / sm.length;
  const m = await evaluateRobust(b, leg.layout, { router: 'native', detail: true });
  const row = { board, level, cypress, cypressStatus: cy, seed, predicted, smallParts: sm.length,
    backoffLevels: levels.length ? Object.fromEntries([...new Set(levels)].sort().map((k) => [k, levels.filter((x) => x === k).length])) : null,
    startToHumanMedMm: +dist(init).toFixed(2), finalToHumanMedMm: +dist(leg.layout).toFixed(2), within2mm: +within2.toFixed(2), legalizerMoved: leg.moved,
    clean: m.clean, nets: m.nets, vias: m.vias, hpwlMm: m.hpwlMm, overflowRound1: m.margin?.overflowRound1 };
  fs.mkdirSync('harness/results/templates', { recursive: true });
  fs.writeFileSync(`harness/results/templates/${board}-${level}${cypress ? '-cy' : ''}-${seed}.json`, JSON.stringify(leg.layout));
  fs.appendFileSync(arg('out'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
}
