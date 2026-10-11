// Interactive placement editor (ui/, from webgpu-layout web/editor.*) with Cypress layout of
// the selected parts. The editor's ../src and ../bench imports are served from the harness's
// adapter checkout (lib/env.mjs LAYOUT_ROOT), so the page and Cypress share one problem model.
//   node harness/ui/server.mjs [--port 8173] [--boards DIR]
// Requests and results are saved under harness/results/ui-jobs/<job>/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LAYOUT_ROOT, CONTAINER, HARNESS_ROOT, REPO_ROOT, UI_BOARDS, required } from '../lib/env.mjs';
import { solveSelection } from './selection.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 8173));
const boards = path.resolve(arg('boards') ?? required(UI_BOARDS, 'uiBoards', 'UI_BOARDS', 'the editor serves board JSON files (or pass --boards DIR)'));
const jobs = path.join(HARNESS_ROOT, 'results', 'ui-jobs');
// /harness/lib/: the editor worker imports the tool start layout (start-layout.mjs, browser-safe).
const mounts = [['/web/boards/', boards], ['/web/', path.join(REPO_ROOT, 'ui')], ['/src/', path.join(LAYOUT_ROOT, 'src')], ['/bench/', path.join(LAYOUT_ROOT, 'bench')], ['/harness/lib/', path.join(HARNESS_ROOT, 'lib')]];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wgsl': 'text/plain' };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));
let busy = null;

const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
// No container configured: the editor works without Cypress (its Cypress job returns an error).
function containerRunning() {
  if (!CONTAINER) return false;
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'true';
}
function readBody(req, limit = 64 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function place(req, res) {
  if (busy) return send(res, 409, { error: `Cypress 正在运行 job ${busy}` });
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'), dir = path.join(jobs, id);
  busy = id;
  try {
    const request = await readBody(req), seed = Number.isInteger(request.seed) ? request.seed : crypto.randomInt(1, 2 ** 31);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'request.json'), request);
    const t0 = performance.now(), out = await solveSelection(request, { jobDir: path.join(dir, 'cypress'), seed });
    const result = { job: id, board: request.board, seed, rotate: !!request.rotate, selected: out.placements.length, ...out, elapsedS: (performance.now() - t0) / 1000 };
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
  if (url === '/api/health') return send(res, 200, { ok: true, container: CONTAINER, running: containerRunning(), busy });
  if (url === '/api/cypress/place' && req.method === 'POST') return void place(req, res);
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  serveStatic(url, res);
}).listen(port, () => console.log(`http://localhost:${port}/web/editor.html · Cypress ${CONTAINER} · adapter ${LAYOUT_ROOT}`));
