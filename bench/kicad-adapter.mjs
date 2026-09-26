// KiCad adapter: .kicad_pcb -> Board IR (docs/board-ir.md) -> engine problem.
// Nets and names come from webgpu_pcb_placer's parser; footprint and pad geometry is
// re-read from the file (KiCad: y-down, rotation counter-clockwise on screen, bottom-side
// pads stored already mirrored, which kicadToIR converts back to the top view).
//
// Board sides (designToProblem options.sides):
//   'single'   every footprint on one plane (legacy; bottom parts compete with top ones)
//   'original' each footprint stays on its KiCad side
//   'free'     SMD footprints may use either side; through-hole parts keep their side
import path from 'node:path';
import { irToProblem } from '../src/ir/to-problem.js';
import { pathToFileURL } from 'node:url';

const POWER_NET = /^(A|D|P)?GND|^(VCC|VDD|VSS|VBAT|VIN|VBUS)|^\+?\d+V\d*|^\d+V\d+|3V3|1V8|2V5/i;
const NUM = String.raw`[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?`;
const AT = new RegExp(String.raw`\(at\s+(${NUM})\s+(${NUM})(?:\s+(${NUM}))?`);
const SIZE = new RegExp(String.raw`\(size\s+(${NUM})\s+(${NUM})`);

