// Export the session benchmark boards as Board IR for the browser pages (web/boards/).
//
//   node bench/export-web-boards.mjs [--placer ../webgpu_pcb_placer]
import fs from 'node:fs';
import path from 'node:path';
import { loadKicadParser, kicadToIR } from './kicad-adapter.mjs';
import { SESSION_BOARDS } from './session-boards.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const placerRoot = path.resolve(arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const outDir = path.join(import.meta.dirname, '..', 'web', 'boards');
fs.mkdirSync(outDir, { recursive: true });
const parse = await loadKicadParser(placerRoot);
const index = [];
for (const [name, file] of Object.entries(SESSION_BOARDS)) {
  const ir = kicadToIR(parse(fs.readFileSync(path.join(placerRoot, 'benchmark', file), 'utf8'), name), name);
  fs.writeFileSync(path.join(outDir, `${name}.board.json`), JSON.stringify(ir));
  index.push({ name, file: `${name}.board.json`, footprints: ir.footprints.length });
  console.error(`${name}: ${ir.footprints.length} footprints`);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));
