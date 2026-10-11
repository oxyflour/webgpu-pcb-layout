// Supply/ground nets as placement forces. A plane net has hundreds of pins, so its HPWL
// says nothing useful; what matters is that each small part (decoupling cap, pull-up,
// filter) sits next to the IC pin it serves. withPowerEdges() turns every supply pin on
// a movable small part into a low-weight 2-pin net to the nearest IC pin of the same net
// under the given layout. Re-run it as the layout changes (the assignment is dynamic).
import { rotateQuarter, localPin } from '../src/problem.js';

export const POWER_EDGE_PREFIX = '~pwr';

/**
 * @param input problem input from designToProblem (not mutated)
 * @param power designToProblem().power
 * @param layout current layout used to pick the nearest anchor
 * @returns new problem input; anchors get one shadow pin per edge so the
 *          "one net per pin" rule of normalizeProblem holds.
 */
export function withPowerEdges(input, power, layout, { skipGround = false } = {}) {
  const components = input.components.map((c) => ({ ...c, pins: [...c.pins] }));
  const nets = [...input.nets];
  const world = (p) => { const pl = layout[p.comp], [rx, ry] = rotateQuarter(...localPin(p.x, p.y, pl.side), pl.rotation); return [pl.x + rx, pl.y + ry]; };
  let edge = 0;
  for (const net of power) {
    // Ground is usually a plane: a cap's ground pad pulled to the nearest ground pin of any IC
    // fights its supply pad's pull toward the IC it decouples.
    if (skipGround && /GND|VSS/i.test(String(net.name ?? '').split('/').pop())) continue;
    const anchors = net.pads.filter((p) => p.anchor), anchorPos = anchors.map(world);
    if (!anchors.length) continue;
    for (const p of net.pads) {
      if (p.anchor || components[p.comp].fixed) continue;
      const [x, y] = world(p);
      let best = -1, bd = Infinity;
      anchorPos.forEach(([ax, ay], k) => { if (anchors[k].comp === p.comp) return; const d = Math.abs(ax - x) + Math.abs(ay - y); if (d < bd) { bd = d; best = k; } });
      if (best < 0) continue;
      const a = anchors[best], id = `${POWER_EDGE_PREFIX}${edge++}`;
      components[p.comp].pins.push({ id: `q${p.padIndex}`, x: p.x, y: p.y });
      components[a.comp].pins.push({ id: `${id}a`, x: a.x, y: a.y });
      nets.push({ id, pins: [{ componentId: components[p.comp].id, pinId: `q${p.padIndex}` }, { componentId: components[a.comp].id, pinId: `${id}a` }] });
    }
  }
  return { ...input, components, nets };
}

export const TUCK_EDGE_PREFIX = `${POWER_EDGE_PREFIX}T`;
export const isPowerEdge = (id) => String(id).startsWith(POWER_EDGE_PREFIX);

/**
 * Tuck edges: every movable small part (<= 3 pins) gets one low-weight 2-pin net to the part
 * it shares the most signal connectivity with (nets of <= 8 pins, weight 1/(pins-1) per net;
 * ties go to the larger part). A 2-pin passive between two ICs has the same HPWL anywhere on
 * the line between them, so HPWL alone leaves it floating; humans put it next to one end.
 * Uses the shadow-net prefix of power edges, so weights and priorities match.
 */
export function withTuckEdges(input) {
  const comps = input.components.map((c) => ({ ...c, pins: [...c.pins] }));
  const idx = new Map(comps.map((c, i) => [c.id, i]));
  const adj = comps.map(() => new Map());
  for (const net of input.nets) {
    if (isPowerEdge(net.id)) continue;
    const m = [...new Set(net.pins.map((p) => idx.get(p.componentId)))];
    if (m.length < 2 || m.length > 8) continue;
    for (const a of m) for (const b of m) if (a !== b) adj[a].set(b, (adj[a].get(b) ?? 0) + 1 / (m.length - 1));
  }
  const nets = [...input.nets];
  const area = (c) => c.width * c.height;
  comps.forEach((c, i) => {
    if (c.fixed || c.pins.length > 3) return;
    let best = -1, bw = 0;
    adj[i].forEach((w, j) => { if (w > bw + 1e-9 || (Math.abs(w - bw) <= 1e-9 && best >= 0 && area(comps[j]) > area(comps[best]))) { bw = w; best = j; } });
    if (best < 0) return;
    const id = `${TUCK_EDGE_PREFIX}${i}`;
    c.pins.push({ id: `${id}s`, x: 0, y: 0 });
    comps[best].pins.push({ id: `${id}a`, x: 0, y: 0 });
    nets.push({ id, pins: [{ componentId: c.id, pinId: `${id}s` }, { componentId: comps[best].id, pinId: `${id}a` }] });
  });
  return { ...input, components: comps, nets };
}
