// Static server of the interactive placement editor (ui/). The editor's ../src and ../bench imports
// are served from core/ and its tool start layout from harness/lib/, so the page and the harness
// share one problem model. POST /api/tool-place {name, text, seed}: the editor's 自动布局 = the
// evaluation's tool layout; POST /api/tool-route {name, text, layout}: routing under the evaluation
// protocol (both need the native programs, so they run in Node, not in the page).
//   node harness/ui/server.mjs [--port 8173] [--boards DIR]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { CORE_ROOT, HARNESS_ROOT, REPO_ROOT, UI_BOARDS, required } from '../lib/env.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 8173));
const boards = path.resolve(arg('boards') ?? required(UI_BOARDS, 'uiBoards', 'UI_BOARDS', 'the editor serves board JSON files (or pass --boards DIR)'));
const mounts = [['/web/boards/', boards], ['/web/', path.join(REPO_ROOT, 'ui')], ['/src/', path.join(CORE_ROOT, 'src')], ['/bench/', path.join(CORE_ROOT, 'bench')], ['/harness/lib/', path.join(HARNESS_ROOT, 'lib')]];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wgsl': 'text/plain' };

function serveStatic(url, res) {
  const mount = mounts.find(([p]) => url.startsWith(p));
  const file = mount && path.resolve(mount[1], '.' + url.slice(mount[0].length - 1));
  if (!file || !file.startsWith(mount[1] + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// POST /api/<script> runs harness/ui/<script>.mjs on the request body in a child process; a request
// the page aborts (a newer edit) kills it.
const SCRIPTS = new Set(['tool-place', 'tool-route']);
function runScript(script, req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const file = path.join(os.tmpdir(), `${script}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, Buffer.concat(chunks));
    const child = execFile(process.execPath, [path.join(HARNESS_ROOT, 'ui', `${script}.mjs`), file], { cwd: REPO_ROOT, maxBuffer: 1 << 29, windowsHide: true }, (err, stdout, stderr) => {
      fs.rmSync(file, { force: true });
      if (res.destroyed) return;
      if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(stderr || err.message); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(stdout);
    });
    res.on('close', () => { if (!res.writableEnded) child.kill(); });
  });
}

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (url === '/') { res.writeHead(302, { location: '/web/editor.html' }); return res.end(); }
  const api = url.match(/^\/api\/([\w-]+)$/);
  if (api && SCRIPTS.has(api[1]) && req.method === 'POST') return runScript(api[1], req, res);
  if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }
  serveStatic(url, res);
}).listen(port, () => console.log(`http://localhost:${port}/web/editor.html`));
