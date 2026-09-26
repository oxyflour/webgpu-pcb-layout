// Editable module plan for a KiCad board.
//
// {
//   "format": "webgpu-pin-layout/modules@1",
//   "board": "edk.kicad_pcb",
//   "units": "mm, KiCad board coordinates",
//   "modules": [
//     { "name": "M1 U3",                  // free text
//       "components": ["U3", "R12", ...], // KiCad references (ref#index when a ref repeats)
//       "side": "auto",                   // "auto" | "top" | "bottom"
//       "region": null,                   // or {"x","y","width","height"}: pin the module there
//       "cohesion": 0.4,                  // pull of each member toward the module centroid
//       "info": { ... }                   // read-only statistics, ignored on import
//     }
//   ],
//   "unassigned": ["C45", ...],           // placed individually (informational)
//   "links": [ ... ]                      // read-only: signal nets between module pairs
// }
//
// Every movable component may appear in at most one module; fixed components are
// ignored. Components not listed anywhere are placed individually.
import { moduleStats } from '../src/optimizer/modules.js';

export const MODULES_FORMAT = 'webgpu-pin-layout/modules@1';

const round = (v, d = 2) => +v.toFixed(d);

export function exportModules(adapted, problem, plan, meta = {}) {
  const ids = problem.components.map((c) => c.id), { origin } = adapted;
  const { stats, links } = moduleStats(problem, plan.modules);
  return {
    format: MODULES_FORMAT,
    board: meta.board ?? null,
    generatedBy: meta.generatedBy ?? null,
    units: 'mm, KiCad board coordinates',
    help: 'Edit components/side/region/cohesion, then re-run place-board.mjs with --modules <this file>. "info", "links" and "unassigned" are informational.',
    modules: plan.modules.map((m, k) => ({
      name: m.name ?? `M${k + 1} ${ids[m.members[0]]}`,
      components: m.members.map((i) => ids[i]),
      side: m.side ?? 'auto',
      region: m.region ? { x: round(m.region.x + origin.x), y: round(m.region.y + origin.y), width: round(m.region.width), height: round(m.region.height) } : null,
      cohesion: m.cohesion ?? meta.cohesion ?? 0.4,
      info: { parts: stats[k].parts, 'partArea_mm2': round(stats[k].area, 1), pins: stats[k].pins, internalSignalNets: stats[k].internalNets, externalSignalNets: stats[k].externalNets },
    })),
    unassigned: (plan.unassigned ?? []).map((i) => ids[i]),
    links: links.slice(0, 200).map((l) => ({ modules: [plan.modules[l.a].name ?? `M${l.a + 1} ${ids[plan.modules[l.a].members[0]]}`, plan.modules[l.b].name ?? `M${l.b + 1} ${ids[plan.modules[l.b].members[0]]}`], signalNets: l.nets })),
  };
}

/** Validates an edited plan and converts it to component indices / canvas coordinates. */
export function importModules(json, adapted, problem) {
  if (json.format !== MODULES_FORMAT) throw new Error(`module file: expected format "${MODULES_FORMAT}", got ${JSON.stringify(json.format)}`);
  const byId = new Map(problem.components.map((c, i) => [c.id, i]));
  const errors = [], seen = new Map(), { origin } = adapted;
  const modules = (json.modules ?? []).map((m, k) => {
    const name = m.name ?? `M${k + 1}`;
    const members = [];
    for (const ref of m.components ?? []) {
      const i = byId.get(ref);
      if (i === undefined) { errors.push(`${name}: unknown component "${ref}"`); continue; }
      if (problem.components[i].fixed) continue;
      if (seen.has(i)) { errors.push(`${name}: "${ref}" is already in ${seen.get(i)}`); continue; }
      seen.set(i, name); members.push(i);
    }
    const side = m.side ?? 'auto';
    if (!['auto', 'top', 'bottom'].includes(side)) errors.push(`${name}: side must be "auto", "top" or "bottom"`);
    let region = null;
    if (m.region) {
      const { x, y, width, height } = m.region;
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) errors.push(`${name}: region needs numeric x, y, width > 0, height > 0`);
      else {
        region = { x: x - origin.x, y: y - origin.y, width, height };
        if (region.x < 0 || region.y < 0 || region.x + width > problem.canvas.width + 1e-6 || region.y + height > problem.canvas.height + 1e-6) errors.push(`${name}: region lies outside the board outline`);
      }
    }
    const cohesion = m.cohesion ?? 0.4;
    if (!Number.isFinite(cohesion) || cohesion < 0) errors.push(`${name}: cohesion must be a number >= 0`);
    return { name, members, side, region, cohesion };
  }).filter((m) => m.members.length);
  if (errors.length) throw new Error(`module file has ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
  const unassigned = problem.components.map((c, i) => i).filter((i) => !problem.components[i].fixed && !seen.has(i));
  return { modules, unassigned };
}
