// Print rows.jsonl of an experiment directory as a table.
import fs from 'node:fs';
for (const f of process.argv.slice(2)) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(l);
  console.log([r.board, r.level ?? r.variant, r.init ?? '', r.minPins ?? '', 's' + r.seed, r.status, r.wallS + 's', 'start', r.start ? `${r.start.clean}/${r.start.vias}/${Math.round(r.start.hpwlMm)}` : '-', '=> clean', `${r.clean}/${r.nets}`, 'vias', r.vias, 'hpwl', Math.round(r.hpwlMm), 'ovl', r.geometry?.overlaps, JSON.stringify(r.knobs ?? '')].join(' '));
}
