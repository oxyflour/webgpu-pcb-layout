// End-to-end evaluation of one board (see skills/pcb-eval/SKILL.md). Steps, each skipped when its
// output exists (rerun = resume):
//   1. load + human reference (5 grid phases) and the constraint template harness/constraints/<board>.template.json
//   2. no-agent tool layouts, seeds 1000 / 8919 / 16838            -> results/<tag>/tool/<board>-<seed>.json
//   3. agent sessions (3 dsh, --minutes / --places), unless --no-agent -> results/<tag>s-<board>/
//   4. scoring at 8 independent grid offsets (sweep-eval)           -> results/<tag>/rows.jsonl
//   5. decap / critical-net constraints (constraints-eval)          -> results/<tag>/constraints.jsonl
//   6. review page + index (review-sweep)                           -> results/review-<tag>/<board>.html
// Prints the board's rows of the summary tables at the end.
// node harness/experiments/eval-board.mjs --board NAME [--tag eval] [--prompt harness/prompts/v14.md] [--minutes 20] [--places 12] [--no-agent] [--constraints-dir DIR]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBoard, evaluateRobust, toolRouting, exactRouting, needsFastRouting, legalOk, placementMetrics } from '../lib/board.mjs';
import { loadConstraints, constraintsTemplate } from '../lib/constraints.mjs';
import { HARNESS_ROOT, REPO_ROOT } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board'), tag = arg('tag', 'eval'), R = path.join(HARNESS_ROOT, 'results'), X = path.join(HARNESS_ROOT, 'experiments');
if (!board) throw new Error('--board NAME (registered in harness/boards.json or the adapter KiCad cases)');
const env = { ...process.env, ...(arg('constraints-dir') ? { PCB_CONSTRAINTS_DIR: path.resolve(arg('constraints-dir')) } : {}) };
const step = (title, args) => { console.log(`\n== ${title}\n$ node ${args.map((a) => a.includes(' ') ? `"${a}"` : a).join(' ')}`); const t = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, stdio: 'inherit' }); if (r.status !== 0) throw new Error(`${title} failed (exit ${r.status})`); console.log(`(${Math.round((Date.now() - t) / 1000)} s)`); };

// 1. Load, human reference, constraint template.
const b = loadBoard(board), C = loadConstraints(b), H = b.a.originalLayout;
const hm = await evaluateRobust(b, H, needsFastRouting(b) ? toolRouting(b) : exactRouting()), g = placementMetrics(b, H).geometry;
console.log(JSON.stringify({ board, format: b.format, file: b.file, parts: b.p.components.length, movable: b.p.components.filter((c) => !c.fixed).length, nets: b.p.nets.length, layers: b.a.routing.layers,
  human: { clean: hm.clean, vias: hm.vias, hpwlMm: hm.hpwlMm, legal: legalOk({ geometry: g }), overlaps: g.overlaps }, decaps: C.decaps.length, decapsFromSheet: C.decaps.filter((d) => d.source === 'sheet').length, critical: C.critical.map((c) => c.name) }));
const tpl = path.join(HARNESS_ROOT, 'constraints', `${board}.template.json`);
if (!fs.existsSync(tpl)) { fs.writeFileSync(tpl, JSON.stringify(constraintsTemplate(b, C), null, 1)); console.log(`constraint template: ${tpl} (copy to ${board}.json and edit to set limits)`); }

// 2-6.
step('no-agent tool layouts', [path.join(X, 'noagent.mjs'), '--boards', board, '--out', path.join(R, tag, 'tool')]);
if (!argv.includes('--no-agent')) {
  const out = path.join(R, `${tag}s-${board}`);
  if (!fs.existsSync(path.join(out, 'batch.json'))) step('agent sessions', [path.join(HARNESS_ROOT, 'agent', 'batch.mjs'), '--board', board, '--prompt', arg('prompt', path.join(HARNESS_ROOT, 'prompts', 'v14.md')), '--minutes', arg('minutes', '20'), '--places', arg('places', '12'), '--out', out]);
}
step('scoring (8 grid offsets)', [path.join(X, 'sweep-eval.mjs'), '--dir', tag, '--agent', `${tag}s`, '--boards', board, '--jobs', '6']);
step('constraints', [path.join(X, 'constraints-eval.mjs'), '--out', path.join(R, tag, 'constraints.jsonl'), '--dir', tag, '--agent', `${tag}s`, '--boards', board]);
step('review page', [path.join(X, 'review-sweep.mjs'), '--out', path.join(R, `review-${tag}`), '--tool', tag, '--agents', `${tag}s`, '--boards', board]);
// Summary rows of this board.
const show = (args) => { const r = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, encoding: 'utf8' }); for (const l of r.stdout.split('\n')) if (l.startsWith('| Board') || l.startsWith('|---') || l.startsWith(`| ${board} `)) console.log(l); console.log(''); };
console.log('\n== summary');
show([path.join(X, 'sweep-eval.mjs'), '--dir', tag, '--agent', `${tag}s`, '--name', tag, '--tool-label', 'start + detail', '--summary']);
show([path.join(X, 'constraints-eval.mjs'), '--out', path.join(R, tag, 'constraints.jsonl'), '--summary']);
console.log(`review page: ${path.join(R, `review-${tag}`, `${board}.html`)}`);
