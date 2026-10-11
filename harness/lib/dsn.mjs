// Specctra DSN export of exactly the routing problem the harness router solves (board.routing of the
// adapter: pads with their routed net or -1, outline, layer count), so FreeRouting and the harness
// PathFinder see the same pads, nets and obstacles. Every pad is written at its world position (the
// router's pad centre and axis-aligned pad box); each component is one image placed at the origin.
// Only signal nets are routed (power/ground pads have net -1 and are obstacles, as in the router).
// Coordinates: mm -> um, y negated (DSN is y-up).

import { rotateQuarter, localPin } from '../../core/src/problem.js';

const q = (s) => `"${String(s).replace(/"/g, '')}"`;
const um = (v) => Math.round(v * 1000 * 10) / 10;

export const layerNames = (L) => Array.from({ length: L }, (_, l) => l === 0 ? 'F.Cu' : l === L - 1 ? 'B.Cu' : `In${l}.Cu`);

// rules: {width, clearance, via} in mm. Default = grid-equivalent of the 0.4 mm evaluation grid
// (track pitch 0.4 mm, a via no wider than a track, as one router cell).
export function exportDsn(b, layout, { width = 0.2, clearance = 0.2, via = 0.2, viaDrill = 0.1 } = {}) {
  const r = b.a.routing, L = Math.max(2, r.layers ?? 2), names = layerNames(L), BOTTOM = L - 1;
  const bottom = (c) => layout[c].side === undefined ? b.a.sides[c] < 0 : layout[c].side === 1;
  const stacks = new Map(), images = new Map(), pins = [];
  r.pads.forEach((pad, pi) => {
    const pl = layout[pad.comp], [rx, ry] = rotateQuarter(...localPin(pad.lx, pad.ly, pl.side), pl.rotation);
    const cx = pl.x + rx, cy = pl.y + ry, a = pad.rot * Math.PI / 180;
    let hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h);
    let hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h);
    if (pl.rotation & 1) [hx, hy] = [hy, hx];
    const layers = pad.tht || pad.hole ? names : [names[bottom(pad.comp) ? BOTTOM : 0]];
    const key = `P_${um(2 * hx)}x${um(2 * hy)}_${layers.length > 1 ? 'all' : layers[0]}`;
    if (!stacks.has(key)) stacks.set(key, `  (padstack ${q(key)}\n${layers.map((l) => `    (shape (rect ${l} ${um(-hx)} ${um(-hy)} ${um(hx)} ${um(hy)}))`).join('\n')}\n    (attach off))`);
    const name = `p${pi}`;
    if (!images.has(pad.comp)) images.set(pad.comp, []);
    images.get(pad.comp).push(`    (pin ${q(key)} ${name} ${um(cx)} ${um(-cy)})`);
    pins.push({ pi, comp: pad.comp, name, net: pad.hole ? -1 : pad.net, x: cx, y: cy, hx, hy, layers });
  });
  const viaName = `Via_${um(via)}_${um(viaDrill)}`;
  stacks.set(viaName, `  (padstack ${q(viaName)}\n${names.map((l) => `    (shape (circle ${l} ${um(via)}))`).join('\n')}\n    (attach off))`);
  const comp = (c) => `c${c}`;
  const outline = r.outline ?? [{ outer: [[0, 0], [r.canvas.width, 0], [r.canvas.width, r.canvas.height], [0, r.canvas.height]] }];
  const pathOf = (pts) => [...pts, pts[0]].map(([x, y]) => `${um(x)} ${um(-y)}`).join(' ');
  const keepouts = outline.slice(1).map((o) => o.outer).concat(outline.flatMap((o) => o.holes ?? []))
    .map((h) => `    (keepout "" (polygon signal 0 ${pathOf(h)}))`);
  if (r.blocked?.length) throw new Error('dsn: blocked areas are not exported');
  const nets = Array.from({ length: r.netCount }, () => []);
  for (const p of pins) if (p.net >= 0) nets[p.net].push(`${comp(p.comp)}-${p.name}`);
  const routed = nets.map((ps, n) => ps.length >= 2 ? n : -1).filter((n) => n >= 0);
  const text = `(pcb harness
  (parser (string_quote ") (space_in_quoted_tokens on) (host_cad "cypress-harness") (host_version "1"))
  (resolution um 10)
  (unit um)
  (structure
${names.map((l, i) => `    (layer ${l} (type signal) (property (index ${i})))`).join('\n')}
    (boundary (path pcb 0 ${pathOf(outline[0].outer)}))
${keepouts.join('\n')}
    (via ${q(viaName)})
    (rule (width ${um(width)}) (clearance ${um(clearance)}))
  )
  (placement
${[...images.keys()].map((c) => `    (component ${q('img' + c)} (place ${comp(c)} 0 0 front 0))`).join('\n')}
  )
  (library
${[...images.entries()].map(([c, ps]) => `  (image ${q('img' + c)}\n${ps.join('\n')}\n  )`).join('\n')}
${[...stacks.values()].join('\n')}
  )
  (network
${routed.map((n) => `    (net N${n} (pins ${nets[n].join(' ')}))`).join('\n')}
    (class default ${routed.map((n) => `N${n}`).join(' ')}
      (circuit (use_via ${q(viaName)}))
      (rule (width ${um(width)}) (clearance ${um(clearance)})))
  )
  (wiring)
)
`;
  return { text, pins, nets: routed.length, names, rules: { width, clearance, via, viaDrill } };
}
