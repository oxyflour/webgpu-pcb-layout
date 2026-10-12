// Review pages for the current results: per board one experiments/review-html.mjs page (whole board,
// largest IC highlighted) with the human layout, the no-agent tool layout, the best agent session of
// each listed sweep, and a notes table (5-phase medians, decaps to their assigned IC, critical nets);
// plus index.html. Pages are local files (results are git-ignored).
// node harness/experiments/review-sweep.mjs --out harness/results/review-v13 [--boards a,b] [--tool sweep-eval-v13] [--agents v12s,v13c]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBoard, evaluateRobust, toolRouting, exactRouting, needsFastRouting, EVAL_BOARDS } from '../lib/board.mjs';
import { loadConstraints, evalConstraints } from '../lib/constraints.mjs';
import { HARNESS_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const R = path.join(HARNESS_ROOT, 'results'), out = path.resolve(arg('out')), toolDir = arg('tool', 'sweep-eval-v13'), agents = arg('agents', 'v12s,v13c').split(',');
const ALL = EVAL_BOARDS;
const LABEL = { v12s: 'agent v12, best of 3', v13c: 'agent v13 + example constraints, best of 3', v12d: 'agent v12 + decap term, best of 3' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
fs.mkdirSync(out, { recursive: true });
const index = [];
for (const board of (arg('boards') ?? ALL.join(',')).split(',')) {
  const b = loadBoard(board), C = loadConstraints(b), comps = b.p.components;
  const ic = comps.map((c, i) => [c.pins.length, i]).filter(([, i]) => !comps[i].fixed).sort((x, y) => y[0] - x[0])[0][1];
  const items = [{ name: 'human', file: 'human' }];
  const tf = path.join(R, toolDir, 'tool', `${board}-1000.json`); if (fs.existsSync(tf)) items.push({ name: 'no agent (current tool)', file: tf });
  for (const pre of agents) {
    const reps = [1, 2, 3].map((r) => path.join(R, `${pre}-${board}`, `rep${r}`)).filter((d) => fs.existsSync(path.join(d, 'summary.json')));
    if (!reps.length) continue;
    const best = reps.map((d) => ({ d, f: JSON.parse(fs.readFileSync(path.join(d, 'summary.json'), 'utf8')).final })).sort((x, y) => y.f.clean - x.f.clean || x.f.vias - y.f.vias)[0];
    const s = JSON.parse(fs.readFileSync(path.join(best.d, 'session', 'session.json'), 'utf8')), cf = path.join(best.d, 'session', 'candidates', `${s.submitted ?? s.best}.json`);
    const lf = path.join(out, 'layouts', `${board}-${pre}.json`); fs.mkdirSync(path.dirname(lf), { recursive: true }); fs.writeFileSync(lf, JSON.stringify(JSON.parse(fs.readFileSync(cf, 'utf8')).layout));
    items.push({ name: `${LABEL[pre] ?? `agent ${pre}, best of 3`} (${path.basename(best.d)})`, file: lf });
  }
  // Notes: robust metrics of every layout.
  const rows = [];
  for (const it of items) {
    const L = it.file === 'human' ? b.a.originalLayout : JSON.parse(fs.readFileSync(it.file, 'utf8'));
    const m = await evaluateRobust(b, L, { detail: true, ...(needsFastRouting(b) ? toolRouting(b) : exactRouting()) }), e = evalConstraints(b, L, C, m.perNet);
    rows.push({ name: it.name, clean: m.clean, nets: m.nets, vias: m.vias, hpwl: Math.round(m.hpwlMm), dmed: e.decap.medianMm, d3: e.decap.within3mm, cvias: e.critical.reduce((a, c) => a + c.vias, 0), clen: Math.round(e.critical.reduce((a, c) => a + c.lengthMm, 0)) });
  }
  const notes = `<div class="card"><h3>${esc(board)}: metrics (median of ${needsFastRouting(b) ? 3 : 5} grid phases; the panes show grid phase 0)</h3><table><thead><tr><th>Layout</th><th>Clean nets (count of ${rows[0].nets})</th><th>Vias (count)</th><th>HPWL (mm)</th><th>Decaps to their assigned IC, median (mm; ${C.decaps.length} decaps)</th><th>Decaps within 3 mm of their IC (share)</th><th>Critical nets: vias (count; ${C.critical.length} entries)</th><th>Critical nets: routed length (mm)</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.clean}</td><td>${r.vias}</td><td>${r.hpwl}</td><td>${r.dmed ?? '-'}</td><td>${r.d3 ?? '-'}</td><td>${r.cvias}</td><td>${r.clen}</td></tr>`).join('')}</tbody></table></div>`;
  const nf = path.join(out, 'notes', `${board}.html`); fs.mkdirSync(path.dirname(nf), { recursive: true }); fs.writeFileSync(nf, notes);
  const page = path.join(out, `${board}.html`), win = needsFastRouting(b) ? 60 : Math.ceil(Math.max(b.p.canvas.width, b.p.canvas.height));
  const r = spawnSync(process.execPath, [path.join(HARNESS_ROOT, 'experiments', 'review-html.mjs'), '--board', board, '--ic', comps[ic].id, '--window', String(win), '--out', page, '--notes', nf, ...items.map((it) => `${it.name}=${it.file}`)], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) { console.log(board, 'FAILED', r.stderr.slice(-500)); continue; }
  console.log(board, r.stdout.trim().split('\n').at(-1));
  index.push({ board, ic: comps[ic].id, rows, file: `${board}.html` });
}
// Merge with the boards already in this directory's index (one board per run of eval-board).
const idxFile = path.join(out, 'index.json'), old = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : [];
const merged = [...old.filter((x) => !index.some((y) => y.board === x.board)), ...index].sort((x, y) => ALL.indexOf(x.board) - ALL.indexOf(y.board));
fs.writeFileSync(idxFile, JSON.stringify(merged)); index.splice(0, index.length, ...merged);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Layout review</title>
<style>:root{--bg:#f7f7f5;--ink:#1d1d1b;--muted:#6b6b66;--line:#dcdcd6}@media (prefers-color-scheme:dark){:root{--bg:#161614;--ink:#ecebe6;--muted:#a3a29b;--line:#34342f}}
body{background:var(--bg);color:var(--ink);font:14px system-ui,sans-serif;margin:0;padding:16px;max-width:1200px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}th{color:var(--muted);font-weight:600}a{color:inherit}.wrap{overflow-x:auto}</style></head><body>
<h1>Layout review (${new Date().toISOString().slice(0, 10)})</h1><p>One page per board: human, no agent (current tool: start layout, legalizer, detail pass with decaps assigned by schematic sheet), best agent session per run. Metrics are medians over grid phases; pages show phase 0.</p>
<div class="wrap"><table><thead><tr><th>Board (page)</th><th>Highlighted IC</th><th>Layout</th><th>Clean nets (count)</th><th>Vias (count)</th><th>HPWL (mm)</th><th>Decaps to assigned IC, median (mm)</th><th>Critical nets: vias (count)</th></tr></thead><tbody>
${index.map((x) => x.rows.map((r, k) => `<tr>${k ? '<td></td><td></td>' : `<td><a href="${x.file}">${esc(x.board)}</a></td><td>${esc(x.ic)}</td>`}<td>${esc(r.name)}</td><td>${r.clean} / ${r.nets}</td><td>${r.vias}</td><td>${r.hpwl}</td><td>${r.dmed ?? '-'}</td><td>${r.cvias}</td></tr>`).join('')).join('\n')}
</tbody></table></div></body></html>`;
fs.writeFileSync(path.join(out, 'index.html'), html); console.log(path.join(out, 'index.html'));
