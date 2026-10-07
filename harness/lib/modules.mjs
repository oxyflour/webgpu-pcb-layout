// Modules derived from the netlist only: every movable part with >= minPins signal pins (an IC)
// seeds a module; a small movable part joins it when the IC is the only IC or fixed part it shares
// a signal net with (nets of <= maxNetParts parts). Everything else is glue for the global pass.
// Measured on the human layouts (distance from the member to the IC outline, mm):
//   ppc-n3: these members (641) median 1.3, p90 9.6; small parts that also touch another IC or a
//   fixed part median 5.0, p90 80; assignment through chains of small parts median 15, decaps by
//   shared supply net median 24 -> those rules were dropped.
export function buildModules(b, { minPins = 8, maxNetParts = 30 } = {}) {
  const p = b.p, n = p.components.length, comps = p.components;
  const isIc = comps.map((c) => !c.fixed && c.pins.length >= minPins);
  const partners = Array.from({ length: n }, () => new Set());
  for (const net of p.nets) {
    const cs = [...new Set(net.pins.map((pi) => p.pins[pi].componentIndex))];
    if (cs.length < 2 || cs.length > maxNetParts) continue;
    for (const a of cs) for (const c of cs) if (a !== c) partners[a].add(c);
  }
  const owner = new Int32Array(n).fill(-1);
  comps.forEach((c, i) => { if (isIc[i]) owner[i] = i; });
  comps.forEach((c, i) => {
    if (c.fixed || isIc[i]) return;
    const anchors = [...partners[i]].filter((j) => isIc[j] || comps[j].fixed);
    if (anchors.length === 1 && isIc[anchors[0]]) owner[i] = anchors[0];
  });
  const modules = new Map();
  comps.forEach((c, i) => { if (isIc[i]) modules.set(i, []); });
  comps.forEach((c, i) => { if (owner[i] >= 0 && owner[i] !== i) modules.get(owner[i]).push(i); });
  return { owner, modules, isIc };
}
