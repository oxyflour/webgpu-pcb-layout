import { rotatedSize } from '../problem.js';

function rng32(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }

/**
 * Weighted component graph of the signal netlist: a net touching k distinct movable
 * components adds 1/(k-1) to every pair (clique model). Nets wider than `maxNetSize`
 * components (buses, resets, chip selects fanning out everywhere) are ignored.
 */
export function componentGraph(problem, options = {}) {
  const maxNetSize = options.maxNetSize ?? 24;
  const include = options.include ?? ((i) => !problem.components[i].fixed);
  const adj = problem.components.map(() => new Map());
  for (const net of problem.nets) {
    const comps = [...new Set(net.pins.map((p) => problem.pins[p].componentIndex))].filter(include);
    if (comps.length < 2 || comps.length > maxNetSize) continue;
    const w = 1 / (comps.length - 1);
    for (let a = 0; a < comps.length; a++) for (let b = a + 1; b < comps.length; b++) {
      const i = comps[a], j = comps[b];
      adj[i].set(j, (adj[i].get(j) ?? 0) + w); adj[j].set(i, (adj[i].get(j)));
    }
  }
  return adj;
}

/** One Louvain run (local moves + aggregation until stable). Returns community per node. */
export function louvain(adj, nodes, options = {}) {
  const gamma = options.resolution ?? 1, rnd = rng32(options.seed ?? 1);
  // Level-0 graph restricted to `nodes`.
  const index = new Map(nodes.map((v, k) => [v, k]));
  let graph = nodes.map((v) => { const m = new Map(); for (const [u, w] of adj[v]) if (index.has(u)) m.set(index.get(u), w); return m; });
  let member = nodes.map((_, k) => k); // original node -> current super-node
  for (let level = 0; level < 20; level++) {
    const n = graph.length, deg = graph.map((m) => { let s = 0; for (const w of m.values()) s += w; return s; });
    const m2 = deg.reduce((a, b) => a + b, 0);
    if (m2 === 0) break;
    const comm = Array.from({ length: n }, (_, k) => k), tot = deg.slice();
    let movedAny = false;
    for (let pass = 0; pass < 50; pass++) {
      let moved = 0;
      const order = Array.from({ length: n }, (_, k) => k);
      for (let k = n - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
      for (const v of order) {
        const cv = comm[v], links = new Map();
        for (const [u, w] of graph[v]) if (u !== v) links.set(comm[u], (links.get(comm[u]) ?? 0) + w);
        tot[cv] -= deg[v];
        let best = cv, bestGain = (links.get(cv) ?? 0) - gamma * tot[cv] * deg[v] / m2;
        for (const [c, w] of links) {
          const gain = w - gamma * tot[c] * deg[v] / m2;
          if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
        }
        tot[best] += deg[v];
        if (best !== cv) { comm[v] = best; moved++; }
      }
      if (!moved) break;
      movedAny = true;
    }
    if (!movedAny) break;
    // Aggregate communities into super-nodes.
    const ids = new Map(); for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size);
    const next = Array.from({ length: ids.size }, () => new Map());
    graph.forEach((m, v) => { const a = ids.get(comm[v]); for (const [u, w] of m) { const b = ids.get(comm[u]); next[a].set(b, (next[a].get(b) ?? 0) + w); } });
    member = member.map((s) => ids.get(comm[s]));
    graph = next;
  }
  return member;
}

const areaOf = (c) => c.width * c.height;

/**
 * Automatic modules: Louvain communities of the signal graph over movable parts,
 * recursively split while a module exceeds `maxAreaFraction` of the board, with
 * one-part communities merged into their most connected neighbour. Parts with no
 * signal connection to another movable part stay unassigned.
 *
 * @returns {modules: [{members:number[]}], unassigned:number[]}
 */
