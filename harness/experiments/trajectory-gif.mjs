// Animated GIF of one agent session: one frame per candidate in creation order (c000 = tool baseline),
// the candidate next to the human layout at the same scale, the parts the agent placed in this call
// (its plan, when they differ from the `from` candidate by > 0.5 mm or a turn) outlined in red, its metrics and the best so far, the vias of every
// candidate as a bar chart, and the agent's last message before the place call. Last frame: the
// submitted candidate. Exports the frames as JSON, then harness/experiments/trajectory_gif.py (Pillow)
// draws them.
// node harness/experiments/trajectory-gif.mjs --run harness/results/v16s-k60/rep1 --out k60-rep1.gif [--title "..."] [--ms 1200]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBoard, rotatedSize } from '../lib/board.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const run = path.resolve(arg('run')), out = path.resolve(arg('out')), S = path.join(run, 'session');
const session = JSON.parse(fs.readFileSync(path.join(S, 'session.json'), 'utf8')), b = loadBoard(session.board), C = b.p.components;
const lines = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

// Agent message before each place call (events.jsonl), matched in order with the place calls of tools.jsonl
// (c000 is made by run-agent before the agent starts, so it has no message).
const ev = lines(path.join(run, 'events.jsonl')), said = [];
let last = '', thought = '';   // the agent's message, else the end of its reasoning (marked "thinking:")
for (const e of ev) {
  if (e.type === 'text' && e.text?.trim()) last = e.text.trim();
  if (e.type === 'thinking' && e.text?.trim()) thought = e.text.trim();
  if (e.type === 'tool_call' && /\bplace\b/.test(e.input?.command ?? '') && !/--help/.test(e.input?.command ?? '')) {
    said.push(last || (thought ? `thinking: …${thought.replace(/\s+/g, ' ').slice(-300)}` : '')); last = ''; thought = ''; }
}
const ids = lines(path.join(S, 'tools.jsonl')).filter((e) => e.type === 'result' && e.command === 'place' && e.result?.candidate).map((e) => e.result.candidate);
const pose = (q) => [q.x, q.y, q.rotation, q.side ? 1 : 0];
const cands = ids.map((id) => JSON.parse(fs.readFileSync(path.join(S, 'candidates', `${id}.json`), 'utf8')));
const byId = new Map(cands.map((c) => [c.id, c]));
const idx = new Map(C.map((c, i) => [c.id, i]));
const moved = (c) => { const f = byId.get(c.from), mine = Object.keys(c.plan ?? {}).map((r) => idx.get(r)).filter((i) => i != null); if (!f) return mine; return mine.filter((i) => (Math.hypot(c.layout[i].x - f.layout[i].x, c.layout[i].y - f.layout[i].y) > 0.5 || c.layout[i].rotation !== f.layout[i].rotation)); };
let k = 0;
const frames = cands.map((c) => ({ id: c.id, from: c.from, label: c.label ?? '', said: c.id === 'c000' ? '' : (said[k++] ?? ''), planned: Object.keys(c.plan ?? {}), metrics: { clean: c.metrics.clean, nets: c.metrics.nets, vias: c.metrics.vias, hpwlMm: c.metrics.hpwlMm }, layout: c.layout.map(pose), moved: moved(c) }));
const summary = fs.existsSync(path.join(run, 'summary.json')) ? JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8')) : {};
const data = {
  title: arg('title', `${session.board} · ${path.basename(path.dirname(run))}/${path.basename(run)}`),
  ms: Number(arg('ms', 1200)), W: b.p.canvas.width, H: b.p.canvas.height,
  parts: C.map((c) => ({ ref: c.id, w: c.width, h: c.height, fixed: !!c.fixed, big: c.pins.length >= 8, size: rotatedSize(c, 0) })),
  human: { layout: b.a.originalLayout.map(pose), vias: session.target?.vias ?? summary.target?.vias, clean: session.target?.clean ?? summary.target?.clean },
  submitted: session.submitted, frames,
};
const tmp = path.join(os.tmpdir(), `traj-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify(data));
const py = process.platform === 'win32' ? 'python' : 'python3', r = spawnSync(py, [path.join(import.meta.dirname, 'trajectory_gif.py'), tmp, out], { stdio: 'inherit' });
fs.rmSync(tmp, { force: true });
process.exit(r.status ?? 1);
