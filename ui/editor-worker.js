// Worker for web/editor.html: owns the WebGPU device and the PlacementSession. The page
// sends edits (move, lock, module changes); each one is answered with the parts that
// changed. Messages are handled one at a time, in order; when a budgeted relayout leaves
// overlaps, a legalize-only clean-up pass runs as soon as no other message is waiting.
import { requestWebGpuDevice } from '../src/gpu/device.js';
import { parseKicadBoard, kicadToIR } from '../src/kicad/adapter.js';
import { irToProblem, placementResult, toYDown } from '../src/ir/to-problem.js';
import { validateBoardIR } from '../src/ir/validate.js';
import { normalizeProblem } from '../src/problem.js';
import { PlacementSession } from '../src/session.js';
import { autoModules } from '../src/optimizer/modules.js';
import { memberOverlaps } from '../src/optimizer/relayout.js';

const post = (type, data = {}) => self.postMessage({ type, ...data });
let device = null, board = null, session = null, cleanup = null;
const history = [], HISTORY = 50;

async function ensureDevice() {
  if (device) return device;
  device = await requestWebGpuDevice();
  device.lost.then((info) => post('error', { message: `GPU 设备丢失：${info.message}` }));
  const info = device.adapterInfo ?? {};
  post('device', { adapter: [info.vendor, info.architecture].filter(Boolean).join(' / ') || 'WebGPU' });
  return device;
}

/** Board IR from an uploaded file: .kicad_pcb text or Board IR JSON. */
function toIR(name, text) {
  if (/\.kicad_pcb$/i.test(name) || text.trimStart().startsWith('(kicad_pcb')) {
    return kicadToIR(parseKicadBoard(text, name), name.replace(/\.kicad_pcb$/i, ''));
  }
  const ir = JSON.parse(text);
  const { errors } = validateBoardIR(ir);
  if (errors.length) throw new Error(`Board IR 无效：\n${errors.slice(0, 8).join('\n')}`);
  return ir;
}

const moduleName = (problem, m, k) => `M${k + 1} ${m.members.length ? problem.components[m.members[0]].id : ''}`.trim();

async function load({ name, text, placement, seed = 1 }) {
  const t0 = performance.now();
  await ensureDevice();
  post('progress', { message: '解析文件' });
  const ir = toIR(name, text);
  let adapted = irToProblem(ir, { preplace: true, sides: 'ir' });
  let problem = normalizeProblem(adapted.input);
  const unplaced = adapted.originalLayout.filter((p) => !p).length;
  let mode = placement, layout, modules, timing = {};
  if (mode === 'original' && unplaced) mode = 'auto';
  if (mode === 'auto') {
    // The evaluation's no-agent tool layout, run by the server (harness/ui/tool-place.mjs: the
    // native detail pass needs Node): start layout -> 0.1 mm legalizer -> detail pass (20000 tries
    // per small part, at most 60 s) -> legalizer. Its problem is the evaluation's too: original
    // sides, through-hole parts fixed, the registered body margin (boards.json) of a known file.
    post('progress', { message: `评测流程布局：${adapted.input.components.length} 个器件（初始布局 → 合法化 → detail pass ≤ 60 s → 合法化）` });
    const r = await fetch('/api/tool-place', { method: 'POST', body: JSON.stringify({ name, text, seed }) });
    if (!r.ok) throw new Error(`自动布局失败（/api/tool-place ${r.status}）：${await r.text()}`);
    const out = await r.json();
    adapted = irToProblem(ir, { preplace: true, sides: 'original', ...(out.bodyMargin != null ? { bodyMargin: out.bodyMargin } : {}) });
    adapted.input.components.forEach((c, i) => { if (c.twoSided && !c.fixed) c.fixed = { ...adapted.originalLayout[i] }; });
    problem = normalizeProblem(adapted.input);
    if (out.ids.length !== problem.components.length || out.ids.some((id, i) => id !== problem.components[i].id)) throw new Error('自动布局失败：服务器的器件顺序与页面不一致');
    layout = out.layout.map((p) => ({ ...p }));
    timing = { ...out.timing, board: out.board, bodyMargin: out.bodyMargin };
  } else layout = adapted.originalLayout.map((p) => ({ ...p }));
  post('progress', { message: '模块划分' });
  modules = autoModules(problem, { seed }).modules;
  modules.forEach((m, k) => { m.name = moduleName(problem, m, k); });
  post('progress', { message: '编译 GPU 管线' });
  session = await PlacementSession.create(problem, layout, { device, modules });
  board = { name: ir.name ?? name, adapted, problem, ir };
  history.length = 0; cleanup = null;

  // Drawing data: bodies, pads in the part's local (top-view) frame, signal nets.
  const src = toYDown(ir);
  const pads = src.footprints.map((f, fi) => (f.pads ?? []).map((p) => {
    const [x, y] = adapted.bodyFrame[fi].pinOf(p), [w, h] = p.size ?? [0.5, 0.5];
    const quarter = Math.round(((p.rotation ?? 0) % 180 + 180) % 180 / 90) & 1;
    return quarter ? [x, y, h, w] : [x, y, w, h];
  }));
  post('loaded', {
    name: board.name, mode, unplaced, loadMs: performance.now() - t0, timing,
    canvas: { width: problem.canvas.width, height: problem.canvas.height }, contours: adapted.contours,
    components: problem.components.map((c, i) => ({ id: c.id, width: c.width, height: c.height, fixed: !!c.fixed, sides: c.sides, twoSided: !!c.twoSided, rotatable: c.rotatable !== false, library: ir.footprints[i].library ?? '' })),
    pads, pins: problem.pins.map((p) => [p.componentIndex, p.x, p.y]), nets: problem.nets.map((n) => ({ id: n.id, pins: n.pins })),
    // For the routing worker: pads in body frames, outline, keepouts, copper layers.
    routing: adapted.routing, sides: adapted.sides, copperLayers: (ir.board.copperLayers ?? []).filter((l) => l.type !== 'plane').map((l) => l.name),
    ...state(), stats: { parts: problem.components.length, fixed: problem.components.filter((c) => c.fixed).length, nets: problem.nets.length },
  });
}

