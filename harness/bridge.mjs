import { normalizeProblem, worldPin, localPin, rotateQuarter, rotatedSize, exportBookshelf, importCypressPlacement } from './runtime.mjs';
import { writeJson } from './io.mjs';
import path from 'node:path';

// Bake each movable component's current orientation into its local geometry.
// Cypress optimizes a DELTA rotation; map that delta back into the board frame.
// This also preserves bottom-side mirror-before-rotation semantics.
export function bakeOrientation(adapted, layout, preserve = []) {
  const original = normalizeProblem(adapted.input), kept = new Set(preserve);
  if (layout.length !== original.components.length) throw Error('Layout length mismatch');
  const input = { ...adapted.input, components: adapted.input.components.map((c, i) => {
    if (c.fixed) return { ...c, fixed: { ...c.fixed } };
    const pose = layout[i], [width, height] = rotatedSize(original.components[i], pose.rotation);
    const transform = (x, y) => localPin(...rotateQuarter(...localPin(x, y, pose.side), pose.rotation), pose.side);
    return { ...c, width, height, rotatable: kept.has(c.id) ? false : c.rotatable,
      pins: (c.pins ?? []).map(pin => {
        const [x, y] = transform(pin.x, pin.y);
        return { ...pin, x, y, ...(pin.normal ? { normal: transform(...pin.normal) } : {}) };
      }) };
  }) };
  const initial = layout.map((pose, i) => original.components[i].fixed ? { ...original.components[i].fixed } : { ...pose, rotation: 0 });
  return { adapted: { ...adapted, input }, initial, baseRotations: layout.map(p => p.rotation) };
}
export function exportIncremental(adapted, layout, dir, preserve = []) {
  const baked = bakeOrientation(adapted, layout, preserve);
  const bridge = exportBookshelf(baked.adapted, baked.initial, dir), original = normalizeProblem(adapted.input);
  let error = 0, cursor = 0;
  for (const net of original.nets) for (const pi of net.pins) {
    const [x, y] = worldPin(original, layout, pi), pin = bridge.expectedPins[cursor++];
    error = Math.max(error, Math.abs(pin.x - x), Math.abs(bridge.height - pin.y - y));
  }
  if (cursor !== bridge.expectedPins.length || error > .011) throw Error('Incremental export changed input pin coordinates');
  writeJson(path.join(dir, 'orientation.json'), { protocol: 'baked-incremental-v1', baseRotations: baked.baseRotations, inputPinErrorMm: error, preserve });
  return { ...baked, bridge, inputPinErrorMm: error };
}
export function importIncremental(original, baked, output) {
  const layout = importCypressPlacement(baked.adapted, output).map((pose, i) => original.input.components[i].fixed ? { ...original.input.components[i].fixed } : { ...pose, rotation: (pose.rotation + baked.baseRotations[i]) % 4 });
  const p = normalizeProblem(original.input), points = new Map();
  for (const pin of output.engine_pins) {
    const key = pin.id + '/' + pin.net;
    if (!points.has(key)) points.set(key, []);
    points.get(key).push(pin);
  }
  let error = 0;
  p.nets.forEach((net, ni) => net.pins.forEach(pi => {
    const [x, y] = worldPin(p, layout, pi), id = p.components[p.pins[pi].componentIndex].id;
    const group = points.get(id + '/n' + ni);
    if (!group?.length) throw Error('Missing final engine pin');
    const distances = group.map(q => Math.max(Math.abs(q.x - x), Math.abs(q.y - y))), k = distances.indexOf(Math.min(...distances));
    error = Math.max(error, distances[k]); group.splice(k, 1);
  }));
  if ([...points.values()].some(g => g.length) || !Number.isFinite(error) || error > .025) throw Error('Final engine pin roundtrip failed: ' + error);
  return { layout, finalPinErrorMm: error };
}
