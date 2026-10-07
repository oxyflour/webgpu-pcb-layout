// Three independent dsh sessions (rep1..rep3) on one board and prompt, run in parallel.
// node harness/agent/batch.mjs --board pico --prompt harness/prompts/v1.md --minutes 20 --places 8 --out DIR
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const board = arg('board', 'pico'), out = path.resolve(arg('out', `harness/results/batch-${board}-${Date.now()}`)), reps = Number(arg('reps', 3));
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'batch.json'))) throw new Error('batch exists; choose a new --out');
const pass = ['prompt', 'minutes', 'places'].flatMap((k) => arg(k) ? [`--${k}`, arg(k)] : []);
const results = await Promise.all(Array.from({ length: reps }, (_, r) => new Promise((resolve) => {
  const dir = path.join(out, `rep${r + 1}`), log = fs.openSync(path.join(out, `rep${r + 1}.log`), 'w');
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'run-agent.mjs'), '--board', board, '--out', dir, '--seed', String(r + 1), ...pass], { stdio: ['ignore', log, log], windowsHide: true });
  child.on('close', (code) => { fs.closeSync(log); try { resolve({ rep: r + 1, ...JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) }); } catch { resolve({ rep: r + 1, error: `exit ${code}, no summary` }); } });
})));
const pick = (k) => results.map((r) => r.final?.[k] ?? null);
const summary = { board, out, args: pass, target: results.find((r) => r.target)?.target, clean: pick('clean'), vias: pick('vias'), hpwlMm: pick('hpwlMm'), legal: pick('legal'), reps: results };
fs.writeFileSync(path.join(out, 'batch.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ board, target: summary.target, clean: summary.clean, vias: summary.vias, hpwlMm: summary.hpwlMm, legal: summary.legal, stops: results.map((r) => r.stopReason ?? r.error) }));
