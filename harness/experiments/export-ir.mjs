// Write a registered board as an IR file (the adapter's kicadToIR output) for harness/boards.json,
// with the optional fields the constraints use: footprints[].sheet (schematic sheet path) and
// nets[].netclass (+ netClasses [{name, clearance, traceWidth, viaDia}]), taken from the KiCad file.
// node harness/experiments/export-ir.mjs --board k60 --out boards/k60-ir.json
import fs from 'node:fs';
import path from 'node:path';
import { loadBoard } from '../lib/board.mjs';
import { kicadInfo } from '../lib/constraints.mjs';

const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const b = loadBoard(arg('board')), K = kicadInfo(b), ir = JSON.parse(JSON.stringify(b.a.ir));
for (const f of ir.footprints) if (K.sheetOf[f.id] != null) f.sheet = K.sheetOf[f.id];
const classOf = new Map(K.netClasses.flatMap((c) => c.nets.map((n) => [n, c.name])));
for (const n of ir.nets) if (classOf.has(n.name)) n.netclass = classOf.get(n.name);
ir.netClasses = K.netClasses.map(({ nets, ...c }) => c);
const out = path.resolve(arg('out')); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(ir));
console.log(JSON.stringify({ board: b.name, out, footprints: ir.footprints.length, withSheet: ir.footprints.filter((f) => f.sheet != null).length, nets: ir.nets.length, withNetclass: ir.nets.filter((n) => n.netclass).length }));