/** Full editable state (layout, locks, modules) for the page. */
function state() {
  return {
    layout: session.layout,
    locked: [...session.locked],
    modules: session.modules.map((m, k) => ({ name: m.name ?? moduleName(board.problem, m, k), members: [...m.members] })),
  };
}

function snapshot() {
  history.push({ layout: session.layout, locked: [...session.locked], modules: session.modules.map((m) => ({ ...m, members: [...m.members] })) });
  if (history.length > HISTORY) history.shift();
}

function restore(s) {
  session.state = s.layout.map((p) => ({ ...p }));
  session.locked = new Set(s.locked);
  session.modules = s.modules;
  session.moduleOfPart.fill(-1);
  session.modules.forEach((m, k) => m.members.forEach((i) => { session.moduleOfPart[i] = k; }));
}

/** Answer an edit: changed parts, timing and quality of the relayout (if any). */
function reply(seq, reason, r, extraChanged = []) {
  const changed = [...new Set([...(r?.changed ?? []), ...extraChanged])];
  const layout = session.layout;
  post('update', {
    seq, reason, changed, placements: changed.map((i) => layout[i]),
    rejected: r?.rejected ? { overlapsBefore: r.before.overlaps, overlapsAfter: r.after.overlaps, totalMs: r.timing.totalMs, parts: r.attempts[0]?.parts } : undefined,
    relayout: r && r.changed.length ? {
      parts: r.changed.length, totalMs: r.timing.totalMs,
      hpwlBefore: r.before.hpwl, hpwlAfter: r.after.hpwl, overlapsBefore: r.before.overlaps, overlapsAfter: r.after.overlaps,
      stages: r.attempts.reduce((s, a) => ({ globalMs: s.globalMs + a.globalMs, lnsMs: s.lnsMs + a.lnsMs, legalizeMs: s.legalizeMs + a.legalizeMs }), { globalMs: 0, lnsMs: 0, legalizeMs: 0 }),
    } : null,
    locked: [...session.locked],
    modules: reason === 'assign' || reason === 'undo' ? state().modules : undefined,
  });
  // Overlaps left behind (legalization ran out of time): clean up when idle.
  if (r && r.changed.length && r.after.overlaps > 0 && reason !== 'cleanup') cleanup = { members: r.changed, seq };
}

