// Soft anchors (VeoPlace-style guidance): each anchor is a fixed, zero-area hub at a target
// point; every listed part gets a low-weight 2-pin net from its centre to the hub, so every
// placement stage (global placer, LNS scorer) is pulled toward the target without a hard region.
// Hubs are appended after the real components; strip them with layout.slice(0, n).

export const ANCHOR_NET_PREFIX = '~anchor';
export const isAnchorNet = (id) => String(id).startsWith(ANCHOR_NET_PREFIX);

/**
 * @param input problem input
 * @param anchors [{members: [component id], x, y}] in canvas coordinates (mm)
 */
export function withAnchors(input, anchors) {
  const components = input.components.map((c) => ({ ...c, pins: [...c.pins] }));
  const index = new Map(components.map((c, i) => [c.id, i]));
  const nets = [...input.nets];
  const W = input.canvas.width, H = input.canvas.height;
  anchors.forEach((a, k) => {
    const members = (a.members ?? []).map((id) => index.get(id)).filter((i) => i !== undefined && !components[i].fixed);
    if (!members.length || !Number.isFinite(+a.x) || !Number.isFinite(+a.y)) return;
    const hub = { id: `${ANCHOR_NET_PREFIX}hub${k}`, width: 0.01, height: 0.01, rotatable: false, twoSided: true, pins: [], fixed: { x: Math.min(W, Math.max(0, +a.x)), y: Math.min(H, Math.max(0, +a.y)), rotation: 0 } };
    for (const i of members) {
      const id = `${ANCHOR_NET_PREFIX}${k}_${i}`;
      components[i].pins.push({ id: `${id}s`, x: 0, y: 0 });
      hub.pins.push({ id: `${id}a`, x: 0, y: 0 });
      nets.push({ id, pins: [{ componentId: components[i].id, pinId: `${id}s` }, { componentId: hub.id, pinId: `${id}a` }] });
    }
    components.push(hub);
  });
  return { ...input, components, nets };
}
