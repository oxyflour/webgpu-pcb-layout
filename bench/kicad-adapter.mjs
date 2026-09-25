// Converts a parsed KiCad board (webgpu_pcb_placer's parseKicadPCB output) into a
// webgpu-pin-layout problem. All footprints share one placement plane because this
// package has no notion of board sides; bottom-side parts therefore compete for area
// with top-side parts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rotateQuarter } from '../src/problem.js';

const POWER_NET = /^(A|D|P)?GND|^(VCC|VDD|VSS|VBAT|VIN|VBUS)|^\+?\d+V\d*|^\d+V\d+|3V3|1V8|2V5/i;

export async function loadKicadParser(placerRoot) {
  const mod = await import(pathToFileURL(path.join(placerRoot, 'src', 'kicad.js')).href);
  return mod.parseKicadPCB;
}

/** Copper track segments and vias of the original board, in canvas coordinates. */
export function parseTracks(text, origin) {
  const num = String.raw`([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)`;
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
 * @param design parseKicadPCB() output
 * @param options.rotationSign +1 or -1: maps KiCad degrees to quarter turns
 * @param options.skipPowerNets drop ground/supply nets from the objective
 * @param options.maxNetDegree drop nets with more pins than this
 */
export function designToProblem(design, options = {}) {
  // KiCad is y-down with counter-clockwise-on-screen rotation, i.e. quarter = -deg/90.
  const rotationSign = options.rotationSign ?? -1;
  // 'pads': body = pad bounding box + bodyMargin (courtyard-like);
  // 'graphics': the parser's silk/fab/courtyard bounding box (heavily inflated).
  const bodyMode = options.body ?? 'pads';
  const bodyMargin = options.bodyMargin ?? 0.25;
  const skipPower = options.skipPowerNets ?? true;
  const maxDegree = options.maxNetDegree ?? Infinity;
  const margin = options.margin ?? 0;
  const b = design.board;
  const ox = b.minX - margin, oy = b.minY - margin;
  const canvas = { width: b.maxX - b.minX + 2 * margin, height: b.maxY - b.minY + 2 * margin };

  const keptNets = [];
  let droppedPower = 0, droppedDegree = 0;
  for (const net of design.nets) {
    if (net.pads.length < 2) continue;
    if (skipPower && isPowerNet(net.name)) { droppedPower++; continue; }
    if (net.pads.length > maxDegree) { droppedDegree++; continue; }
    keptNets.push(net);
  }
  const usedPads = new Set();
  for (const net of keptNets) for (const pi of net.pads) usedPads.add(pi);

  const quarter = (deg) => ((Math.round(rotationSign * deg / 90) % 4) + 4) % 4;
  const originalLayout = [];
  const components = design.footprints.map((f, fi) => {
    // Body frame: offset (dx, dy) from the parser's footprint center, in local coordinates.
    let dx = 0, dy = 0, halfW = f.halfW, halfH = f.halfH;
    if (bodyMode === 'pads' && f.padCount > 0) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < f.padCount; k++) {
        const pad = design.pads[f.firstPad + k], a = pad.rot * Math.PI / 180;
        const hx = 0.5 * (Math.abs(Math.cos(a)) * pad.w + Math.abs(Math.sin(a)) * pad.h);
        const hy = 0.5 * (Math.abs(Math.sin(a)) * pad.w + Math.abs(Math.cos(a)) * pad.h);
        x0 = Math.min(x0, pad.lx - hx); x1 = Math.max(x1, pad.lx + hx);
        y0 = Math.min(y0, pad.ly - hy); y1 = Math.max(y1, pad.ly + hy);
      }
      dx = (x0 + x1) / 2; dy = (y0 + y1) / 2;
      halfW = Math.max(0.2, (x1 - x0) / 2 + bodyMargin); halfH = Math.max(0.2, (y1 - y0) / 2 + bodyMargin);
    }
    const q = quarter(f.rot);
    const [rx, ry] = rotateQuarter(dx, dy, q);
    const place = { x: f.x + rx - ox, y: f.y + ry - oy, rotation: q };
    originalLayout.push(place);
    const pins = [];
    for (let k = 0; k < f.padCount; k++) {
      const pi = f.firstPad + k;
      if (!usedPads.has(pi)) continue;
      const pad = design.pads[pi];
      pins.push({ id: `p${pi}`, x: pad.lx - dx, y: pad.ly - dy });
    }
    const c = { id: `${f.name}#${fi}`, width: 2 * halfW, height: 2 * halfH, pins };
    if (f.fixed) c.fixed = { ...place };
    return c;
  });
  const nets = keptNets.map((net) => ({
    id: net.name,
    pins: net.pads.map((pi) => ({ componentId: components[design.pads[pi].parent].id, pinId: `p${pi}` })),
  }));
  // Net names are not guaranteed unique in old KiCad files.
  const seen = new Map();
  for (const n of nets) { const k = seen.get(n.id) ?? 0; seen.set(n.id, k + 1); if (k) n.id = `${n.id}~${k}`; }

  const offQuarter = design.footprints.filter((f) => Math.abs(((f.rot % 90) + 90) % 90) > 1e-6).length;
  const area = components.reduce((s, c) => s + c.width * c.height, 0);
  return {
    input: { canvas, components, nets },
    originalLayout,
    // Board-space origin of the canvas, footprint sides (+1 top, -1 bottom) and outline.
    origin: { x: ox, y: oy },
    sides: design.footprints.map((f) => f.side),
    contours: (b.contours ?? []).map((c) => c.map(([x, y]) => [x - ox, y - oy])),
    stats: {
      footprints: components.length,
      bottom: design.footprints.filter((f) => f.side < 0).length,
      locked: components.filter((c) => c.fixed).length,
      nets: nets.length,
      pins: nets.reduce((s, n) => s + n.pins.length, 0),
      droppedPower, droppedDegree, offQuarter,
      canvas: [+canvas.width.toFixed(1), +canvas.height.toFixed(1)],
      density: area / (canvas.width * canvas.height),
    },
  };
}