export function autoModules(problem, options = {}) {
  const adj = options.graph ?? componentGraph(problem, options);
  const boardArea = problem.canvas.width * problem.canvas.height;
  const maxArea = (options.maxAreaFraction ?? 0.18) * boardArea;
  const minSize = options.minSize ?? 2;
  const movable = problem.components.map((c, i) => i).filter((i) => !problem.components[i].fixed);
  const connected = movable.filter((i) => adj[i].size > 0);
  const unassigned = movable.filter((i) => adj[i].size === 0);

  const split = (nodes, gamma, depth) => {
    const member = louvain(adj, nodes, { resolution: gamma, seed: (options.seed ?? 1) + depth });
    const groups = new Map();
    member.forEach((c, k) => { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(nodes[k]); });
    const out = [];
    for (const g of groups.values()) {
      const area = g.reduce((s, i) => s + areaOf(problem.components[i]), 0);
      if (area > maxArea && g.length > 1 && depth < 4 && groups.size >= 1) {
        const parts = split(g, gamma * 2, depth + 1);
        out.push(...(parts.length > 1 ? parts : [g]));
      } else out.push(g);
    }
    return out;
  };
  let groups = connected.length ? split(connected, options.resolution ?? 1, 0) : [];

  // Merge undersized groups into the neighbour group they are most connected to.
  const owner = new Map();
  groups.forEach((g, k) => g.forEach((i) => owner.set(i, k)));
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k];
      if (!g.length || g.length >= minSize) continue;
      const links = new Map();
      for (const i of g) for (const [j, w] of adj[i]) { const o = owner.get(j); if (o !== undefined && o !== k) links.set(o, (links.get(o) ?? 0) + w); }
      let best = -1, bw = 0;
      for (const [o, w] of links) if (w > bw && groups[o].length) { best = o; bw = w; }
      if (best < 0) continue;
      for (const i of g) { groups[best].push(i); owner.set(i, best); }
      groups[k] = []; changed = true;
    }
  }
  groups = groups.filter((g) => g.length >= minSize);
  const assigned = new Set(groups.flat());
  for (const i of connected) if (!assigned.has(i)) unassigned.push(i);
  // Largest modules first; members by decreasing area (the largest part names the module).
  for (const g of groups) g.sort((a, b) => areaOf(problem.components[b]) - areaOf(problem.components[a]));
  groups.sort((a, b) => b.reduce((s, i) => s + areaOf(problem.components[i]), 0) - a.reduce((s, i) => s + areaOf(problem.components[i]), 0));
  return { modules: groups.map((members) => ({ members })), unassigned };
}

/** Connection statistics of a module partition (for reports and exported JSON). */
export function moduleStats(problem, modules, options = {}) {
  const owner = new Int32Array(problem.components.length).fill(-1);
  modules.forEach((m, k) => m.members.forEach((i) => { owner[i] = k; }));
  const stats = modules.map((m) => ({
    parts: m.members.length,
    area: m.members.reduce((s, i) => s + areaOf(problem.components[i]), 0),
    pins: m.members.reduce((s, i) => s + problem.components[i].pins.length, 0),
    internalNets: 0, externalNets: 0,
  }));
  const links = new Map();
  for (const net of problem.nets) {
    const mods = [...new Set(net.pins.map((p) => owner[problem.pins[p].componentIndex]))];
    const inMods = mods.filter((k) => k >= 0);
    if (mods.length === 1 && inMods.length === 1) stats[inMods[0]].internalNets++;
    else for (const k of inMods) stats[k].externalNets++;
    for (let a = 0; a < inMods.length; a++) for (let b = a + 1; b < inMods.length; b++) {
      const key = Math.min(inMods[a], inMods[b]) + ':' + Math.max(inMods[a], inMods[b]);
      links.set(key, (links.get(key) ?? 0) + 1);
    }
  }
  return { stats, links: [...links].map(([key, nets]) => { const [a, b] = key.split(':').map(Number); return { a, b, nets }; }).sort((x, y) => y.nets - x.nets) };
}

/**
 * Module-level placement problem: one square soft macro per module (area = inflated
 * member area / target density), every part outside a module as itself (fixed parts
 * keep their position), and one pin per (owner, net) for nets spanning owners.
 *
 * @param modules [{members, side?: 0|1, region?: {x,y,width,height}}] (canvas coords)
 * @returns {input, owners} where owners[k] = {module: k} | {component: i}
 */
