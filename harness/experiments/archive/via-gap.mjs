// Where is the via gap between agent layouts and the human layout? Reads the per-net CSV of
// export-review.mjs and the layouts, and groups the per-net via difference (mean over the agent
// runs minus human, layer steps) by net kind, by the IC that anchors the net and by HPWL change.
// node harness/experiments/via-gap.mjs --board ppc-n3 --dir DIR --human human --runs v7-rep1,v7-rep2,v7-rep3
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard, worldPin } from '../../lib/board.mjs';
import { buildModules } from './lib/modules.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board', 'ppc-n3')), dir = arg('dir'), human = arg('human', 'human'), runs = arg('runs').split(',');
const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const layoutOf = (name) => { const s = m.layouts.find((x) => x.layout === name).source; return s === 'human' ? b.a.originalLayout : JSON.parse(fs.readFileSync(s, 'utf8')); };
const lines = fs.readFileSync(path.join(dir, `${b.name}-nets.csv`), 'utf8').trim().split('\n');
const split = (l) => { const o = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; };
const head = split(lines[0]), rows = lines.slice(1).map(split);
const col = (name, what) => head.indexOf(`${name}: ${what}`);
const C = b.p.components, nets = b.p.nets, { owner, isIc } = buildModules(b);
const hpwl = (L, n) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const pi of nets[n].pins) { const [x, y] = worldPin(b.p, L, pi); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 - x0 + y1 - y0; };
const LH = layoutOf(human), LR = runs.map(layoutOf);
const per = nets.map((n, i) => {
  const r = rows[i]; if (r[0] !== n.id) throw new Error('net order');
  const hv = Number(r[col(human, 'vias, layer steps (count)')]), av = runs.map((x) => Number(r[col(x, 'vias, layer steps (count)')]));
  const hs = Number(r[col(human, 'vias, physical (count)')]), as = runs.map((x) => Number(r[col(x, 'vias, physical (count)')]));
  const comps = [...new Set(n.pins.map((pi) => b.p.pins[pi].componentIndex))];
  const ics = comps.filter((c) => isIc[c]), fixed = comps.filter((c) => C[c].fixed);
  // Anchor: the IC with most pins on the net, else a fixed part, else the module owner of a member.
  const pinsOn = (c) => n.pins.filter((pi) => b.p.pins[pi].componentIndex === c).length;
  const anchor = ics.sort((a, c) => pinsOn(c) - pinsOn(a))[0] ?? fixed[0] ?? comps.map((c) => owner[c]).find((o) => o >= 0) ?? -1;
  const kind = ics.length >= 2 ? 'IC-IC' : ics.length === 1 && fixed.length ? 'IC-fixed' : ics.length === 1 ? 'IC-local' : fixed.length ? 'fixed-local' : 'small parts only';
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  return { net: n.id, parts: comps.length, kind, anchor: anchor >= 0 ? C[anchor].id : '-', dv: mean(av) - hv, ds: mean(as) - hs, hv, av: mean(av), dh: mean(LR.map((L) => hpwl(L, i))) - hpwl(LH, i) };
});
const group = (key) => { const g = new Map(); for (const p of per) { const k = key(p); const e = g.get(k) ?? { k, nets: 0, human: 0, runs: 0, dv: 0, ds: 0, dh: 0 }; e.nets++; e.human += p.hv; e.runs += p.av; e.dv += p.dv; e.ds += p.ds; e.dh += p.dh; g.set(k, e); } return [...g.values()].sort((a, c) => c.dv - a.dv); };
const r1 = (v) => Math.round(v * 10) / 10;
const table = (title, keyName, g, top = 999) => [`### ${title}`, '', `| ${keyName} | Signal nets (count) | Human: vias, layer steps (count) | Agent mean: vias, layer steps (count) | Via gap, layer steps (count, agent - human) | Via gap, physical (count) | HPWL change (mm, agent - human) |`, '|---|---|---|---|---|---|---|',
  ...g.slice(0, top).map((e) => `| ${e.k} | ${e.nets} | ${r1(e.human)} | ${r1(e.runs)} | ${r1(e.dv)} | ${r1(e.ds)} | ${r1(e.dh)} |`), ''].join('\n');
const total = per.reduce((s, p) => s + p.dv, 0);
const size = (p) => p.parts === 2 ? '2 parts' : p.parts <= 5 ? '3-5 parts' : p.parts <= 30 ? '6-30 parts' : '> 30 parts';
const hp = (p) => p.dh < -2 ? 'HPWL shorter by > 2 mm' : p.dh <= 2 ? 'HPWL within 2 mm' : p.dh <= 20 ? 'HPWL longer by 2-20 mm' : 'HPWL longer by > 20 mm';
const top = [...per].sort((a, c) => c.dv - a.dv).slice(0, 25);
const md = [`# Via gap, ${b.name}: ${runs.join(', ')} vs ${human}`, '', `Total via gap (layer steps, mean over runs): ${r1(total)}. Routing: exact router, grid phase 0.`, '',
  table('By net kind', 'Net kind', group((p) => p.kind)),
  table('By number of parts on the net', 'Parts on net', group(size)),
  table('By HPWL change of the net', 'HPWL change', group(hp)),
  table('By anchoring IC (top 20 by via gap)', 'Anchor part', group((p) => p.anchor), 20),
  '### Nets with the largest via gap', '', '| Net | Kind | Anchor | Parts on net (count) | Human: vias, layer steps (count) | Agent mean: vias, layer steps (count) | HPWL change (mm) |', '|---|---|---|---|---|---|---|',
  ...top.map((p) => `| ${p.net} | ${p.kind} | ${p.anchor} | ${p.parts} | ${p.hv} | ${r1(p.av)} | ${r1(p.dh)} |`), ''].join('\n');
fs.writeFileSync(path.join(dir, 'via-gap.md'), md);
console.log(md);
