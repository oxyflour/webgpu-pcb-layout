// Decoupling rule: capacitors whose pads are all on supply/ground nets get no force from the
// signal netlist, so global placement leaves them wherever density puts them. Here every such
// cap is assigned to one IC supply pin of its (non-ground) supply net - pins without a cap
// first, nearest first - and moved just outside that pin. LNS and legalization then settle it.
import { rotateQuarter, localPin, rotatedSize } from '../src/problem.js';

const isGround = (name) => /GND|VSS/i.test(String(name ?? '').split('/').pop());
// Snapping to an IC may change sides only when the part is allowed on either side.
const snapSide = (component, current, preferred) => component.sides === 'any' ? (preferred ?? current ?? 0) : component.sides === 'bottom' ? 1 : 0;

export function snapDecaps(adapted, problem, layout, { gap = 0.5 } = {}) {
  const out = layout.map((p) => ({ ...p }));
  const world = (p, L = out) => { const pl = L[p.comp], [rx, ry] = rotateQuarter(...localPin(p.x, p.y, pl.side), pl.rotation); return [pl.x + rx, pl.y + ry]; };
  const W = problem.canvas.width, H = problem.canvas.height;
  let moved = 0;
  for (const net of adapted.power ?? []) {
    if (isGround(net.name)) continue;
    const pins = net.pads.filter((p) => p.anchor);
    const caps = net.pads.filter((p) => !p.anchor && /^C\d/i.test(problem.components[p.comp].id) && !problem.components[p.comp].fixed && problem.components[p.comp].pins.length === 0);
    if (!pins.length || !caps.length) continue;
    const load = new Array(pins.length).fill(0);
    // Largest-distance caps choose last, so nearby caps keep their natural pin.
    const order = caps.map((c) => { const [x, y] = world(c); return { c, x, y }; });
    for (const { c, x, y } of order) {
      let best = -1, bd = Infinity;
      pins.forEach((p, k) => {
        if (p.comp === c.comp) return;
        const [px, py] = world(p), d = Math.hypot(px - x, py - y) + 1e3 * load[k]; // fewest caps first, then nearest
        if (d < bd) { bd = d; best = k; }
      });
      if (best < 0) continue;
      load[best]++;
      const pin = pins[best], ic = out[pin.comp], [px, py] = world(pin);
      // Outward direction: from the IC centre through the pin, along the dominant axis.
      const dx = px - ic.x, dy = py - ic.y, horiz = Math.abs(dx) >= Math.abs(dy);
      const [w, h] = rotatedSize(problem.components[c.comp], out[c.comp].rotation);
      const off = (horiz ? w : h) / 2 + gap;
      const tx = horiz ? px + Math.sign(dx || 1) * off : px, ty = horiz ? py : py + Math.sign(dy || 1) * off;
      out[c.comp] = { ...out[c.comp], x: Math.min(W - w / 2, Math.max(w / 2, tx)), y: Math.min(H - h / 2, Math.max(h / 2, ty)), side: snapSide(problem.components[c.comp], out[c.comp].side, ic.side) };
      moved++;
    }
  }
  return { layout: out, moved };
}

/**
 * Crystal rule: each crystal (reference X or Y, <= 4 pins) whose small nets (<= 4 pins) reach one IC
 * (>= 8 pins) moves just outside the midpoint of that IC's crystal pins, on the IC's side;
 * the other small parts on those nets (load caps, series resistor) move next to it.
 * Returns the moved layout and the ids of the crystal nets (for a higher LNS priority).
 */
export function snapCrystals(problem, layout, { gap = 0.5 } = {}) {
  const out = layout.map((p) => ({ ...p }));
  const W = problem.canvas.width, H = problem.canvas.height, nets = [];
  const compOf = (pi) => problem.pins[pi].componentIndex;
  const pinWorld = (pi) => { const c = compOf(pi), pl = out[c], pin = problem.pins[pi], [rx, ry] = rotateQuarter(...localPin(pin.x, pin.y, pl.side), pl.rotation); return [pl.x + rx, pl.y + ry]; };
  let moved = 0;
  problem.components.forEach((c, i) => {
    if (c.fixed || !/^(X|Y)\d/i.test(c.id) || c.pins.length > 4) return;
    const small = problem.nets.filter((n) => n.pins.length <= 4 && n.pins.some((pi) => compOf(pi) === i));
    const icPins = small.flatMap((n) => n.pins.filter((pi) => problem.components[compOf(pi)].pins.length >= 8));
    if (!icPins.length) return;
    const ic = compOf(icPins[0]);
    const pts = icPins.filter((pi) => compOf(pi) === ic).map(pinWorld);
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const dx = mx - out[ic].x, dy = my - out[ic].y, horiz = Math.abs(dx) >= Math.abs(dy);
    const [w, h] = rotatedSize(c, out[i].rotation), off = (horiz ? w : h) / 2 + gap;
    const tx = horiz ? mx + Math.sign(dx || 1) * off : mx, ty = horiz ? my : my + Math.sign(dy || 1) * off;
    const place = (k, x, y) => { const [kw, kh] = rotatedSize(problem.components[k], out[k].rotation); out[k] = { ...out[k], x: Math.min(W - kw / 2, Math.max(kw / 2, x)), y: Math.min(H - kh / 2, Math.max(kh / 2, y)), side: snapSide(problem.components[k], out[k].side, out[ic].side) }; };
    place(i, tx, ty); moved++;
    // Companions: other small movable parts on the crystal nets, stacked beyond the crystal.
    const comps = [...new Set(small.flatMap((n) => n.pins.map(compOf)))].filter((k) => k !== i && k !== ic && !problem.components[k].fixed && problem.components[k].pins.length <= 3);
    comps.forEach((k, j) => {
      const along = (j - (comps.length - 1) / 2) * 1.6;
      const beyond = off + (horiz ? w : h) / 2 + 1.2;
      place(k, horiz ? mx + Math.sign(dx || 1) * beyond : mx + along, horiz ? my + along : my + Math.sign(dy || 1) * beyond);
      moved++;
    });
    nets.push(...small.map((n) => n.id));
  });
  return { layout: out, moved, nets: [...new Set(nets)] };
}
