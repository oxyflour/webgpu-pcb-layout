// Starting layouts for Cypress. A plan pins some movable parts to explicit poses; every
// other movable part starts at the connectivity centroid of already-positioned parts
// (fixed parts and planned parts), refined by a few Jacobi sweeps, plus a small seeded jitter
// so stacked parts are separable by Cypress's density force. Not a placer: Cypress places.
// Pure module (no Node imports): the editor worker loads it in the browser (harness/ui/server.mjs
// serves harness/lib at /harness/lib/). The geometry helpers of the adapter src/problem.js are
// passed in; lib/init.mjs binds them for Node.
export function createStartLayout({ worldPin, rotatedSize }) {
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296); }

  // mode 'pins' (default): a free part starts at the mean of the pins it connects to on
  // positioned parts (a series resistor lands next to the IC pin, not between part centres);
  // mode 'pins-small': same, weighted by 1/pin count of the neighbour;
  // mode 'centres': mean of neighbour part centres (first version, kept for comparison).
  // largeIc: small parts around ICs with >= 100 pins start by the human rules of placeNearLargeICs.
  // linkScale(i, j): factor on the pull of part j on part i in the pin modes (experiments/tree.mjs).
  function startLayout(b, plan = {}, { seed = 1, base = null, sweeps = 8, jitterMm = 1, mode = 'pins-small', largeIc = false, linkScale = null } = {}) {
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
    const sweep = (list, n) => { for (let s = 0; s < n; s++) for (const i of list) {
      let sx = 0, sy = 0, sw = 0;
      if (mode === 'pins' || mode === 'pins-small') {
        for (const { pins, w } of netsOf[i]) for (const pi of pins) {
          const j = p.pins[pi].componentIndex; if (!placed[j]) continue;
          // Free neighbours count with their centre; positioned ones with the exact pin.
          // pins-small: humans put small parts next to the partner with fewer pins (k60 median
          // 4.3 mm from it vs 15.8 mm from the larger one), so weight by 1/pin count.
          const k = (mode === 'pins-small' ? 1 / Math.max(1, p.components[j].pins.length) : 1) * (linkScale ? linkScale(i, j) : 1);
          const [x, y] = known[j] ? worldPin(p, L, pi) : [L[j].x, L[j].y], ww = (known[j] ? w : w * 0.5) * k;
          sx += ww * x; sy += ww * y; sw += ww;
        }
      } else for (const [j, w] of nbr[i]) if (placed[j]) { sx += w * L[j].x; sy += w * L[j].y; sw += w; }
      if (sw > 0) { L[i].x = sx / sw; L[i].y = sy / sw; placed[i] = 1; }
    } };
    sweep(free, sweeps);
    if (largeIc) placeNearLargeICs(b, L, new Set(free.filter((i) => placed[i])));
    // Parts without signal nets (decoupling capacitors) start beside a positioned IC that shares
    // one of their non-ground supply nets, spread over the ICs by supply-pad count, around
    // the IC outline (human practice: decaps next to the IC power pins).
    // Signal nets with > 30 parts are skipped above; such a net is a supply routed as a signal
    // (k60: +3.3V), so it counts as a supply here. Before, capacitors on it (one signal pin, the
    // other GND) had no net and stayed at the board centre (k60: ~15 within 15 mm of the MCU,
    // human ~50 mm away next to the other +3.3V ICs).
    const supply = supplyNets(b), load = new Map();
    for (const net of p.nets) {
      const comps = new Set(net.pins.map((pi) => p.pins[pi].componentIndex));
      if (comps.size > 30) for (const c of comps) supply.get(p.components[c].id)?.add(net.id);
    }
    // Pads of each part per supply net (spread decaps over the ICs by supply-pad count).
    const padsOn = new Map(b.a.ir.footprints.map((f) => [f.id, f.pads.reduce((m, q) => (q.net ? m.set(q.net, (m.get(q.net) ?? 0) + 1) : m), new Map())]));
    for (const net of p.nets) for (const pi of net.pins) { const id = p.components[p.pins[pi].componentIndex].id, m = padsOn.get(id); if (m && !m.has(net.id)) m.set(net.id, 1); }
    // Ground bridges (GND - GNDA / GNDPWR, ferrite or 0R) have no supply net: use their less common
    // ground net(s) as a supply; every part carrying a minor ground net becomes an anchor for it.
    const groundSize = new Map(); for (const f of b.a.ir.footprints) for (const n of new Set(f.pads.map((q) => q.net).filter((n) => n && GROUND.test(n.replace(/^\//, ''))))) groundSize.set(n, (groundSize.get(n) ?? 0) + 1);
    const fpById = new Map(b.a.ir.footprints.map((f) => [f.id, f]));
    const groundsOf = (id) => [...new Set((fpById.get(id)?.pads ?? []).map((q) => q.net).filter((n) => n && groundSize.has(n)))];
    for (const c of p.components) for (const n of groundsOf(c.id)) if (groundSize.get(n) < Math.max(...groundSize.values())) supply.get(c.id)?.add(n);
    const anchorBySupply = () => { for (const i of free) {
      if (placed[i]) continue;
      const nets = supply.get(p.components[i].id) ?? new Set();
      let best = -1, bestScore = Infinity;
      const pick = (ok) => p.components.forEach((c, j) => {
        if (!ok(c, j)) return;
        const shared = [...(supply.get(c.id) ?? [])].filter((n) => nets.has(n)).reduce((a, n) => a + (padsOn.get(c.id)?.get(n) ?? 1), 0);
        if (!shared) return;
        const score = (load.get(j) ?? 0) / shared;
        if (score < bestScore) { bestScore = score; best = j; }
      });
      pick((c, j) => known[j] && c.pins.length >= 8);
      // No IC on that supply (k60: 13 decaps on +5V): beside the other positioned parts carrying it
      // (regulator, connector, ...). Before, they stayed at the board centre: 18 of 23 decaps
      // within 20 mm of the MCU (human: 1), in its escape channels.
      if (best < 0) pick((c, j) => placed[j] && c.pins.length > 0);
      // Ferrite beads between two supplies carried only by capacitors: any positioned part on it.
      if (best < 0) pick((c, j) => placed[j] && j !== i);
      if (best < 0) continue;
      const k = load.get(best) ?? 0; load.set(best, k + 1);
      const [w, h] = rotatedSize(p.components[best], L[best].rotation), a = k * 2.39996; // golden-angle spread
      L[i].x = L[best].x + Math.cos(a) * (w / 2 + 1.5); L[i].y = L[best].y + Math.sin(a) * (h / 2 + 1.5); placed[i] = 1;
    } };
    anchorBySupply();
    // Chains of free parts linked only to each other (pic: C16 - TH1 - ZA1 at the 24 V input) had no
    // positioned neighbour and stayed at the board centre (1-6 parts per board, ppc 70-102). Repeat
    // the neighbour sweep and the supply anchoring for the parts still unplaced.
    for (let pass = 0; pass < 4; pass++) { const left = free.filter((i) => !placed[i]); if (!left.length) break; sweep(left, 4); anchorBySupply(); }
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
    for (const i of free) { L[i].x += (rnd() - 0.5) * 2 * jitterMm; L[i].y += (rnd() - 0.5) * 2 * jitterMm; }
    return clampAll(p, L);
  }

  // Small parts around a large IC (>= minPins signal pins, already positioned), measured on the human
  // ppc-n3/n1 layouts (results/bigic-stats.mjs; U1 462 pins):
  //   series parts (also linked to another IC or a fixed part) on the IC's side: outside the outline,
  //     median 5 mm from it, mostly on the side of the IC pin they connect to. On the other side they
  //     sit near the other partner (median 50 mm from U1): left to the pins-small start.
  //   parts linked only to the IC: outside the outline on their pin's side (median 5-8 mm); on the
  //     other board side only those on deep pins (median 6.8 mm inside the outline) sit under the IC.
  // The start layout pulled all of them to their pins (under the BGA on the bottom, 53 of 71 vs 21 in
  // the human layout) or, for series parts, toward the partner with fewer pins (median 38 mm from U1).
  // Here each such part goes to the outline side nearest its IC pin, at the pin's position along the
  // side, packed in rows just outside the outline.
  function placeNearLargeICs(b, L, free, { minPins = 100, deepMm = 5, gapMm = 1, rowGapMm = 0.3, maxNetParts = 30 } = {}) {
    const p = b.p, C = p.components, side = (i) => L[i].side ?? (C[i].sides === 'bottom' ? 1 : 0);
    const netsOf = C.map(() => []);
    for (const net of p.nets) { const cs = new Set(net.pins.map((pi) => p.pins[pi].componentIndex)); if (cs.size >= 2 && cs.size <= maxNetParts) for (const c of cs) netsOf[c].push({ net, cs }); }
    let moved = 0;
    for (let k = 0; k < C.length; k++) {
      if (free.has(k) || C[k].pins.length < minPins) continue;
      const [w, h] = rotatedSize(C[k], L[k].rotation), x0 = L[k].x - w / 2, x1 = L[k].x + w / 2, y0 = L[k].y - h / 2, y1 = L[k].y + h / 2;
      const want = [];
      for (const i of free) {
        if (C[i].pins.length >= 8 || !C[i].pins.length) continue;
        const shared = netsOf[i].filter((e) => e.cs.has(k));
        if (!shared.length) continue;
        const series = netsOf[i].some((e) => [...e.cs].some((j) => j !== k && j !== i && (C[j].fixed || C[j].pins.length >= 8)));
        const same = side(i) === side(k);
        if (series && !same) continue;
        const pin = shared[0].net.pins.find((pi) => p.pins[pi].componentIndex === k), [px, py] = worldPin(p, L, pin);
        const d = [px - x0, x1 - px, py - y0, y1 - py], depth = Math.min(...d), s = d.indexOf(depth); // 0 left, 1 right, 2 top, 3 bottom
        if (!series && !same && depth > deepMm) continue;
        want.push({ i, s, t: s < 2 ? py : px, layer: side(i) });
      }
      // Pack per (outline side, board side) in rows outside the outline, in order along the side.
      for (const s of [0, 1, 2, 3]) for (const layer of [0, 1]) {
        const group = want.filter((u) => u.s === s && u.layer === layer).sort((a, c) => a.t - c.t);
        const rows = [];
        for (const u of group) {
          const [pw, ph] = rotatedSize(C[u.i], L[u.i].rotation), along = s < 2 ? ph : pw, normal = s < 2 ? pw : ph;
          let r = 0, t = u.t;
          for (;; r++) {
            rows[r] ??= { used: [], depth: 0 };
            if (!rows[r].used.some(([a, c]) => t + along / 2 > a && t - along / 2 < c)) break;
          }
          rows[r].used.push([t - along / 2, t + along / 2]); rows[r].depth = Math.max(rows[r].depth, normal);
          let off = gapMm; for (let q = 0; q < r; q++) off += rows[q].depth + rowGapMm;
          const n = off + normal / 2;
          L[u.i].x = s === 0 ? x0 - n : s === 1 ? x1 + n : t; L[u.i].y = s === 2 ? y0 - n : s === 3 ? y1 + n : t;
          moved++;
        }
      }
    }
    return moved;
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

  const pinCount = (c) => c.pins.length;
  return { startLayout, placeNearLargeICs, pinCount };
}
