// Layout metrics beyond clean / vias / HPWL, for comparison with the human layout.
//
// Decoupling capacitors: capacitors (ref C*, 2 pads) with one pad on a ground net and the other on
// a supply: a power-class net, or a net that looks like one (name +..., VDD, VCC, xVy, or > 30
// parts; k60 routes +3.3V as a signal). Distance = supply pad centre to the nearest pad, on the same
// supply net, of an IC (part with >= 8 pads); capacitors whose supply reaches no IC are skipped.
// "Same IC as human" = that nearest IC is the one the human layout gives.
//
// Critical nets (signal nets): crystal = nets on a part with ref Y* / X* and <= 4 pads; clock =
// name CLK / OSC / XTAL (not crystal); reset = RST / RESET; differential pairs = two nets whose names
// differ only in the suffix _P/_N, P/N, +/-, DP/DM. Lengths: HPWL (phase-free) and, when a routing
// perNet list is given, the routed length of the router (one grid phase).
import { worldPin } from './board.mjs';

const rq = (x, y, r) => { r = ((r % 4) + 4) % 4; return r === 0 ? [x, y] : r === 1 ? [-y, x] : r === 2 ? [-x, -y] : [y, -x]; };
const supplyName = /^\+|VDD|VCC|VBAT|VBUS|VIO|^\/?\d+V\d*|\dV\d|V\d+_|_\d?V\d/i;

// Static analysis of a board: decaps, supply nets, IC pads per net, critical-net groups.
export function boardAnalysis(b) {
  const ir = b.a.ir, fps = ir.footprints, C = b.p.components, cls = Object.fromEntries(ir.nets.map((n) => [n.name, n.class]));
  const partsOn = {}; fps.forEach((f, i) => f.pads.forEach((p) => { if (p.net) (partsOn[p.net] ??= new Set()).add(i); }));
  const isGround = (n) => cls[n] === 'ground' || /^\/?(A|D|P)?GND/i.test(n ?? '');
  const isSupply = (n) => n && !isGround(n) && (cls[n] === 'power' || supplyName.test(n) || (partsOn[n]?.size ?? 0) > 30);
  const isIc = (i) => fps[i].pads.length >= 8;
  // Router pads are the footprint pads in order (routing.pads[k].padIndex).
  const RP = b.a.routing.pads, padOf = []; let k = 0; fps.forEach((f, i) => f.pads.forEach((p, j) => { padOf.push({ comp: i, pad: j, net: p.net, rp: RP[k] }); k++; }));
  if (RP.length !== padOf.length || RP.some((r, q) => r.comp !== padOf[q].comp)) throw new Error('router pads do not follow the footprint pads');
  const icPadsOn = {}; padOf.forEach((q, n) => { if (isIc(q.comp) && isSupply(q.net)) (icPadsOn[q.net] ??= []).push(n); });
  const decaps = [];
  fps.forEach((f, i) => { if (!/^C\d/i.test(f.id) || f.pads.length !== 2) return; const [a, c] = f.pads;
    const s = isGround(a.net) && isSupply(c.net) ? 1 : isGround(c.net) && isSupply(a.net) ? 0 : -1; if (s < 0) return;
    const net = f.pads[s].net; if (!icPadsOn[net]) return;
    decaps.push({ comp: i, ref: f.id, net, pad: padOf.findIndex((q) => q.comp === i && q.pad === s) }); });
  // Critical nets.
  const sig = b.p.nets.map((n) => n.id), groups = { crystal: [], clock: [], reset: [] };
  const xtal = new Set(fps.map((f, i) => /^(Y|X)\d/i.test(f.id) && f.pads.length <= 4 ? i : -1).filter((i) => i >= 0));
  sig.forEach((name, ni) => { const parts = new Set(b.p.nets[ni].pins.map((pi) => b.p.pins[pi].componentIndex));
    if ([...parts].some((i) => xtal.has(i))) groups.crystal.push(ni);
    else if (/CLK|OSC|XTAL/i.test(name)) groups.clock.push(ni);
    if (/RST|RESET/i.test(name)) groups.reset.push(ni); });
  const pairKey = (n) => { const m = n.match(/^(.*?)(_P|_N|P|N|\+|-|DP|DM)$/i); if (!m) return null; const s = m[2].toUpperCase(); return [m[1] + '|' + (s.startsWith('D') ? 'D' : s.length === 2 ? '_' : s === '+' || s === '-' ? 'pm' : ''), /P|\+/.test(s) && s !== 'DM' ? 0 : 1]; };
  const byKey = {}; sig.forEach((name, ni) => { const k2 = pairKey(name); if (k2) (byKey[k2[0]] ??= [null, null])[k2[1]] = ni; });
  const pairs = Object.values(byKey).filter((p) => p[0] != null && p[1] != null);
  return { decaps, icPadsOn, padOf, groups, pairs, sig };
}

const padCentre = (b, L, rp) => { const q = L[rp.comp], [rx, ry] = rq(q.side ? -rp.lx : rp.lx, rp.ly, q.rotation); return [q.x + rx, q.y + ry]; };
const hpwl = (b, L, ni, A) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pi of b.p.nets[ni].pins) { const [x, y] = worldPin(b.p, L, pi); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 - x0 + y1 - y0; };
const quant = (v, f) => { if (!v.length) return null; const s = [...v].sort((a, c) => a - c); return +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2); };

// Per-layout metrics. A = boardAnalysis(b); human = the human layout (for "same IC as human");
// perNet = routing perNet list (evaluate / evaluateRobust with detail: true) for routed lengths.
export function humanMetrics(b, L, A, { human = null, perNet = null } = {}) {
  const nearestIc = (Lx, d) => { const [x, y] = padCentre(b, Lx, A.padOf[d.pad].rp); let best = Infinity, comp = -1;
    for (const n of A.icPadsOn[d.net]) { const q = A.padOf[n]; if (q.comp === d.comp) continue; const [u, v] = padCentre(b, Lx, q.rp), e = Math.hypot(u - x, v - y); if (e < best) { best = e; comp = q.comp; } }
    return { dist: best, comp }; };
  const dist = [], same = [];
  for (const d of A.decaps) { const r = nearestIc(L, d); if (!isFinite(r.dist)) continue; dist.push(r.dist); if (human) same.push(nearestIc(human, d).comp === r.comp); }
  const len = (ni) => perNet ? perNet[ni].lengthMm : null;
  const group = (nets) => ({ nets: nets.length, hpwlMm: Math.round(nets.reduce((a, ni) => a + hpwl(b, L, ni), 0)), ...(perNet ? { routedMm: Math.round(nets.reduce((a, ni) => a + len(ni), 0)), vias: nets.reduce((a, ni) => a + perNet[ni].vias, 0) } : {}) });
  const mism = perNet ? A.pairs.map(([p, n]) => Math.abs(len(p) - len(n))) : [];
  return {
    decap: { count: dist.length, medianMm: quant(dist, 0.5), p90Mm: quant(dist, 0.9), within3mm: dist.length ? +(dist.filter((v) => v <= 3).length / dist.length).toFixed(2) : null, ...(human ? { sameIcAsHuman: same.length ? +(same.filter(Boolean).length / same.length).toFixed(2) : null } : {}) },
    crystal: group(A.groups.crystal), clock: group(A.groups.clock), reset: group(A.groups.reset),
    diffPairs: { pairs: A.pairs.length, ...group(A.pairs.flat()), ...(perNet ? { mismatchMedianMm: quant(mism, 0.5), mismatchMaxMm: mism.length ? +Math.max(...mism).toFixed(1) : null } : {}) },
  };
}
