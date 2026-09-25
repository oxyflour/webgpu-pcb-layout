// Converts a KiCad board into a webgpu-pin-layout problem plus the pad geometry needed
// to route it. Nets and names come from webgpu_pcb_placer's parser; footprint and pad
// geometry is re-read from the file with KiCad's own transform (y-down, rotation
// counter-clockwise on screen, bottom-side pads stored already mirrored).
//
// Board sides (options.sides):
//   'single'   every footprint on one plane (legacy; bottom parts compete with top ones)
//   'original' each footprint stays on its KiCad side
//   'free'     SMD footprints may use either side; through-hole parts keep their side
//              and block both. Pins are expressed as seen from the top, so a bottom
//              placement mirrors them (KiCad stores bottom pads already mirrored).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const POWER_NET = /^(A|D|P)?GND|^(VCC|VDD|VSS|VBAT|VIN|VBUS)|^\+?\d+V\d*|^\d+V\d+|3V3|1V8|2V5/i;
// Parts whose position is dictated by the enclosure, not by wiring.
const MECHANICAL_LIB = /conn|usb|rj\d\d|header|pin_?head|jack|terminal|socket|barrel|hdmi|sd_?card|micro_?sd|sim_?card|mounting|hole|fiducial|test_?point|dsub|db\d|idc|molex|jst|battery|bnc|sma/i;
const NUM = String.raw`[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?`;
const AT = new RegExp(String.raw`\(at\s+(${NUM})\s+(${NUM})(?:\s+(${NUM}))?`);
const SIZE = new RegExp(String.raw`\(size\s+(${NUM})\s+(${NUM})`);