export function moduleProblem(problem, layout, modules, options = {}) {
  const target = options.target ?? 0.65, pinArea = options.pinArea ?? 0.6;
  const W = problem.canvas.width, H = problem.canvas.height;
  const ownerOf = new Int32Array(problem.components.length).fill(-1);
  const owners = [], components = [];
  modules.forEach((m, k) => {
    const area = m.members.reduce((s, i) => { const c = problem.components[i]; return s + areaOf(c) + pinArea * c.pins.length; }, 0);
    const side = Math.min(0.9 * Math.min(W, H), Math.sqrt(area / target));
    const comp = { id: `module:${k}`, width: side, height: side, rotatable: false, pins: [], sides: m.side ? 'bottom' : 'top' };
    if (m.region) comp.fixed = { x: m.region.x + m.region.width / 2, y: m.region.y + m.region.height / 2, rotation: 0, side: m.side ? 1 : 0 };
    m.members.forEach((i) => { ownerOf[i] = owners.length; });
    owners.push({ module: k }); components.push(comp);
  });
  problem.components.forEach((c, i) => {
    if (ownerOf[i] >= 0) return;
    ownerOf[i] = owners.length; owners.push({ component: i });
    const comp = { id: `part:${i}`, width: c.width, height: c.height, rotatable: c.rotatable, pins: [], sides: c.sides, twoSided: c.twoSided };
    if (c.fixed) comp.fixed = { ...c.fixed };
    else comp.initial = layout[i];
    components.push(comp);
  });
  const nets = [];
  problem.nets.forEach((net, ni) => {
    const seen = new Map();
    for (const p of net.pins) { const o = ownerOf[problem.pins[p].componentIndex]; if (!seen.has(o)) seen.set(o, p); }
    if (seen.size < 2) return;
    const pins = [];
    for (const [o, p] of seen) {
      const pin = problem.pins[p], id = `n${ni}`;
      // Modules connect at their centre; single parts at the real pin.
      components[o].pins.push(owners[o].module !== undefined ? { id, x: 0, y: 0 } : { id, x: pin.x, y: pin.y });
      pins.push({ componentId: components[o].id, pinId: id });
    }
    nets.push({ id: `n${ni}`, pins });
  });
  const initial = components.map((c) => c.fixed ? { ...c.fixed } : c.initial ? { ...c.initial } : null);
  for (const c of components) delete c.initial;
  return { input: { canvas: problem.canvas, components, nets }, owners, initial, ownerOf };
}

/**
 * Component-level starting layout from a module-level placement: members are spread
 * uniformly inside their module square (SMD parts on the module's side), everything
 * else takes its module-problem position.
 */
export function expandModules(problem, modProblem, modLayout, modules, seed = 1) {
  const rnd = rng32(seed);
  const out = new Array(problem.components.length);
  modProblem.owners.forEach((owner, o) => {
    const pl = modLayout[o];
    if (owner.component !== undefined) { const c = problem.components[owner.component]; out[owner.component] = c.fixed ? { ...c.fixed } : { ...pl }; return; }
    const m = modules[owner.module], half = 0.45 * modProblem.input.components[o].width;
    for (const i of m.members) {
      const c = problem.components[i];
      if (c.fixed) { out[i] = { ...c.fixed }; continue; }
      const [w, h] = rotatedSize(c, 0);
      const x = Math.min(problem.canvas.width - w / 2, Math.max(w / 2, pl.x + (rnd() * 2 - 1) * half));
      const y = Math.min(problem.canvas.height - h / 2, Math.max(h / 2, pl.y + (rnd() * 2 - 1) * half));
      const p = { x, y, rotation: 0 };
      if (c.sides === 'any') p.side = c.twoSided ? 0 : (pl.side ? 1 : 0);
      else if (c.sides === 'bottom') p.side = 1;
      out[i] = p;
    }
  });
  return out;
}

export const MODULE_NET_PREFIX = '~module';

/**
 * Adds one cohesion net per module (a pin at each member's centre). Use
 * `moduleNetWeight` to turn it into a per-part pull of `cohesion` toward the centroid.
 */
export function withModuleNets(input, modules) {
  const components = input.components.map((c) => ({ ...c, pins: [...c.pins] }));
  const nets = [...input.nets];
  modules.forEach((m, k) => {
    if (m.members.length < 2) return;
    const id = `${MODULE_NET_PREFIX}${k}`;
    for (const i of m.members) components[i].pins.push({ id, x: 0, y: 0 });
    nets.push({ id, pins: m.members.map((i) => ({ componentId: components[i].id, pinId: id })) });
  });
  return { ...input, components, nets };
}

export const isModuleNet = (id) => String(id).startsWith(MODULE_NET_PREFIX);

/** Global-placer net weight for a module net: every member feels `cohesion`. */
export const moduleNetWeight = (net, cohesion) => cohesion * Math.max(1, net.pins.length - 1);
