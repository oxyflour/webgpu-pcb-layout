// Router cleanup stage (native/router.cpp `cleanup`): does it raise clean nets and lower the noise?
// Every layout is routed at `--samples` random sub-cell grid offsets (independent phases; the
// evaluateRobust shifts repeat after 3), once without and once with cleanup. One JSON row per
// (layout, offset, cleanup) appended to --out.
// node harness/experiments/cleanup-check.mjs --board k60 --layouts a.json,b.json[,human] --samples 8 --cleanup 0,4 --out FILE [--jobs 10]
import fs from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadBoard, evaluate, legalize, toolRouting, needsFastRouting } from '../lib/board.mjs';

const readLayout = (b, src) => {
  if (src === 'human') return b.a.originalLayout.map((l) => ({ ...l }));
  const j = JSON.parse(fs.readFileSync(src, 'utf8'));
  return legalize(b, Array.isArray(j) ? j : j.layout).layout;
};

if (!isMainThread) {
  const { board, src, offset, cleanup } = workerData, b = loadBoard(board), L = readLayout(b, src);
  const routing = needsFastRouting(b) ? toolRouting(b) : { router: 'native' };
  const t = performance.now(), m = evaluate(b, L, { ...routing, cleanup, offset });
  parentPort.postMessage({ board, layout: src, offset, cleanup, clean: m.clean, nets: m.nets, vias: m.vias, viaSites: m.viaSites, rounds: m.routeRounds, cleanupStats: m.cleanup ?? null, s: Math.round(performance.now() - t) / 1000 });
} else {
  const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  const board = arg('board'), layouts = arg('layouts').split(','), samples = Number(arg('samples', 8)), out = arg('out');
  const cleanups = arg('cleanup', '0,4').split(',').map(Number), jobs = Number(arg('jobs', 10));
  let s = 7919; const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
  const offsets = Array.from({ length: samples }, (_, k) => k ? [Math.round(rnd() * 4000) / 10000, Math.round(rnd() * 4000) / 10000] : [0, 0]);
  const tasks = layouts.flatMap((src) => offsets.flatMap((offset) => cleanups.map((cleanup) => ({ board, src, offset, cleanup }))));
  // Resume: skip rows already in --out.
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return JSON.stringify([r.layout, r.offset, r.cleanup]); }) : []);
  tasks.splice(0, tasks.length, ...tasks.filter((t) => !done.has(JSON.stringify([t.src, t.offset, t.cleanup]))));
  let next = 0;
  const run = async () => { while (next < tasks.length) { const task = tasks[next++];
    const row = await new Promise((res, rej) => { const w = new Worker(new URL(import.meta.url), { workerData: task }); w.once('message', res); w.once('error', rej); });
    fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); } };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, run));
}
