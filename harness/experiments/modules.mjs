// Module split, key-information test without the agent (AGENTS.md: confirm the information helps
// before asking the agent to derive it). All levels get the human IC poses (what the agent plans);
// modules are lib/modules.mjs (netlist only).
//   ics        : rest from the tool init (pins-small), then global Cypress        (current tool)
//   mod-human  : + module members at their human pose                           (upper bound)
//   mod-tool   : + module members from one Cypress job per module (sub-board of the IC and its
//                members, IC locked at its planned pose), legalized inside the module
// --no-global: skip the global Cypress pass (start layout -> legalizer -> evaluation).
// --large-ic: start layout with the large-IC rules (lib/init.mjs placeNearLargeICs).
// Scored with evaluateRobust (median over grid phases, exact routing).
// node harness/experiments/modules.mjs --board ppc-n3 --level mod-tool --seed 1 --out DIR [--no-global] [--module-budget 60]
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluateRobust, legalOk, needsFastRouting, exactRouting } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';
import { buildModules } from '../lib/modules.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board'), level = arg('level', 'ics'), seed = Number(arg('seed', 1)), global = !argv.includes('--no-global');
const out = path.resolve(arg('out', 'harness/results/modules')), moduleBudget = Number(arg('module-budget', 150));
const b = loadBoard(board), H = b.a.originalLayout, C = b.p.components, largeIc = argv.includes('--large-ic');
const { modules } = buildModules(b);
const pose = (L, i) => ({ x: L[i].x, y: L[i].y, rotation: L[i].rotation });
const plan = {};
for (const ic of modules.keys()) plan[C[ic].id] = pose(H, ic);
const tag = `${board}-${level}${largeIc ? '-largeic' : ''}${global ? '' : '-noglobal'}-${seed}`, dir = path.join(out, tag);
fs.mkdirSync(dir, { recursive: true });
const t0 = performance.now();
let moduleInfo = null;
if (level === 'mod-human') for (const ms of modules.values()) for (const i of ms) plan[C[i].id] = pose(H, i);
if (level === 'mod-tool' || level === 'mod-context') {
  // mod-context: the sub-board also holds every part outside the module that shares a signal net
  // (<= 30 parts) with a member, locked at its pose in the tool's start layout (human IC poses +
  // pins-small init, i.e. the baseline's own start), so members feel their external links.
  const side = (i) => C[i].sides === 'bottom' ? 1 : 0;
  const base = level === 'mod-context' ? startLayout(b, plan, { seed }) : null;
  const partners = Array.from({ length: C.length }, () => new Set());
  for (const net of b.p.nets) {
    const cs = [...new Set(net.pins.map((pi) => b.p.pins[pi].componentIndex))];
    if (cs.length >= 2 && cs.length <= 30) for (const a of cs) for (const c of cs) if (a !== c) partners[a].add(c);
  }
  // Module layouts depend on the IC poses and the seed only: cached per seed next to the results.
  const cache = path.join(out, `${board}-${level}-${seed}.json`);
  if (fs.existsSync(cache)) moduleInfo = JSON.parse(fs.readFileSync(cache, 'utf8'));
  else {
    const job = async ([ic, ms]) => {
      const ref = C[ic].id, inModule = new Set([ic, ...ms]);
      const context = base ? [...new Set(ms.flatMap((i) => [...partners[i]]))].filter((j) => !inModule.has(j)) : [];
      const locks = { [ref]: { ...pose(H, ic), side: side(ic) } };
      for (const j of context) if (!C[j].fixed) locks[C[j].id] = { ...pose(base, j), side: side(j) };
      const sub = loadBoard(board, { only: new Set([...inModule, ...context].map((i) => C[i].id)), locks });
      const init = startLayout(sub, {}, { seed });
      // A failed job (timeout, NaN output, ...) keeps the start positions of its members.
      let r;
      try { r = await runCypress(sub, { jobDir: path.join(out, 'module-jobs', `${board}-${level}-${seed}-${ref}`), seed: 1000 + seed, init, budgetS: moduleBudget }); } catch (e) { r = { status: 'error', error: e.message, wallS: 0 }; }
      const L = r.layout ? legalize(sub, r.layout).layout : init;
      const members = new Set(ms.map((i) => C[i].id));
      return { ref, members: ms.length, context: context.length, status: r.status, wallS: Math.round(r.wallS), poses: Object.fromEntries(sub.p.components.map((c, i) => [c.id, pose(L, i)]).filter(([id]) => members.has(id))) };
    };
    // At most 3 module jobs at a time (the Cypress slots); more made them time out waiting.
    const queue = [...modules].filter(([, ms]) => ms.length);
    moduleInfo = [];
    await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length) moduleInfo.push(await job(queue.shift())); }));
    fs.writeFileSync(cache, JSON.stringify(moduleInfo));
  }
  for (const m of moduleInfo) Object.assign(plan, m.poses);
}
const moduleS = (performance.now() - t0) / 1000;
const init = startLayout(b, plan, { seed, largeIc });
let L = init, cy = null;
if (global) {
  const r = await runCypress(b, { jobDir: path.join(dir, 'global'), seed: 1000 + seed, init, budgetS: needsFastRouting(b) ? 80 : 150 });
  cy = { status: r.status, wallS: Math.round(r.wallS) };
  if (!r.layout) { console.log(JSON.stringify({ tag, error: r.status })); process.exit(1); }
  L = r.layout;
}
const leg = legalize(b, L);
fs.writeFileSync(path.join(dir, 'final-layout.json'), JSON.stringify(leg.layout));
const m = await evaluateRobust(b, leg.layout, exactRouting());
const { perNet, ...metrics } = m;
// Drift of module members from their pose in the start layout (does the global pass keep it?).
const members = [...modules.values()].flat(), drift = members.map((i) => Math.hypot(leg.layout[i].x - init[i].x, leg.layout[i].y - init[i].y)).sort((a, c) => a - c);
const row = { board, level, largeIc, global, seed, planned: Object.keys(plan).length, modules: modules.size, members: members.length,
  moduleJobs: moduleInfo && { n: moduleInfo.length, statuses: moduleInfo.reduce((s, x) => ({ ...s, [x.status]: (s[x.status] ?? 0) + 1 }), {}), seconds: Math.round(moduleS) },
  cypress: cy, legalizerFailed: leg.failed, memberDriftMm: { p50: +drift[drift.length >> 1].toFixed(2), p90: +drift[Math.floor(0.9 * (drift.length - 1))].toFixed(2) },
  legal: legalOk(m), clean: m.clean, nets: m.nets, vias: m.vias, viaSites: m.viaSites, hpwlMm: m.hpwlMm, noise: m.noise, routeConverged: m.routeConverged };
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
