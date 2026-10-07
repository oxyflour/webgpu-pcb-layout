// Key-information ladder: how much of the human solution must Cypress be given?
// node harness/experiments/keyinfo.mjs --board pico --level ics --seed 1 --out DIR [--knobs '{"iterations":300}']
//   none      : connectivity-centroid start, nothing from the human layout
//   ics       : human pose of parts with >= minPins pins, rest at centroid
//   ics-pos   : human x,y of those parts, rotation 0
//   all       : complete human layout
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, legalize, evaluate } from '../lib/board.mjs';
import { runCypress } from '../lib/cypress.mjs';
import { startLayout } from '../lib/init.mjs';

const argv = process.argv.slice(2), arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board', 'pico'), level = arg('level', 'ics'), seed = Number(arg('seed', 1)), minPins = Number(arg('min-pins', 8));
const out = path.resolve(arg('out', 'harness/results/keyinfo')), knobs = JSON.parse(arg('knobs', '{"iterations":300,"learning_rate":0.002}'));
const b = loadBoard(board), H = b.a.originalLayout;
const plan = {};
b.p.components.forEach((c, i) => {
  if (c.fixed) return;
  if (level === 'all' || ((level === 'ics' || level === 'ics-pos' || level === 'ics-rot') && c.pins.length >= minPins))
    plan[c.id] = { x: H[i].x, y: H[i].y, rotation: level === 'ics-pos' ? 0 : H[i].rotation };
});
const mode = arg('init', 'pins-small');
const init = startLayout(b, plan, { seed, mode });
// ics-rot: additionally give every other movable part only its human rotation.
if (level === 'ics-rot') b.p.components.forEach((c, i) => { if (!c.fixed && !plan[c.id]) init[i].rotation = H[i].rotation; });
const tag = `${board}-${mode}-${level}${minPins !== 8 ? `-p${minPins}` : ''}-${seed}-${arg('tag', 'k')}`;
const railW = arg('rail-weight'), netWeights = railW === undefined ? {} : Object.fromEntries(b.p.nets.filter((n) => n.pins.length >= 20).map((n) => [n.id, Number(railW)]));
const r = await runCypress(b, { jobDir: path.join(out, tag), seed: 1000 + seed, init, knobs, netWeights });
let row = { board, level, init: mode, railWeight: railW ?? null, minPins, seed, knobs, planned: Object.keys(plan).length, movable: b.p.components.filter((c) => !c.fixed).length, status: r.status, wallS: +r.wallS.toFixed(1) };
if (r.layout) {
  const startM = evaluate(b, legalize(b, init).layout);
  const leg = legalize(b, r.layout), m = evaluate(b, leg.layout);
  row = { ...row, overflow: r.finalOverflow, legalFailed: leg.failed, start: { clean: startM.clean, vias: startM.vias, hpwlMm: startM.hpwlMm }, ...m };
  fs.writeFileSync(path.join(out, tag, 'final-layout.json'), JSON.stringify(leg.layout));
}
console.log(JSON.stringify(row));
fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
