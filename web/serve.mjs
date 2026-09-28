// Static file server for the browser pages: serves the repository root so web/ can
// import ../src and ../bench modules directly.
//
//   node web/serve.mjs [--port 8173]   ->  http://localhost:8173/  (editor; web/latency.html: relayout latency)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 8173);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.wgsl': 'text/plain' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(302, { location: '/web/editor.html' }); res.end(); return; }
  // Pages save benchmark results with POST /results/<name>.json -> bench/results/<name>.json.
  const save = req.method === 'POST' && url.pathname.match(/^\/results\/([\w.-]+\.json)$/);
  if (save) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { fs.writeFileSync(path.join(root, 'bench', 'results', save[1]), body); res.writeHead(204); res.end(); console.log(`saved bench/results/${save[1]}`); });
    return;
  }
  const file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, () => console.log(`http://localhost:${port}/web/editor.html`));