async function handle(msg) {
  if (msg.type === 'load') return load(msg);
  if (!session) throw new Error('还没有载入板子');
  const budgetMs = msg.budgetMs ?? 300;
  switch (msg.type) {
    case 'move': {
      snapshot();
      for (const m of msg.moves) session.move(m.i, { x: m.x, y: m.y, ...(m.rotation !== undefined ? { rotation: m.rotation } : {}), ...(m.side !== undefined ? { side: m.side } : {}) });
      session.lock(msg.moves.map((m) => m.i));
      // Re-place the module of the moved part and every module the moved parts now overlap.
      const r = await session.relayout({ around: msg.around ?? msg.moves[0].i, moved: msg.moves.map((m) => m.i), budgetMs, seed: msg.seq });
      return reply(msg.seq, 'move', r, msg.moves.map((m) => m.i));
    }
    case 'lock': {
      snapshot();
      if (msg.locked) session.lock(msg.indices); else session.unlock(msg.indices);
      return reply(msg.seq, 'lock', null);
    }
    case 'assign': {
      snapshot();
      const { module, moved } = session.assignModule(msg.indices, msg.module);
      if (msg.module === 'new') session.modules[module].name = `M${module + 1} ${board.problem.components[msg.indices[0]].id}`;
      // Re-place every joined part (they start piled at the module centre) together with
      // the module's members nearest to that spot.
      let r = null;
      if (moved.length) {
        const c = session.state[moved[0]], set = new Set(moved);
        const others = session.modules[module].members.filter((i) => !set.has(i) && !session.isLocked(i))
          .sort((a, b) => Math.hypot(session.state[a].x - c.x, session.state[a].y - c.y) - Math.hypot(session.state[b].x - c.x, session.state[b].y - c.y))
          .slice(0, Math.max(0, session.options.maxParts - moved.length));
        r = await session.relayout({ members: [...moved, ...others], budgetMs, seed: msg.seq });
      }
      return reply(msg.seq, 'assign', r, moved);
    }
    case 'relayoutModule': {
      snapshot();
      const members = session.modules[msg.module].members.filter((i) => !session.isLocked(i));
      // An explicit module relayout may take longer than a drag: 4 ms per part, 0.4-1.5 s.
      const r = members.length ? await session.relayout({ members, budgetMs: Math.min(1500, Math.max(400, 4 * members.length)), seed: msg.seq }) : null;
      return reply(msg.seq, 'module', r);
    }
    case 'relayoutSelection': {
      // The selected parts (locked and fixed ones stay), same size-dependent budget as a module relayout.
      snapshot();
      const members = msg.indices.filter((i) => !session.isLocked(i));
      const r = members.length ? await session.relayout({ members, budgetMs: Math.min(1500, Math.max(400, 4 * members.length)), seed: msg.seq }) : null;
      return reply(msg.seq, 'selection', r);
    }
    case 'undo': {
      const s = history.pop();
      if (!s) return post('update', { seq: msg.seq, reason: 'undo', changed: [], placements: [], nothing: true });
      const before = session.layout;
      restore(s);
      cleanup = null;
      const changed = s.layout.map((p, i) => i).filter((i) => ['x', 'y', 'rotation', 'side'].some((k) => before[i][k] !== s.layout[i][k]));
      return reply(msg.seq, 'undo', null, changed);
    }
    case 'setLayout': {
      // A layout from the agent (web/serve.mjs /agent/events): [componentIndex, x, y, rotation, side] per movable part.
      // Undoable like any edit; fixed parts keep their positions.
      snapshot();
      const changed = [];
      for (const [i, x, y, rotation, side] of msg.placements) {
        if (board.problem.components[i].fixed) continue;
        const p = session.state[i];
        if (Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6 && (p.rotation ?? 0) === rotation && (p.side ?? 0) === side) continue;
        session.state[i] = { ...p, x, y, rotation, side };
        changed.push(i);
      }
      return reply(msg.seq, 'agent', null, changed);
    }
    case 'export': {
      const layout = session.layout;
      const result = placementResult(board.adapted, layout, { modules: session.modules.map((m) => ({ name: m.name, footprints: m.members.map((i) => board.problem.components[i].id) })), locked: [...session.locked].map((i) => board.problem.components[i].id) });
      return post('export', { name: board.name, json: JSON.stringify(result, null, 1) });
    }
    default: throw new Error(`unknown message ${msg.type}`);
  }
}

// One message at a time; the clean-up pass only when the queue is empty.
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length || cleanup) {
    const msg = queue.shift();
    try {
      if (msg) { post('busy', { seq: msg.seq, pending: queue.length }); await handle(msg); continue; }
      const c = cleanup; cleanup = null;
      const members = c.members.filter((i) => !session.isLocked(i));
      if (!members.length || !memberOverlaps(board.problem, session.state, members)) continue;
      // Applied only when it removes overlaps (a legalize pass can also shift the problem).
      const r = await session.relayout({ members, budgetMs: 100, legalizeOnly: true, apply: false });
      if (r.after.overlaps >= r.before.overlaps) continue;
      for (const i of r.changed) session.state[i] = r.layout[i];
      reply(c.seq, 'cleanup', r);
    } catch (e) {
      post('error', { seq: msg?.seq, message: e?.message ?? String(e), stack: e?.stack });
    }
  }
  busy = false;
  post('idle');
}
self.onmessage = ({ data }) => { queue.push(data); pump(); };
