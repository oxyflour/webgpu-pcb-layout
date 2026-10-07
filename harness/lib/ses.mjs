// Independent scoring of a FreeRouting session (.ses) against the pins of exportDsn: per net, union
// pins, wire polylines and vias that touch (same layer for wires/pads; vias join every layer they
// span), and count a net as routed when all its pins end in one component. Also counts vias and
// copper length. FreeRouting keeps its own clearances, so routed = routed without conflicts.

function parse(text) {
  const tokens = text.match(/"[^"]*"|[()]|[^\s()"]+/g), stack = [[]];
  for (const t of tokens) {
    if (t === '(') stack.push([]);
    else if (t === ')') { const e = stack.pop(); stack[stack.length - 1].push(e); }
    else stack[stack.length - 1].push(t.startsWith('"') ? t.slice(1, -1) : t);
  }
  return stack[0][0];
}
const find = (e, k) => e.find((x) => Array.isArray(x) && x[0] === k);
const all = (e, k) => e.filter((x) => Array.isArray(x) && x[0] === k);

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export function scoreSes(sesText, dsn) {
  const ses = parse(sesText), routes = find(ses, 'routes');
  const res = find(routes, 'resolution'), scale = 1 / ((res[1] === 'um' ? 1000 : res[1] === 'mm' ? 1 : 39370.08) * Number(res[2]));
  const out = find(routes, 'network_out') ?? ['network_out'];
  const byNet = new Map(all(out, 'net').map((n) => [n[1], n]));
  const pinsByNet = new Map();
  for (const p of dsn.pins) if (p.net >= 0) { const k = `N${p.net}`; if (!pinsByNet.has(k)) pinsByNet.set(k, []); pinsByNet.get(k).push(p); }
  let routed = 0, nets = 0, vias = 0, length = 0;
  const unrouted = [];
  for (const [name, pins] of pinsByNet) {
    if (pins.length < 2) continue;
    nets++;
    const n = byNet.get(name) ?? [];
    const wires = all(n, 'wire').map((w) => { const p = find(w, 'path'); const xy = p.slice(3).map(Number); const pts = []; for (let i = 0; i + 1 < xy.length; i += 2) pts.push([xy[i] * scale, -xy[i + 1] * scale]); return { layer: p[1], w: Number(p[2]) * scale, pts }; });
    const vs = all(n, 'via').map((v) => ({ x: Number(v[2]) * scale, y: -Number(v[3]) * scale }));
    vias += vs.length;
    for (const w of wires) for (let i = 1; i < w.pts.length; i++) length += Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]);
    // Nodes: pins, wires, vias.
    const N = pins.length + wires.length + vs.length, parent = Int32Array.from({ length: N }, (_, i) => i);
    const root = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const join = (a, b) => { parent[root(a)] = root(b); };
    const near = (x, y, w, tol) => { for (let i = 1; i < w.pts.length; i++) if (segDist(x, y, ...w.pts[i - 1], ...w.pts[i]) <= tol) return true; return w.pts.length === 1 && Math.hypot(x - w.pts[0][0], y - w.pts[0][1]) <= tol; };
    const inPad = (p, x, y, e) => Math.abs(x - p.x) <= p.hx + e && Math.abs(y - p.y) <= p.hy + e;
    const W0 = pins.length, V0 = W0 + wires.length, eps = 1e-3;
    wires.forEach((w, i) => {
      pins.forEach((p, j) => { if (p.layers.includes(w.layer) && (w.pts.some(([x, y]) => inPad(p, x, y, w.w / 2 + eps)) || near(p.x, p.y, w, w.w / 2 + eps))) join(W0 + i, j); });
      for (let k = 0; k < i; k++) { const o = wires[k]; if (o.layer === w.layer && (w.pts.some(([x, y]) => near(x, y, o, Math.max(w.w, o.w) / 2 + eps)) || o.pts.some(([x, y]) => near(x, y, w, Math.max(w.w, o.w) / 2 + eps)))) join(W0 + i, W0 + k); }
    });
    vs.forEach((v, i) => {
      wires.forEach((w, k) => { if (near(v.x, v.y, w, w.w / 2 + eps)) join(V0 + i, W0 + k); });
      pins.forEach((p, j) => { if (inPad(p, v.x, v.y, eps)) join(V0 + i, j); });
    });
    // Pins of one net that overlap each other on a shared layer are connected without copper.
    for (let i = 0; i < pins.length; i++) for (let j = 0; j < i; j++) if (pins[i].layers.some((l) => pins[j].layers.includes(l)) && Math.abs(pins[i].x - pins[j].x) <= pins[i].hx + pins[j].hx && Math.abs(pins[i].y - pins[j].y) <= pins[i].hy + pins[j].hy) join(i, j);
    const r0 = root(0);
    if (pins.every((_, j) => root(j) === r0)) routed++; else unrouted.push(name);
  }
  return { routed, nets, vias, lengthMm: Math.round(length), unrouted };
}