/** Returns parse(text, name): parser output plus raw footprint/pad geometry (`raw`). */
export async function loadKicadParser(placerRoot) {
  const mod = await import(pathToFileURL(path.join(placerRoot, 'src', 'kicad.js')).href);
  return (text, name) => {
    const design = mod.parseKicadPCB(text, name);
    // Same block order as the parser: footprints, then legacy modules; pads in order.
    const blocks = [...mod.extractBlocks(text, 'footprint'), ...mod.extractBlocks(text, 'module')];
    design.raw = blocks.map((b) => {
      const [x, y, deg] = parseAt(b);
      return {
        x, y, deg,
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

function parseAt(block) {
  const m = block.match(AT);
  return m ? [+m[1], +m[2], +(m[3] || 0)] : [0, 0, 0];
}

/** KiCad footprint rotation of a local vector (y-down, counter-clockwise on screen). */
function kicadRotate(x, y, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c + y * s, -x * s + y * c];
}

/** Copper track segments and vias of the original board, in canvas coordinates. */
export function parseTracks(text, origin) {
  const num = `(${NUM})`;
  const seg = new RegExp(String.raw`\(segment\s+\(start\s+${num}\s+${num}\)\s*\(end\s+${num}\s+${num}\)\s*\(width\s+${num}\)\s*\(layer\s+"?([^)"\s]+)"?\)`, 'g');
  const via = new RegExp(String.raw`\(via\s+(?:\w+\s+)*\(at\s+${num}\s+${num}\)\s*\(size\s+${num}\)`, 'g');
  const segments = [], vias = [];
  let m;
  while ((m = seg.exec(text))) segments.push({ x1: +m[1] - origin.x, y1: +m[2] - origin.y, x2: +m[3] - origin.x, y2: +m[4] - origin.y, width: +m[5], layer: m[6] });
  while ((m = via.exec(text))) vias.push({ x: +m[1] - origin.x, y: +m[2] - origin.y, size: +m[3] });
  return { segments, vias };
}

export function isPowerNet(name) {
  const leaf = String(name).split('/').pop();
  return POWER_NET.test(leaf);
}

/**
 * @param design parse() output of loadKicadParser
 * @param options.skipPowerNets drop ground/supply nets from the signal objective (default true)
 * @param options.maxNetDegree drop nets with more pins than this
 * @param options.preplace fix mechanical/edge footprints at their original position
 * @param options.bodyMargin courtyard margin around the pad bounding box (mm)
 */
export function designToProblem(design, options = {}) {
  const bodyMargin = options.bodyMargin ?? 0.25;
  const sideMode = options.sides ?? 'single';
  if (!['single', 'original', 'free'].includes(sideMode)) throw new Error(`unknown sides mode ${sideMode}`);
  const skipPower = options.skipPowerNets ?? true;
  const maxDegree = options.maxNetDegree ?? Infinity;
  const b = design.board;
  const ox = b.minX, oy = b.minY;
  const canvas = { width: b.maxX - b.minX, height: b.maxY - b.minY };
  if (!design.raw || design.raw.length !== design.footprints.length) throw new Error('design.raw missing: load the board with loadKicadParser()');

  const keptNets = [], powerNets = [];
  let droppedPower = 0, droppedDegree = 0;
  for (const net of design.nets) {
    if (net.pads.length < 2) continue;
    if (skipPower && isPowerNet(net.name)) { droppedPower++; powerNets.push(net); continue; }
    if (net.pads.length > maxDegree) { droppedDegree++; continue; }
    keptNets.push(net);
  }
  const padNet = new Int32Array(design.pads.length).fill(-1);
  keptNets.forEach((net, ni) => { for (const pi of net.pads) padNet[pi] = ni; });

  const quarter = (deg) => ((Math.round(-deg / 90) % 4) + 4) % 4;
  // Outline bounding box in canvas coordinates, for edge detection.
  const originalLayout = [], bodyOffset = [], mechanical = [];
  const components = design.footprints.map((f, fi) => {
    const raw = design.raw[fi];
    // Body = pad bounding box in footprint-local coordinates (+ margin).
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of raw.pads) {
      const a = (p.pang - raw.deg) * Math.PI / 180;
      const hx = 0.5 * (Math.abs(Math.cos(a)) * p.w + Math.abs(Math.sin(a)) * p.h), hy = 0.5 * (Math.abs(Math.sin(a)) * p.w + Math.abs(Math.cos(a)) * p.h);
      x0 = Math.min(x0, p.px - hx); x1 = Math.max(x1, p.px + hx); y0 = Math.min(y0, p.py - hy); y1 = Math.max(y1, p.py + hy);
    }
    if (!raw.pads.length) { x0 = -f.halfW; x1 = f.halfW; y0 = -f.halfH; y1 = f.halfH; }
    const dx = (x0 + x1) / 2, dy = (y0 + y1) / 2;
    bodyOffset.push([dx, dy]);
    const [rx, ry] = kicadRotate(dx, dy, raw.deg);
    const bottom = f.side < 0 && sideMode !== 'single';
    const place = { x: raw.x + rx - ox, y: raw.y + ry - oy, rotation: quarter(raw.deg), ...(sideMode !== 'single' ? { side: bottom ? 1 : 0 } : {}) };
    originalLayout.push(place);
    const width = Math.max(0.4, x1 - x0 + 2 * bodyMargin), height = Math.max(0.4, y1 - y0 + 2 * bodyMargin);
    const pins = [];
    // Top-view local x: undo KiCad's mirroring of bottom footprints.
    const mx = bottom ? -1 : 1;
    raw.pads.forEach((p, k) => { const pi = f.firstPad + k; if (padNet[pi] >= 0) pins.push({ id: `p${pi}`, x: mx * (p.px - dx), y: p.py - dy }); });
    // Mechanical: connector-like library, no pads, or body touching the board outline box.
    const [w, h] = (place.rotation & 1) ? [height, width] : [width, height];
    const atEdge = place.x - w / 2 < 0.5 || place.y - h / 2 < 0.5 || place.x + w / 2 > canvas.width - 0.5 || place.y + h / 2 > canvas.height - 0.5;
    mechanical.push(MECHANICAL_LIB.test(raw.lib) || !raw.pads.length || atEdge);
    const tht = raw.pads.some((p) => p.type === 'thru_hole');
    const c = { id: `${f.name}#${fi}`, width, height, pins };
    if (sideMode !== 'single') {
      c.twoSided = tht;
      c.sides = sideMode === 'free' && !tht ? 'any' : bottom ? 'bottom' : 'top';
    }
    if (f.fixed || (options.preplace && mechanical[fi])) c.fixed = { ...place };
    return c;
  });
  const nets = keptNets.map((net) => ({
    id: net.name,
    pins: net.pads.map((pi) => ({ componentId: components[design.pads[pi].parent].id, pinId: `p${pi}` })),
  }));
  // Net names are not guaranteed unique in old KiCad files.
  const seen = new Map();
  for (const n of nets) { const k = seen.get(n.id) ?? 0; seen.set(n.id, k + 1); if (k) n.id = `${n.id}~${k}`; }

  // Every pad, in the component body frame, for routing evaluation.
  const pads = [];
  design.footprints.forEach((f, fi) => {
    const raw = design.raw[fi], [dx, dy] = bodyOffset[fi], mx = originalLayout[fi].side ? -1 : 1;
    raw.pads.forEach((p, k) => pads.push({
      comp: fi, lx: mx * (p.px - dx), ly: p.py - dy, w: p.w, h: p.h, rot: p.pang - raw.deg,
      tht: p.type === 'thru_hole', hole: p.type === 'np_thru_hole', net: padNet[f.firstPad + k],
      padIndex: f.firstPad + k,
    }));
  });
  // Supply nets: pads grouped per net, flagged as anchors when they sit on an IC.
  const padsOf = (fi) => design.footprints[fi].padCount;
  const power = powerNets.map((net) => ({
    name: net.name,
    pads: net.pads.map((pi) => {
      const fi = design.pads[pi].parent, raw = design.raw[fi], k = pi - design.footprints[fi].firstPad, [dx, dy] = bodyOffset[fi];
      return { comp: fi, padIndex: pi, x: (originalLayout[fi].side ? -1 : 1) * (raw.pads[k].px - dx), y: raw.pads[k].py - dy, anchor: padsOf(fi) >= 8 };
    }),
  }));

  const area = components.reduce((s, c) => s + c.width * c.height, 0);
  return {
    input: { canvas, components, nets },
    originalLayout,
    // Board-space origin of the canvas, footprint sides (+1 top, -1 bottom) and outline.
    origin: { x: ox, y: oy },
    sides: design.footprints.map((f) => f.side),
    contours: (b.contours ?? []).map((c) => c.map(([x, y]) => [x - ox, y - oy])),
    routing: { canvas, pads, netCount: nets.length },
    power, mechanical,
    stats: {
      footprints: components.length,
      bottom: design.footprints.filter((f) => f.side < 0).length,
      locked: components.filter((c) => c.fixed).length,
      mechanical: mechanical.filter(Boolean).length,
      nets: nets.length,
      pins: nets.reduce((s, n) => s + n.pins.length, 0),
      droppedPower, droppedDegree,
      offQuarter: design.raw.filter((r) => Math.abs(((r.deg % 90) + 90) % 90) > 1e-6).length,
      canvas: [+canvas.width.toFixed(1), +canvas.height.toFixed(1)],
      density: area / (canvas.width * canvas.height),
    },
  };
}
