// Export a KiCad board as Board IR (docs/board-ir.md).
//
//   node bench/kicad-to-ir.mjs board.kicad_pcb [--out board.board.json] [--placer ../webgpu_pcb_placer]
import fs from 'node:fs';
import path from 'node:path';
import { loadKicadParser, kicadToIR } from './kicad-adapter.mjs';
import { validateBoardIR } from '../src/ir/validate.js';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const file = args.find((a) => a.endsWith('.kicad_pcb'));
if (!file) { console.error('usage: node bench/kicad-to-ir.mjs <board.kicad_pcb> [--out <file>.board.json]'); process.exit(2); }
const placerRoot = path.resolve(arg('placer', path.join(import.meta.dirname, '..', '..', 'webgpu_pcb_placer')));
const parse = await loadKicadParser(placerRoot);
const ir = kicadToIR(parse(fs.readFileSync(file, 'utf8'), path.basename(file)), path.basename(file, '.kicad_pcb'));
const { errors, warnings } = validateBoardIR(ir);
for (const w of warnings) console.error(`warning: ${w}`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const out = arg('out', file.replace(/\.kicad_pcb$/, '.board.json'));
fs.writeFileSync(out, JSON.stringify(ir, null, 1));
console.error(`wrote ${out}: ${ir.footprints.length} footprints, ${ir.nets.length} nets, ${ir.footprints.reduce((s, f) => s + f.pads.length, 0)} pads`);
