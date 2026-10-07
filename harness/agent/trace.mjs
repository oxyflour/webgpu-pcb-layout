// Compact trajectory of one run: model text, tool calls and pcb results.
// node harness/agent/trace.mjs DIR [--full]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2], full = process.argv.includes('--full'), cut = (s, n) => full ? s : s.slice(0, n);
const lines = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
for (const e of lines(path.join(dir, 'events.jsonl'))) {
  const t = `${(e.t / 1000).toFixed(0).padStart(4)}s`;
  if (e.type === 'text' || e.type === 'final' || e.type === 'thinking') console.log(`${t} ${e.type}: ${cut(String(e.text).replace(/\s+/g, ' '), 600)}`);
  else if (e.type === 'tool_call') console.log(`${t} CALL ${e.tool}: ${cut(JSON.stringify(e.input), 400)}`);
  else if (e.type === 'tool_result') console.log(`${t} RESULT: ${cut(JSON.stringify(e.output ?? e.result ?? e.content ?? ''), 300)}`);
  else if (e.type === 'error') console.log(`${t} ERROR ${JSON.stringify(e)}`);
}
console.log('--- pcb calls');
for (const e of lines(path.join(dir, 'session', 'tools.jsonl'))) if (e.type === 'result') {
  const r = e.result, m = r.metrics;
  console.log(`${e.command} ${e.seconds.toFixed(1)}s ${r.error ? 'ERROR ' + r.error : m ? `${r.candidate} cypress=${r.cypress} clean=${m.clean}/${m.nets} vias=${m.vias} hpwl=${m.hpwlMm} drift=${JSON.stringify(r.plannedDriftMm ?? {})}` : cut(JSON.stringify(r), 200)}`);
}
