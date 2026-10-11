// Route one layout with FreeRouting (headless, Java container) on the DSN export of the harness
// routing problem, score the session independently (lib/ses.mjs), and append one JSON row.
// node harness/experiments/freerouting.mjs --board k60 --layout human|legal|FILE --out FILE
//   [--passes 100] [--threads 4] [--timeout 1800] [--tag name] [--jitter mm --seed k] [--width/--clearance/--via mm]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBoard, legalize } from '../lib/board.mjs';
import { exportDsn } from '../lib/dsn.mjs';
import { scoreSes } from '../lib/ses.mjs';
import { HARNESS_ROOT, FREEROUTING_DIR, required } from '../lib/env.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const board = arg('board'), src = arg('layout', 'human'), out = arg('out'), passes = Number(arg('passes', 100)), threads = Number(arg('threads', 4));
const timeoutS = Number(arg('timeout', 1800)), seed = Number(arg('seed', 0)), jitter = Number(arg('jitter', 0));
const FR_DIR = required(FREEROUTING_DIR, 'freeroutingDir', 'FREEROUTING_DIR', 'directory of the FreeRouting jar'), JAR = process.env.FREEROUTING_JAR ?? 'freerouting-2.5.0.jar';
const IMAGE = process.env.FREEROUTING_IMAGE ?? 'eclipse-temurin:25-jre';

const b = loadBoard(board);
let L = src === 'human' || src === 'legal' ? b.a.originalLayout.map((l) => ({ ...l })) : JSON.parse(fs.readFileSync(src, 'utf8'));
if (src === 'legal') L = legalize(b, L).layout;
if (jitter && seed) {
  let x = (seed * 2654435761) >>> 0 || 1; const R = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  L = L.map((l, i) => b.p.components[i].fixed ? l : { ...l, x: l.x + (2 * R() - 1) * jitter, y: l.y + (2 * R() - 1) * jitter });
}
// Design rules: the board's own default class (adapter routing.rules) when known; ppc has none in the
// adapter, its KiCad file uses 0.08-0.15 mm tracks and 0.5 mm through vias -> 0.1 / 0.1 / 0.5 mm.
const br = b.a.routing.rules, def = br ? { width: br.trace, clearance: br.clearance, via: br.via } : { width: 0.1, clearance: 0.1, via: 0.5 };
const rules = { width: Number(arg('width', def.width)), clearance: Number(arg('clearance', def.clearance)), via: Number(arg('via', def.via)) };
const dsn = exportDsn(b, L, { ...rules, viaDrill: rules.via / 2 });
const tag = arg('tag', `${board}-${path.basename(path.dirname(src)) || src}-${seed}-${process.pid}`);
const work = path.join(HARNESS_ROOT, 'results', 'freerouting', 'work', tag);
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, 'board.dsn'), dsn.text);
const t = performance.now();
const r = spawnSync('docker', ['run', '--rm', '--name', `fr-${tag}`.replace(/[^\w.-]/g, '_'), '--cpus', String(threads), '-v', `${FR_DIR}:/fr:ro`, '-v', `${work}:/w`, IMAGE,
  'java', '-Xmx3g', '-jar', `/fr/${JAR}`, '--gui.enabled=false', '-de', '/w/board.dsn', '-do', '/w/board.ses', '-mp', String(passes), '-mt', String(threads)],
  { encoding: 'utf8', timeout: timeoutS * 1000, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, maxBuffer: 1 << 28 });
const seconds = (performance.now() - t) / 1000;
fs.writeFileSync(path.join(work, 'freerouting.log'), (r.stdout ?? '') + (r.stderr ?? ''));
if (r.error?.code === 'ETIMEDOUT') spawnSync('docker', ['rm', '-f', `fr-${tag}`.replace(/[^\w.-]/g, '_')]);
const sesFile = path.join(work, 'board.ses');
const score = fs.existsSync(sesFile) ? scoreSes(fs.readFileSync(sesFile, 'utf8'), dsn) : null;
const row = { router: 'freerouting-2.5.0', board, layout: src, seed, jitter, passes, threads, rules, status: r.error ? r.error.code : r.status === 0 ? 'ok' : `exit ${r.status}`, seconds: Math.round(seconds), ...(score ? { routed: score.routed, nets: score.nets, vias: score.vias, lengthMm: score.lengthMm, unrouted: score.unrouted.slice(0, 20) } : {}), work };
if (out) fs.appendFileSync(out, JSON.stringify(row) + '\n');
console.log(JSON.stringify(row));
