// routeBoard with the negotiation loop in native code (native/router.cpp, build: native/build.cmd).
// The JS router rasterizes (options.rasterOnly) and fixes the net order exactly as it does itself;
// the native program reproduces rounds, A* and statistics bit for bit (experiments/native-check.mjs).
// Only the evaluation settings are supported: rules null (one-cell tracks and vias), astarWeight,
// incremental, maxRounds, deadline. Returns the same fields as routeBoard (+ viaSites).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routeBoard } from '../../core/src/router/board-router.js';
import { HARNESS_ROOT } from './env.mjs';

export const NATIVE_EXE = path.join(HARNESS_ROOT, 'native', process.platform === 'win32' ? 'router.exe' : 'router');
export const nativeAvailable = () => fs.existsSync(NATIVE_EXE);

export function routeBoardNative(board, layout, sides, options = {}) {
  if (options.rules) throw new Error('native router: design rules are not supported (evaluation routing uses rules: null)');
  if (options.footprint && options.footprint !== 1) throw new Error('native router: footprint must be 1');
  const cell = options.cell ?? 0.3, R = routeBoard(board, layout, sides, { ...options, rasterOnly: true });
  const { grid: { W, H, L, P }, owner, padCells, netPads, padCenter } = R;
  const order = [...Array(board.netCount).keys()].filter((n) => netPads[n].length >= 2);
  const span = (n) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of netPads[n]) { const [x, y] = padCenter[p]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 - x0 + y1 - y0; };
  order.sort((a, b) => span(a) - span(b));
  // options.netRules [{net, priority, viaMul, layerMask, keepout}] (lib/constraints.mjs routerRules):
  // nets with a priority route first (lower value first, then by span), the rest keep the span order.
  const rules = options.netRules ?? [];
  if (rules.length) { const pr = new Map(rules.filter((r) => r.priority != null).map((r) => [r.net, r.priority]));
    order.sort((a, b) => (pr.get(a) ?? Infinity) - (pr.get(b) ?? Infinity) || span(a) - span(b)); }
  const deadlineS = options.deadline ? (options.deadline - performance.now()) / 1000 : 0;
  // Binary input (see router.cpp).
  const parts = [];
  const i32 = (a) => { const b = Buffer.alloc(a.length * 4); for (let k = 0; k < a.length; k++) b.writeInt32LE(a[k], k * 4); parts.push(b); };
  const f64 = (a) => { const b = Buffer.alloc(a.length * 8); for (let k = 0; k < a.length; k++) b.writeDoubleLE(a[k], k * 8); parts.push(b); };
  i32([W, H, L, board.netCount, order.length, options.maxRounds ?? 12, options.incremental ? 1 : 0, (options.windowMargin ?? 12)]);
  f64([cell, options.viaCost ?? 6, options.presentFactor ?? 0.6, options.presentGrowth ?? 1.6, options.historyGain ?? 0.4, deadlineS > 0 ? deadlineS : 0, options.astarWeight ?? 1]);
  i32([options.layerHeuristic ? 1 : 0, options.emitPaths ? 1 : 0, options.emitOverflow ? 1 : 0, options.cleanup ?? 0]);
  parts.push(Buffer.from(Int32Array.from(owner).buffer));
  i32(order);
  i32([padCells.length]);
  padCells.forEach((cells, p) => { f64(padCenter[p]); i32([cells.length]); i32(cells); });
  for (let n = 0; n < board.netCount; n++) { i32([netPads[n].length]); i32(netPads[n]); }
  if (rules.length) { i32([rules.length]); for (const r of rules) { i32([r.net]); f64([r.viaMul ?? 1]); i32([r.layerMask ?? -1, r.keepout ?? 0]); } }
  const file = path.join(os.tmpdir(), `route-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(file, Buffer.concat(parts));
  try {
    const r = spawnSync(NATIVE_EXE, [file], { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
    if (r.status !== 0) throw new Error(`native router failed (${r.status}): ${r.stderr || r.error?.message}`);
    const o = JSON.parse(r.stdout);
    for (const x of o.roundLog) options.onRound?.({ round: x.round, maxRounds: options.maxRounds ?? 12, overflow: x.overflow });
    return {
      grid: { W, H, cell, layers: L }, rounds: o.rounds, overflow: o.overflow, nets: o.nets, complete: o.complete, clean: o.clean, vias: o.vias, viaSites: o.viaSites, length: o.length,
      status: Uint8Array.from(o.status), nativeSeconds: o.seconds, ...(options.cleanup ? { cleanup: o.cleanup } : {}), roundOverflow: o.roundLog.map((x) => x.overflow), ...(o.ovf1 ? { overflowCells: { round1: o.ovf1, end: o.ovfEnd, P } } : {}), ...(o.paths ? { paths: o.paths } : {}),
      ...(options.diagnostics ? { netStats: o.netVias.map((v, n) => ({ vias: v, lengthMm: o.netLen[n], viaPoints: [] })) } : {}),
    };
  } finally { fs.rmSync(file, { force: true }); }
}
