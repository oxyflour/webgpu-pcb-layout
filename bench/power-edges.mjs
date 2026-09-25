// Supply/ground nets as placement forces. A plane net has hundreds of pins, so its HPWL
// says nothing useful; what matters is that each small part (decoupling cap, pull-up,
// filter) sits next to the IC pin it serves. withPowerEdges() turns every supply pin on
// a movable small part into a low-weight 2-pin net to the nearest IC pin of the same net
// under the given layout. Re-run it as the layout changes (the assignment is dynamic).
import { rotateQuarter } from '../src/problem.js';

export const POWER_EDGE_PREFIX = '~pwr';

/**
 * @param input problem input from designToProblem (not mutated)
 * @param power designToProblem().power
 * @param layout current layout used to pick the nearest anchor
 * @returns new problem input; anchors get one shadow pin per edge so the
 *          "one net per pin" rule of normalizeProblem holds.
 */
export function withPowerEdges(input, power, layout) {
  const components = input.components.map((c) => ({ ...c, pins: [...c.pins] }));
  const nets = [...input.nets];
  const world = (p) => { const pl = layout[p.comp], [rx, ry] = rotateQuarter(p.x, p.y, pl.rotation); return [pl.x + rx, pl.y + ry]; };
  let edge = 0;
  for (const net of power) {
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

export const isPowerEdge = (id) => String(id).startsWith(POWER_EDGE_PREFIX);