/** Returns parse(text, name): parser output plus raw footprint/pad geometry (`raw`). */
export async function loadKicadParser(placerRoot) {
  const mod = await import(pathToFileURL(path.join(placerRoot, 'src', 'kicad.js')).href);
  return (text, name) => {
    const design = mod.parseKicadPCB(text, name);
    const copper = copperSideNames(text);
    design.copperLayers = copperLayerTable(text);
    // Same block order as the parser: footprints, then legacy modules; pads in order.
    const blocks = [...mod.extractBlocks(text, 'footprint'), ...mod.extractBlocks(text, 'module')];
    design.raw = blocks.map((b, fi) => {
      const [x, y, deg] = parseAt(b);
      // The parser only recognises "B.Cu"; boards with custom copper names need the layer table.
      const layer = (b.match(/\(layer\s+"?([^")\s]+)"?\)/) ?? [])[1];
      if (layer) design.footprints[fi].side = layer === copper.back ? -1 : 1;
      return {
        x, y, deg, layer,
        lib: (b.match(/^\((?:footprint|module)\s+"?([^"\s)]+)/) ?? [])[1] ?? '',
        pads: mod.extractBlocks(b, 'pad').map((pb) => {
          const [px, py, pang] = parseAt(pb), m = pb.match(SIZE);
          return { px, py, pang, w: m ? Math.abs(+m[1]) : 0.8, h: m ? Math.abs(+m[2]) : 0.8, type: (pb.match(/^\(pad\s+(?:"[^"]*"|\S+)\s+(\w+)/) ?? [])[1] ?? 'smd' };
        }),
      };
    });
    return design;
  };
}

/**
 * Names of the front and back copper layers from the (layers ...) table. KiCad <= 4
 * numbers them 15 (front) and 0 (back); later versions 0 (front) and 31 (back).
 */
export function copperSideNames(text) {
  const layers = copperLayerTable(text);
  return { front: layers[0]?.name ?? 'F.Cu', back: layers[layers.length - 1]?.name ?? 'B.Cu' };
}

/**
 * Copper layers from top to bottom: {name, number, type: 'signal' | 'plane'}. KiCad
 * "power" layers are planes; "mixed" layers with a supply-like name (GND, PWR, VCC...) too.
 */
export function copperLayerTable(text) {
  const start = text.indexOf('(layers');
  // The table is short; entries after it (net classes etc.) never match the copper pattern.
  const table = start < 0 ? '' : text.slice(start, start + 4000).split(/\n\s*\)\s*\n/)[0];
  const byNumber = new Map();
  for (const m of table.matchAll(/\((\d+)\s+"?([^"\s)]+)"?\s+(signal|power|mixed|jumper)/g)) byNumber.set(+m[1], { name: m[2], type: m[3] });
  const modern = byNumber.has(31) || !byNumber.has(15);
  const front = modern ? 0 : 15, back = modern ? 31 : 0;
  const inner = [...byNumber.keys()].filter((k) => k !== front && k !== back).sort((a, b) => a - b);
  return [front, ...inner, back].filter((k) => byNumber.has(k)).map((k) => {
    const { name, type } = byNumber.get(k);
    const plane = k !== front && k !== back && (type === 'power' || (type === 'mixed' && /GND|PWR|POWER|VCC|VDD|VSS|PLANE/i.test(name)));
    return { name, number: k, type: plane ? 'plane' : 'signal' };
  });
}

function parseAt(block) {
  const m = block.match(AT);
  return m ? [+m[1], +m[2], +(m[3] || 0)] : [0, 0, 0];
}

/** Copper track segments and vias of the original board, in canvas coordinates. */
export function parseTracks(text, origin) {
  const num = `(${NUM})`;
  const seg = new RegExp(String.raw`\(segment\s+\(start\s+${num}\s+${num}\)\s*\(end\s+${num}\s+${num}\)\s*\(width\s+${num}\)\s*\(layer\s+"?([^)"\s]+)"?\)`, 'g');
  const via = new RegExp(String.raw`\(via\s+(?:\w+\s+)*\(at\s+${num}\s+${num}\)\s*\(size\s+${num}\)`, 'g');
  const segments = [], vias = [];
  let m;
  const copper = copperSideNames(text);
  const layerName = (l) => l === copper.front ? 'F.Cu' : l === copper.back ? 'B.Cu' : l;
  while ((m = seg.exec(text))) segments.push({ x1: +m[1] - origin.x, y1: +m[2] - origin.y, x2: +m[3] - origin.x, y2: +m[4] - origin.y, width: +m[5], layer: layerName(m[6]) });
  while ((m = via.exec(text))) vias.push({ x: +m[1] - origin.x, y: +m[2] - origin.y, size: +m[3] });
  return { segments, vias };
}

export function isPowerNet(name) {
  const leaf = String(name).split('/').pop();
  return POWER_NET.test(leaf);
}

/**
 * KiCad board -> Board IR (docs/board-ir.md). Bottom-side pads are converted back to
 * the top view; SMD footprints may use either side, through-hole ones keep theirs.
 */
export function kicadToIR(design, name = design.name) {
  const refCount = new Map();
  for (const f of design.footprints) refCount.set(f.name, (refCount.get(f.name) ?? 0) + 1);
  const ids = design.footprints.map((f, fi) => refCount.get(f.name) > 1 ? `${f.name}#${fi}` : f.name);
  // Edge.Cuts contours: a contour inside another one is a hole of it.
  const contours = (design.board.contours ?? []).filter((c) => c.length >= 3);
  const area = (c) => Math.abs(c.reduce((s, [x, y], k) => { const [x2, y2] = c[(k + 1) % c.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
  const inside = ([px, py], poly) => { let hit = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) hit = !hit; } return hit; };
  const sorted = [...contours].sort((a, b) => area(b) - area(a));
  const outline = [];
  for (const c of sorted) {
    const parent = outline.find((o) => inside(c[0], o.outer));
    if (parent) (parent.holes ??= []).push(c); else outline.push({ outer: c });
  }
  const netName = (pi) => { const n = design.pads[pi].net; return n >= 0 ? design.nets[n].name : null; };
  return {
    format: 'webgpu-pin-layout/board@1', yAxis: 'down', name,
    source: { tool: 'kicad', file: name },
    board: {
      outline, sides: ['top', 'bottom'],
      copperLayers: (design.copperLayers ?? []).map((l, k, all) => ({ name: l.name, type: l.type, ...(k === 0 ? { side: 'top' } : k === all.length - 1 ? { side: 'bottom' } : {}) })),
    },
    nets: design.nets.map((n) => ({ name: n.name, class: isPowerNet(n.name) ? (/GND|VSS/i.test(n.name.split('/').pop()) ? 'ground' : 'power') : 'signal' })),
    footprints: design.footprints.map((f, fi) => {
      const raw = design.raw[fi], bottom = f.side < 0, mx = bottom ? -1 : 1;
      const tht = raw.pads.some((p) => p.type === 'thru_hole');
      const side = bottom ? 'bottom' : 'top';
      return {
        id: ids[fi], library: raw.lib,
        pads: raw.pads.map((p, k) => ({
          id: String(k + 1), at: [mx * p.px, p.py], shape: 'rect', size: [p.w, p.h], rotation: mx * (p.pang - raw.deg),
          type: p.type === 'thru_hole' ? 'through' : p.type === 'np_thru_hole' ? 'npth' : 'smd', net: netName(f.firstPad + k),
        })),
        // Pad-less footprints (logos, fiducial art) keep their graphics extent + 0.25 mm.
        ...(raw.pads.length ? {} : { courtyard: { type: 'rect', x: -f.halfW - 0.25, y: -f.halfH - 0.25, width: 2 * f.halfW + 0.5, height: 2 * f.halfH + 0.5 } }),
        placement: { x: raw.x, y: raw.y, rotation: raw.deg, side },
        ...(f.fixed ? { fixed: true } : {}),
        allowedSides: tht ? [side] : ['top', 'bottom'],
      };
    }),
  };
}

/**
 * KiCad board -> engine problem, through the Board IR.
 * @param options.sides    'single' (one plane), 'original' (KiCad sides) or 'free' (SMD parts choose)
 * @param options.preplace fix connector/mechanical/edge footprints at their original position
 */
export function designToProblem(design, options = {}) {
  const sides = options.sides ?? 'single';
  return irToProblem(kicadToIR(design), { preplace: options.preplace, sides: sides === 'free' ? 'ir' : sides, bodyMargin: options.bodyMargin });
}
