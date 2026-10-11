// Agent-side client: `pcb <command> [flags]`. Sends one JSON request to the gateway that the
// runner started outside the dsh sandbox (PCB_TOOL_URL / PCB_TOOL_TOKEN). No local compute.
import fs from 'node:fs';

const HELP = `pcb <command> [flags]
  pcb info                                  board summary, fixed parts, human-level target
  pcb info --section ics [--page N]         all ICs (>= 8 signal pins) and their links to connectors/ICs
  pcb info --section parts [--page N]       movable parts (60 per page, most pins first)
  pcb info --section nets [--page N]        signal nets and their pins (ref.pinId)
  pcb info --section part --refs U1,U2      pads (local coords + net) and strongest neighbours
  pcb info --section constraints            decap -> IC assignment, critical nets and their limits
  pcb map [--candidate c003]                ASCII floorplan of both sides (keepouts, fixed parts, candidate)
  pcb check --input plan.json               fast: are the planned spots free? (no detail pass, no routing)
  pcb place --input plan.json               start layout -> legalize -> detail pass -> route; makes a candidate
  pcb inspect [--candidate c003] [--refs U1,R5 | --refs all] [--nets failed | --nets fragile | --nets N1,N2] [--congestion 1]
                                            --congestion 1: routing margin, 10 most congested areas and their parts, fragile nets
  pcb status                                candidates, best, target
  pcb submit --candidate c003               choose the final layout

plan.json for place (all fields optional):
  {"from": "centroid" | "c003",             start: connectivity centroid, or an existing candidate
   "plan": {"U1": {"x": 40, "y": 20, "rotation": 1}},   explicit start poses (mm, quarter turns)
   "seed": 7}`;

const argv = process.argv.slice(2), command = argv[0];
if (!command || command === 'help' || command === '--help') { console.log(HELP); process.exit(0); }
const allowed = { info: ['section', 'page', 'refs'], map: ['candidate'], check: ['input'], place: ['input'], inspect: ['candidate', 'refs', 'nets', 'congestion'], status: [], submit: ['candidate'] };
if (!allowed[command]) { console.log(JSON.stringify({ error: `unknown command ${command}` }) + '\n' + HELP); process.exit(2); }
const flags = {};
for (let k = 1; k < argv.length; k += 2) {
  const f = argv[k];
  if (!f.startsWith('--') || !allowed[command].includes(f.slice(2)) || argv[k + 1] === undefined || f.slice(2) in flags) {
    console.log(JSON.stringify({ error: `bad argument ${f} for ${command}; allowed flags: ${allowed[command].map((x) => '--' + x).join(' ') || 'none'}` })); process.exit(2);
  }
  flags[f.slice(2)] = argv[k + 1];
}
let input = {};
if (flags.input) {
  try { input = JSON.parse(fs.readFileSync(flags.input, 'utf8')); } catch (e) { console.log(JSON.stringify({ error: `cannot read JSON from ${flags.input}: ${e.message}` })); process.exit(2); }
} else {
  if (flags.section) input.section = flags.section;
  if (flags.page) input.page = Number(flags.page);
  if (flags.candidate) input.candidate = flags.candidate;
  if (flags.refs) input.refs = flags.refs === 'all' ? 'all' : flags.refs.split(',').map((s) => s.trim()).filter(Boolean);
  if (flags.congestion) input.congestion = flags.congestion !== '0';
  if (flags.nets) input.nets = flags.nets === 'failed' || flags.nets === 'fragile' ? flags.nets : flags.nets.split(',').map((s) => s.trim()).filter(Boolean);
}
const res = await fetch(process.env.PCB_TOOL_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.PCB_TOOL_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ command, input }), signal: AbortSignal.timeout(172000) }).catch((e) => ({ text: async () => JSON.stringify({ error: `gateway: ${e.message}` }) }));
console.log(await res.text());
