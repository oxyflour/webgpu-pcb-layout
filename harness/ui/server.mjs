// Static server of the interactive placement editor (ui/). The editor's ../src and ../bench imports
// are served from core/ and its tool start layout from harness/lib/, so the page and the harness
// share one problem model.
//   node harness/ui/server.mjs [--port 8173] [--boards DIR]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (url === '/') { res.writeHead(302, { location: '/web/editor.html' }); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }
  serveStatic(url, res);
}).listen(port, () => console.log(`http://localhost:${port}/web/editor.html`));
