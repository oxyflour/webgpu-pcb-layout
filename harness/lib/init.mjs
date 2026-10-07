// Starting layouts for Cypress. A plan pins some movable parts to explicit poses; every
// other movable part starts at the connectivity centroid of already-positioned parts
// (fixed parts and planned parts), refined by a few Jacobi sweeps, plus a small seeded jitter
// so stacked parts are separable by Cypress's density force. Not a placer: Cypress places.
import { worldPin, rotatedSize } from './board.mjs';

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296); }

// mode 'pins' (default): a free part starts at the mean of the pins it connects to on
// positioned parts (a series resistor lands next to the IC pin, not between part centres);
// mode 'pins-small': same, weighted by 1/pin count of the neighbour;
// mode 'centres': mean of neighbour part centres (first version, kept for comparison).
export function startLayout(b, plan = {}, { seed = 1, base = null, sweeps = 8, jitterMm = 1, mode = 'pins-small' } = {}) {
  const p = b.p, n = p.components.length, rnd = rng(seed), W = p.canvas.width, H = p.canvas.height;
  const idx = new Map(p.components.map((c, i) => [c.id, i]));
  const L = p.components.map((c, i) => c.fixed ? { ...c.fixed } : base ? { ...base[i] } : { x: W / 2, y: H / 2, rotation: 0, side: c.sides === 'bottom' ? 1 : 0 });
  const known = new Uint8Array(n);
  p.components.forEach((c, i) => { if (c.fixed || base) known[i] = 1; });
  for (const [ref, q] of Object.entries(plan)) {
    const i = idx.get(ref);
    if (i === undefined) throw new Error(`plan: unknown ref ${ref}`);
    if (p.components[i].fixed) throw new Error(`plan: ${ref} is fixed`);
    if (![q.x, q.y].every(Number.isFinite)) throw new Error(`plan: ${ref} needs numeric x,y`);
    const rot = q.rotation ?? L[i].rotation ?? 0;
    if (![0, 1, 2, 3].includes(rot)) throw new Error(`plan: ${ref} rotation must be 0..3 (quarter turns)`);
    L[i] = { x: q.x, y: q.y, rotation: rot, side: p.components[i].sides === 'bottom' ? 1 : 0 };
    known[i] = 2;
  }
  if (base) return clampAll(p, L);
  // Neighbours by shared nets, weighted 1/(degree-1) like a clique model.
  const nbr = Array.from({ length: n }, () => new Map());
  for (const net of p.nets) {
    const comps = [...new Set(net.pins.map((pi) => p.pins[pi].componentIndex))];
    if (comps.length < 2 || comps.length > 30) continue;
    const w = 1 / (comps.length - 1);
    for (const a of comps) for (const c of comps) if (a !== c) nbr[a].set(c, (nbr[a].get(c) ?? 0) + w);
  }
  const free = [...Array(n).keys()].filter((i) => !known[i]);
  const placed = new Uint8Array(n); for (let i = 0; i < n; i++) placed[i] = known[i] ? 1 : 0;
  // Nets of each part, for the pin mode: [{pins of other parts}, weight].
  const netsOf = Array.from({ length: n }, () => []);
  for (const net of p.nets) {
    const comps = new Set(net.pins.map((pi) => p.pins[pi].componentIndex));
    if (comps.size < 2 || comps.size > 30) continue;
    for (const c of comps) netsOf[c].push({ pins: net.pins.filter((pi) => p.pins[pi].componentIndex !== c), w: 1 / (comps.size - 1) });
  }
  for (let s = 0; s < sweeps; s++) for (const i of free) {
    let sx = 0, sy = 0, sw = 0;
    if (mode === 'pins' || mode === 'pins-small') {
      for (const { pins, w } of netsOf[i]) for (const pi of pins) {
        const j = p.pins[pi].componentIndex; if (!placed[j]) continue;
        // Free neighbours count with their centre; positioned ones with the exact pin.
        // pins-small: humans put small parts next to the partner with fewer pins (k60 median
        // 4.3 mm from it vs 15.8 mm from the larger one), so weight by 1/pin count.
        const k = mode === 'pins-small' ? 1 / Math.max(1, p.components[j].pins.length) : 1;
        const [x, y] = known[j] ? worldPin(p, L, pi) : [L[j].x, L[j].y], ww = (known[j] ? w : w * 0.5) * k;
        sx += ww * x; sy += ww * y; sw += ww;
      }
    } else for (const [j, w] of nbr[i]) if (placed[j]) { sx += w * L[j].x; sy += w * L[j].y; sw += w; }
    if (sw > 0) { L[i].x = sx / sw; L[i].y = sy / sw; placed[i] = 1; }
  }
  // Rotation of free parts: Cypress runs with frozen orientations (see cypress.mjs), so pick
  // the quarter turn whose pins are closest to the pins they connect to (fixed, planned, or
  // the current estimate of other free parts).
  if (mode !== 'centres') for (const i of free) {
    if (!placed[i] || p.components[i].rotatable === false || !netsOf[i].length) continue;
    const myPins = p.pins.map((q, pi) => q.componentIndex === i ? pi : -1).filter((pi) => pi >= 0);
    const netOfPin = new Map();
    for (const net of p.nets) for (const pi of net.pins) if (p.pins[pi].componentIndex === i) netOfPin.set(pi, net);
    let best = L[i].rotation, bestCost = Infinity;
    for (const r of [0, 1, 2, 3]) {
      L[i].rotation = r; let cost = 0;
      for (const pi of myPins) {
        const net = netOfPin.get(pi); if (!net || net.pins.length > 30) continue;
        const [x, y] = worldPin(p, L, pi);
        for (const q of net.pins) { const j = p.pins[q].componentIndex; if (j === i || !placed[j]) continue; const [u, v] = known[j] ? worldPin(p, L, q) : [L[j].x, L[j].y]; cost += Math.abs(u - x) + Math.abs(v - y); }
      }
      if (cost < bestCost - 1e-9) { bestCost = cost; best = r; }
    }
    L[i].rotation = best;
  }
  // Parts without signal nets (decoupling capacitors) start beside a positioned IC that shares
  // one of their non-ground supply nets, spread over the ICs by supply-pad count, around
  // the IC outline (human practice: decaps next to the IC power pins).
  const supply = supplyNets(b), load = new Map();
  for (const i of free) {
    if (placed[i]) continue;
    const nets = supply.get(p.components[i].id) ?? new Set();
    let best = -1, bestScore = Infinity;
    p.components.forEach((c, j) => {
      if (!known[j] || c.pins.length < 8) return;
      const shared = [...(supply.get(c.id) ?? [])].filter((n) => nets.has(n)).length;
      if (!shared) return;
      const score = (load.get(j) ?? 0) / shared;
      if (score < bestScore) { bestScore = score; best = j; }
    });
    if (best < 0) continue;
    const k = load.get(best) ?? 0; load.set(best, k + 1);
    const [w, h] = rotatedSize(p.components[best], L[best].rotation), a = k * 2.39996; // golden-angle spread
    L[i].x = L[best].x + Math.cos(a) * (w / 2 + 1.5); L[i].y = L[best].y + Math.sin(a) * (h / 2 + 1.5); placed[i] = 1;
  }
  for (const i of free) { L[i].x += (rnd() - 0.5) * 2 * jitterMm; L[i].y += (rnd() - 0.5) * 2 * jitterMm; }
  return clampAll(p, L);
}

const GROUND = /^(GND|AGND|DGND|PGND|VSS|GNDA|GNDD|EARTH|CHASSIS)/i;
// Non-ground supply nets per part, from the footprint pads (dropped from the signal problem).
function supplyNets(b) {
  const signal = new Set(b.p.nets.map((n) => n.id)), out = new Map();
  for (const f of b.a.ir.footprints) out.set(f.id, new Set(f.pads.map((q) => q.net).filter((n) => n && !signal.has(n) && !GROUND.test(n.replace(/^\//, '')))));
  return out;
}

function clampAll(p, L) {
  p.components.forEach((c, i) => {
    if (c.fixed) return;
    const [w, h] = rotatedSize(c, L[i].rotation);
    L[i].x = Math.min(Math.max(L[i].x, w / 2), p.canvas.width - w / 2);
    L[i].y = Math.min(Math.max(L[i].y, h / 2), p.canvas.height - h / 2);
  });
  return L;
}

export const pinCount = (c) => c.pins.length;
