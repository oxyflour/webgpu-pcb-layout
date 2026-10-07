// Interactive placement editor (ui/, from webgpu-layout web/editor.*) plus a Cypress
// backend that lays out the selected parts.
//   node harness/ui-server.mjs --runtime results/runtime-cypress-v1 --container codex-cypress-harness-20261005
// The editor's ../src and ../bench imports are served from the same runtime snapshot the
// harness uses, so the page and Cypress share one problem model. Every request and
// result is saved under --jobs for later trajectory analysis.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { args, writeJson } from './io.mjs';

const a = args(), root = path.resolve(import.meta.dirname, '..');
const port = Number(a.port ?? 8173);
const runtime = path.resolve(a.runtime ?? process.env.CYPRESS_RUNTIME ?? 'results/runtime');
const container = a.container ?? process.env.CYPRESS_CONTAINER ?? 'codex-cypress-harness-20261005';
const boards = path.resolve(a.boards ?? 'C:/Projects/webgpu-layout/web/boards');
const jobs = path.resolve(a.jobs ?? 'results/ui-jobs');
if (!fs.existsSync(path.join(runtime, 'src/problem.js'))) throw Error('Runtime snapshot not found: ' + runtime + ' (use --runtime)');
process.env.CYPRESS_RUNTIME = runtime;
const { buildSelectionProblem, summarize } = await import('./ui-cypress.mjs');
const mounts = [['/web/boards/', boards], ['/web/', path.join(root, 'ui')], ['/src/', path.join(runtime, 'src')], ['/bench/', path.join(runtime, 'bench')]];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wgsl': 'text/plain' };
let busy = null;

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
function containerRunning() {
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', container], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'true';
}
function readBody(req, limit = 64 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
// solve() blocks on docker; run it off the event loop so the page stays served.
function runWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ui-solve-worker.mjs', import.meta.url), { workerData: data });
    worker.once('message', m => m.ok ? resolve(m) : reject(Error(m.error)));
    worker.once('error', reject);
    worker.once('exit', code => code && reject(Error('Cypress worker exited ' + code)));
  });
}

async function place(req, res) {
  if (busy) return send(res, 409, { error: `Cypress 正在运行 job ${busy}` });
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'), dir = path.join(jobs, id);
  busy = id;
  try {
    const request = await readBody(req), built = buildSelectionProblem(request);
    const seed = Number.isInteger(request.seed) ? request.seed >>> 0 : crypto.randomInt(2 ** 31), clearance = Number(request.clearance ?? .1);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'request.json'), request);
    const began = performance.now();
    const solved = await runWorker({ runtime, container, adapted: built.adapted, initial: built.initial, seed, dir, clearance });
    const result = { job: id, board: request.board, seed, clearance, selected: built.selected.length, ...summarize(built, solved),
      engine: solved.engine, elapsedSeconds: (performance.now() - began) / 1000 };
    writeJson(path.join(dir, 'result.json'), result);
    send(res, 200, result);
  } catch (error) {
    if (fs.existsSync(dir)) writeJson(path.join(dir, 'error.json'), { error: error.message });
    send(res, 400, { job: id, error: error.message });
  } finally { busy = null; }
}

function serveStatic(url, res) {
  const mount = mounts.find(([p]) => url.startsWith(p));
  const file = mount && path.resolve(mount[1], '.' + url.slice(mount[0].length - 1));
  if (!file || !file.startsWith(mount[1] + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (url === '/') { res.writeHead(302, { location: '/web/editor.html' }); return res.end(); }
  if (url === '/api/health') return send(res, 200, { ok: true, container, running: containerRunning(), busy });
  if (url === '/api/cypress/place' && req.method === 'POST') return void place(req, res);
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  serveStatic(url, res);
}).listen(port, () => console.log(`http://localhost:${port}/web/editor.html · Cypress ${container} · runtime ${runtime}`));
