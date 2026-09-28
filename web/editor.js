// Interactive layout editor: Canvas 2D view and input handling. All placement work runs
// in editor-worker.js; this thread only draws, keeps an optimistic copy of the layout
// while the user drags, and applies the worker's answers (with a short tween).
import { localPin, rotateQuarter, rotatedSize } from '../src/problem.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#view'), ctx = canvas.getContext('2d');
const worker = new Worker('./editor-worker.js', { type: 'module' });

// ---- state ----------------------------------------------------------------------------
let vm = null;                 // loaded board (static geometry)
let layout = [], disp = [];    // authoritative layout (from the worker) / what is drawn
let locked = new Set(), modules = [], moduleOf = new Int32Array(0);
let compNets = [];             // component -> signal net indices
let selection = new Set();
const view = { scale: 4, ox: 0, oy: 0 };
const opts = { side: 'both', rats: 'sel', labels: true, pads: true, routes: true };
let seq = 0, inFlight = 0, workerBusy = false, lastOp = null, lastCleanup = null, loading = false, loadStart = 0;
const anims = new Map(), flashes = new Map();
let drag = null, box = null, pan = null, pointer = null, spaceDown = false, activeModule = -1;
let pendingSource = null;      // {name, text} waiting for the Load button

// ---- routing (web/route-worker.js) ------------------------------------------------------------
// The placement is routed in its own worker whenever the editor worker goes idle after a
// change. A new edit terminates a routing run that has not finished (it would be stale).
let routeWorker = null, routeSeq = 0, routeRun = null, routes = null, routesStale = false, layoutDirty = false, routeTimer = 0;
const LAYER_COLORS = ['#e5484d', '#3b82f6', '#f59e0b', '#22c55e', '#a855f7', '#14b8a6', '#ec4899', '#84cc16', '#f97316', '#6366f1'];
const layerColor = (l, L) => l === 0 ? LAYER_COLORS[0] : l === L - 1 ? LAYER_COLORS[1] : LAYER_COLORS[2 + ((l - 1) % (LAYER_COLORS.length - 2))];
let layerVisible = [];

function stopRouting() {
  if (routeRun) { routeWorker?.terminate(); routeWorker = null; routeRun = null; }
  clearTimeout(routeTimer);
}

function startRouting() {
  if (!vm) return;
  stopRouting();
  if (!routeWorker) {
    routeWorker = new Worker('./route-worker.js', { type: 'module' });
    routeWorker.postMessage({ type: 'init', routing: vm.routing, sides: vm.sides });
    routeWorker.onmessage = onRouteMessage;
    routeWorker.onerror = (e) => { $('#routeStatus').textContent = `布线出错：${e.message}`; routeRun = null; };
  }
  routeRun = { seq: ++routeSeq, t0: performance.now(), round: 0, maxRounds: 0 };
  routeCancelled = false;
  layoutDirty = false;
  routeWorker.postMessage({ type: 'route', seq: routeRun.seq, layout: layout.map((p) => ({ ...p })), cell: +$('#routeCell').value });
  renderRouteStatus();
}

/** After an edit settles (the editor worker is idle), route again if enabled. */
function maybeAutoRoute() {
  if (!vm || !layoutDirty || !$('#autoRoute').checked || inFlight > 0 || workerBusy) return;
  clearTimeout(routeTimer);
  routeTimer = setTimeout(() => { if (layoutDirty && inFlight === 0 && !workerBusy) startRouting(); }, 250);
}

/** The placement changed: drawn routes are out of date, a running route is cancelled. */
let routeCancelled = false;
function layoutChanged() {
  layoutDirty = true;
  if (routes) routesStale = true;
  if (routeRun) routeCancelled = true;
  stopRouting();
  renderRouteStatus();
}

function onRouteMessage({ data: m }) {
  if (!routeRun || m.seq !== routeRun.seq) return;
  if (m.type === 'progress') { Object.assign(routeRun, { round: m.round, maxRounds: m.maxRounds, overflow: m.overflow }); renderRouteStatus(); return; }
  routes = m; routesStale = layoutDirty; routeRun = null;
  if (layerVisible.length !== m.stats.layers) { layerVisible = Array(m.stats.layers).fill(true); renderLayerToggles(); }
  renderRouteStatus(); requestDraw();
}

function renderRouteStatus() {
  const el = $('#routeStatus');
  clearTimeout(renderRouteStatus.timer);
  if (routeRun) {
    const t = ((performance.now() - routeRun.t0) / 1000).toFixed(1);
    el.innerHTML = `<span class="busy">布线中 ${t} s${routeRun.round ? ` · 第 ${routeRun.round} 轮，冲突格 ${routeRun.overflow}` : ''}</span>`;
    renderRouteStatus.timer = setTimeout(renderRouteStatus, 500);
  } else if (routes) {
    el.innerHTML = routesStale ? `<span class="bad">布局已改动，走线已过期${routeCancelled && !$('#autoRoute').checked ? '（进行中的布线已取消）' : ''}</span>` : `已完成，${(routes.ms / 1000).toFixed(1)} s`;
  } else el.innerHTML = routeCancelled && !$('#autoRoute').checked ? '<span class="bad">布局有改动，布线已取消</span>' : $('#autoRoute').checked ? '等待布线' : '未布线';
  if (!routes) { $('#routeInfo').innerHTML = ''; return; }
  const st = routes.stats, conflict = st.complete - st.clean, open = st.nets - st.complete;
  $('#routeInfo').innerHTML = kv([
    ['布通且无冲突的网络 (个)', `<span class="${st.clean === st.nets ? 'good' : ''}">${st.clean} / ${st.nets}</span>`],
    ['连通但与其他网络共用格子 (个)', `<span class="${conflict ? 'bad' : ''}">${conflict}</span>`],
    ['未连通的网络 (个)', `<span class="${open ? 'bad' : ''}">${open}</span>`],
    ['过孔 (个)', st.vias], ['走线总长 (mm)', Math.round(st.length)],
    ['布线层 / 网格 (mm)', `${st.layers} / ${st.cell}`],
  ]);
}

function renderLayerToggles() {
  const names = vm.copperLayers?.length === layerVisible.length ? vm.copperLayers : layerVisible.map((_, l) => `L${l + 1}`);
  $('#layerToggles').innerHTML = layerVisible.map((on, l) => `<label><input type="checkbox" data-layer="${l}" ${on ? 'checked' : ''}><span class="swatch" style="background:${layerColor(l, layerVisible.length)}"></span>${esc(names[l])}</label>`).join('');
}

// ---- worker messages ----------------------------------------------------------------------
worker.onmessage = ({ data: m }) => {
  if (m.type === 'device') $('#gpu').textContent = `WebGPU：${m.adapter}`;
  else if (m.type === 'progress') { $('#loadStatus').textContent = m.message; }
  else if (m.type === 'loaded') onLoaded(m);
  else if (m.type === 'busy') { workerBusy = true; hud(); }
  else if (m.type === 'idle') { workerBusy = false; hud(); maybeAutoRoute(); }
  else if (m.type === 'update') onUpdate(m);
  else if (m.type === 'export') download(`${m.name}.placement.json`, m.json);
  else if (m.type === 'error') {
    $('#error').textContent = m.message;
    console.error(m.stack ?? m.message);
    if (loading) { loading = false; $('#load').disabled = false; $('#loadStatus').textContent = '载入失败'; }
    if (m.seq !== undefined) inFlight = Math.max(0, inFlight - 1);
    hud();
  }
};
worker.onerror = (e) => { $('#error').textContent = `Worker 出错：${e.message}`; };

function send(type, data = {}) {
  const msg = { type, seq: ++seq, budgetMs: +$('#budget').value, ...data };
  if (type !== 'load' && type !== 'export') inFlight++;
  if (type === 'move' || type === 'assign' || type === 'relayoutModule' || type === 'undo') layoutChanged();
  worker.postMessage(msg);
  hud();
  return msg.seq;
}

function onLoaded(m) {
  loading = false;
  vm = m;
  layout = m.layout.map((p) => ({ ...p }));
  disp = layout.map((p) => ({ ...p }));
  locked = new Set(m.locked);
  setModules(m.modules);
  compNets = vm.components.map(() => []);
  vm.nets.forEach((n, k) => { for (const pi of n.pins) { const c = vm.pins[pi][0]; if (compNets[c].at(-1) !== k) compNets[c].push(k); } });
  selection.clear(); anims.clear(); flashes.clear(); lastOp = null; lastCleanup = null; inFlight = 0;
  stopRouting(); routeWorker?.terminate(); routeWorker = null; routes = null; routesStale = false; layerVisible = [];
  $('#layerToggles').innerHTML = '';
  // Routing a large board takes minutes: automatic re-routing only below 1000 parts.
  $('#autoRoute').checked = m.components.length < 1000;
  layoutDirty = true;
  $('#drop').classList.add('hidden');
  for (const id of ['#boardSection', '#modSection', '#routeSection', '#viewSection']) $(id).hidden = false;
  $('#load').disabled = false;
  $('#loadStatus').textContent = `完成，${(m.loadMs / 1000).toFixed(1)} s`;
  $('#error').textContent = '';
  const mode = m.mode === 'auto' ? (m.unplaced ? `自动布局（${m.unplaced} 个器件没有位置）` : '自动布局') : '文件里的布局';
  $('#boardInfo').innerHTML = kv([
    ['板子', m.name], ['尺寸 (mm)', `${m.canvas.width.toFixed(1)} × ${m.canvas.height.toFixed(1)}`],
    ['器件（其中固定）', `${m.stats.parts}（${m.stats.fixed}）`], ['信号网络', m.stats.nets], ['起始布局', mode],
  ]);
  findConflicts(); renderLastOp(); fit(); renderSelection(); renderModules(); hud();
  renderRouteStatus(); maybeAutoRoute();
}

function onUpdate(m) {
  if (m.reason !== 'cleanup') inFlight = Math.max(0, inFlight - 1);
  if (m.changed.length) layoutChanged();
  const now = performance.now();
  m.changed.forEach((i, k) => {
    const to = m.placements[k];
    layout[i] = { ...to };
    // Parts the user is dragging right now keep following the pointer.
    if (drag?.moved && drag.parts.includes(i)) return;
    anims.set(i, { from: { ...disp[i] }, to, t0: now });
    if (m.reason !== 'undo') flashes.set(i, now);
  });
  if (m.locked) locked = new Set(m.locked);
  if (m.modules) setModules(m.modules);
  if (m.relayout && m.reason === 'cleanup') { lastCleanup = m.relayout; renderLastOp(); }
  else if (m.relayout) { lastOp = { ...m.relayout, reason: m.reason }; lastCleanup = null; renderLastOp(); }
  else if (m.reason === 'undo' && m.nothing) { lastOp = { reason: 'undo-empty' }; renderLastOp(); }
  else if (m.rejected && m.reason !== 'cleanup') { lastOp = { reason: 'rejected', ...m.rejected }; lastCleanup = null; renderLastOp(); }
  findConflicts(); renderSelection(); renderModules(); hud(); requestDraw();
}

/**
 * Parts the relayout cannot fix: locked or fixed parts overlapping another part on the
 * same side (the user dropped them there). Drawn with a red outline.
 */
let conflicts = new Set();
function findConflicts() {
  conflicts = new Set();
  const n = vm.components.length, boxes = layout.map((p, i) => { const [w, h] = rotatedSize(vm.components[i], p.rotation); return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2]; });
  const same = (i, j) => vm.components[i].twoSided || vm.components[j].twoSided || (layout[i].side ? 1 : 0) === (layout[j].side ? 1 : 0);
  for (const i of locked) {
    const a = boxes[i];
    for (let j = 0; j < n; j++) {
      if (j === i || !same(i, j)) continue;
      if (vm.components[j].fixed && vm.components[i].fixed) continue;
      const b = boxes[j], ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (ox > 1e-6 && oy > 1e-6 && ox * oy > 0.01 && (locked.has(j) || vm.components[j].fixed)) { conflicts.add(i); conflicts.add(j); }
    }
  }
}

function setModules(list) {
  modules = list;
  moduleOf = new Int32Array(vm.components.length).fill(-1);
  modules.forEach((mod, k) => mod.members.forEach((i) => { moduleOf[i] = k; }));
}

// ---- side panel -----------------------------------------------------------------------------
const kv = (rows) => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderLastOp() {
  const el = $('#lastOp');
  if (!lastOp) { el.innerHTML = ''; return; }
  if (lastOp.reason === 'undo-empty') { el.innerHTML = kv([['撤销', '没有可撤销的操作']]); return; }
  if (lastOp.reason === 'rejected') {
    el.innerHTML = kv([['上次操作', '<span class="bad">重排结果未采用</span>'], ['原因', `重叠对会从 ${lastOp.overlapsBefore} 增加到 ${lastOp.overlapsAfter}`], ['耗时 (ms)', lastOp.totalMs.toFixed(0)], ['建议', '附近空间不足：先移开周围器件，或把模块拆小']]);
    return;
  }
  const what = { move: '移动 / 旋转 / 换面后重排', assign: '划入模块后重排', module: '模块重排' }[lastOp.reason] ?? lastOp.reason;
  const budget = +$('#budget').value;
  const cls = lastOp.reason === 'module' || lastOp.totalMs <= budget + 20 ? 'good' : 'bad';
  // (a module relayout has its own, size-dependent budget)
  const dOv = lastOp.overlapsAfter - lastOp.overlapsBefore;
  el.innerHTML = kv([
    ['上次操作', what],
    ['耗时 (ms)', `<span class="${cls}">${lastOp.totalMs.toFixed(0)}</span>`],
    ['全局 / LNS / 合法化 (ms)', `${lastOp.stages.globalMs.toFixed(0)} / ${lastOp.stages.lnsMs.toFixed(0)} / ${lastOp.stages.legalizeMs.toFixed(0)}`],
    ['重排器件 (个)', lastOp.parts],
    ['相关网络 HPWL (mm)', `${lastOp.hpwlBefore.toFixed(0)} → ${lastOp.hpwlAfter.toFixed(0)}`],
    ['重叠对 (个)', `${lastOp.overlapsBefore} → <span class="${dOv > 0 ? 'bad' : ''}">${lastOp.overlapsAfter}</span>`],
    ...(lastCleanup ? [['空闲时清理重叠', `${lastCleanup.overlapsBefore} → ${lastCleanup.overlapsAfter} 对，${lastCleanup.totalMs.toFixed(0)} ms`]] : []),
  ]);
}

function renderSelection() {
  const sel = [...selection];
  $('#selSection').hidden = !vm || !sel.length;
  if (!vm || !sel.length) return;
  const ids = sel.slice(0, 12).map((i) => vm.components[i].id).join(', ');
  $('#selIds').textContent = `${sel.length} 个：${ids}${sel.length > 12 ? ' …' : ''}`;
  const mods = new Set(sel.map((i) => moduleOf[i]));
  const current = mods.size === 1 ? [...mods][0] : null;
  const select = $('#moduleSelect');
  select.innerHTML = [
    ...(current === null ? ['<option value="" selected>（多个模块）</option>'] : []),
    ...modules.map((mod, k) => mod.members.length || current === k ? `<option value="${k}" ${current === k ? 'selected' : ''}>${esc(mod.name)}（${mod.members.length}）</option>` : '').filter(Boolean),
    `<option value="new">＋ 新模块</option>`,
    `<option value="-1" ${current === -1 ? 'selected' : ''}>无模块</option>`,
  ].join('');
  const allLocked = sel.every((i) => locked.has(i) || vm.components[i].fixed);
  $('#lockBtn').textContent = allLocked ? '解除固定' : '固定';
  $('#lockBtn').disabled = sel.every((i) => vm.components[i].fixed);
}

function renderModules() {
  const ul = $('#modules');
  const unassigned = vm.components.reduce((s, c, i) => s + (moduleOf[i] < 0 && !c.fixed ? 1 : 0), 0);
  ul.innerHTML = modules.map((mod, k) => mod.members.length ? `<li data-k="${k}" class="${k === activeModule ? 'active' : ''}">
      <span class="swatch" style="background:${moduleColor(k)}"></span><span class="name" title="${esc(mod.name)}">${esc(mod.name)}</span>
      <span class="count">${mod.members.length}</span><button data-relayout="${k}" title="从当前位置重排整个模块">重排</button></li>` : '').join('')
    + `<li data-k="-1"><span class="swatch" style="background:${cssVar('--part-free')}"></span><span class="name">无模块</span><span class="count">${unassigned}</span></li>`;
}

$('#modules').addEventListener('click', (e) => {
  const relayout = e.target.closest('[data-relayout]');
  if (relayout) { send('relayoutModule', { module: +relayout.dataset.relayout }); return; }
  const li = e.target.closest('li');
  if (!li) return;
  const k = +li.dataset.k;
  selection = new Set(k < 0 ? vm.components.map((c, i) => i).filter((i) => moduleOf[i] < 0 && !vm.components[i].fixed) : modules[k].members);
  activeModule = k;
  renderSelection(); renderModules(); requestDraw();
});
$('#modules').addEventListener('mouseover', (e) => { const li = e.target.closest('li'); const k = li ? +li.dataset.k : -1; if (k !== activeModule && li) { activeModule = k; requestDraw(); } });
$('#modules').addEventListener('mouseleave', () => { activeModule = -1; requestDraw(); });

$('#assign').onclick = () => {
  const v = $('#moduleSelect').value;
  if (v === '' || !selection.size) return;
  send('assign', { indices: [...selection].filter((i) => !vm.components[i].fixed), module: v === 'new' ? 'new' : +v });
};
$('#lockBtn').onclick = () => toggleLock();
$('#rotateBtn').onclick = () => rotateSelection();
$('#flipBtn').onclick = () => flipSelection();
$('#undo').onclick = () => send('undo');
$('#export').onclick = () => send('export');
$('#fit').onclick = () => fit();
$('#budget').onchange = () => renderLastOp();
for (const [id, key] of [['#sideSeg', 'side'], ['#ratsSeg', 'rats']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    opts[key] = b.dataset.v;
    for (const x of $(id).children) x.classList.toggle('on', x === b);
    requestDraw();
  });
}
$('#routeNow').onclick = () => startRouting();
$('#autoRoute').onchange = () => { renderRouteStatus(); maybeAutoRoute(); };
$('#routeCell').onchange = () => { layoutDirty = true; if ($('#autoRoute').checked) startRouting(); };
$('#showRoutes').onchange = (e) => { opts.routes = e.target.checked; requestDraw(); };
$('#layerToggles').addEventListener('change', (e) => { const l = e.target.dataset.layer; if (l !== undefined) { layerVisible[+l] = e.target.checked; requestDraw(); } });
$('#labels').onchange = (e) => { opts.labels = e.target.checked; requestDraw(); };
$('#pads').onchange = (e) => { opts.pads = e.target.checked; requestDraw(); };

// ---- loading ------------------------------------------------------------------------------------
fetch('./boards/index.json').then((r) => r.ok ? r.json() : []).then((list) => {
  if (!list.length) return;
  $('#samplesRow').hidden = false;
  $('#samples').insertAdjacentHTML('beforeend', list.map((b) => `<option value="${esc(b.file)}">${esc(b.name)}（${b.footprints} 个器件）</option>`).join(''));
}).catch(() => {});

$('#samples').onchange = async (e) => {
  if (!e.target.value) return;
  const r = await fetch(`./boards/${e.target.value}`);
  pendingSource = { name: e.target.value, text: await r.text() };
  $('#file').value = '';
  $('#load').disabled = false;
  $('#loadStatus').textContent = e.target.selectedOptions[0].textContent;
};
$('#file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingSource = { name: f.name, text: await f.text() };
  $('#samples').value = '';
  $('#load').disabled = false;
  $('#loadStatus').textContent = f.name;
};
$('#load').onclick = () => startLoad();

function startLoad() {
  if (!pendingSource || loading) return;
  if (!navigator.gpu) { $('#error').textContent = '这个浏览器不支持 WebGPU（需要 Chrome / Edge 113 以上）。'; return; }
  loading = true; loadStart = performance.now();
  $('#load').disabled = true; $('#error').textContent = '';
  $('#loadStatus').textContent = '载入中';
  const placement = document.querySelector('input[name=placement]:checked').value;
  send('load', { name: pendingSource.name, text: pendingSource.text, placement });
  const tick = () => { if (!loading) return; $('#hud').innerHTML = `<span class="busy">载入中 ${((performance.now() - loadStart) / 1000).toFixed(0)} s</span>`; setTimeout(tick, 500); };
  tick();
}

const stage = $('#stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); $('#drop').classList.add('over'); if (vm) $('#drop').classList.remove('hidden'); });
stage.addEventListener('dragleave', () => { $('#drop').classList.remove('over'); if (vm) $('#drop').classList.add('hidden'); });
stage.addEventListener('drop', async (e) => {
  e.preventDefault(); $('#drop').classList.remove('over');
  const f = e.dataTransfer.files[0]; if (!f) return;
  pendingSource = { name: f.name, text: await f.text() };
  $('#loadStatus').textContent = f.name;
  startLoad();
});

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- edits --------------------------------------------------------------------------------------
const movableSel = () => [...selection].filter((i) => !vm.components[i].fixed);

function toggleLock() {
  const sel = movableSel(); if (!sel.length) return;
  const lock = !sel.every((i) => locked.has(i));
  for (const i of sel) lock ? locked.add(i) : locked.delete(i);
  send('lock', { indices: sel, locked: lock });
  findConflicts(); renderSelection(); requestDraw();
}

function rotateSelection() {
  const sel = movableSel().filter((i) => vm.components[i].rotatable); if (!sel.length) return;
  const moves = sel.map((i) => ({ i, x: layout[i].x, y: layout[i].y, rotation: (layout[i].rotation + 1) & 3 }));
  for (const m of moves) { layout[m.i] = { ...layout[m.i], rotation: m.rotation }; disp[m.i] = { ...disp[m.i], rotation: m.rotation }; locked.add(m.i); }
  send('move', { moves, around: moves[0].i });
  requestDraw();
}

function flipSelection() {
  const sel = movableSel().filter((i) => vm.components[i].sides === 'any' && !vm.components[i].twoSided); if (!sel.length) return;
  const moves = sel.map((i) => ({ i, x: layout[i].x, y: layout[i].y, side: layout[i].side ? 0 : 1 }));
  for (const m of moves) { layout[m.i] = { ...layout[m.i], side: m.side }; disp[m.i] = { ...disp[m.i], side: m.side }; locked.add(m.i); }
  send('move', { moves, around: moves[0].i });
  requestDraw();
}

// ---- view transform & picking --------------------------------------------------------------
const toWorld = (sx, sy) => [(sx - view.ox) / view.scale, (sy - view.oy) / view.scale];

function fit() {
  if (!vm) return;
  userView = false;
  const w = canvas.clientWidth, h = canvas.clientHeight, m = 24;
  view.scale = Math.min((w - 2 * m) / vm.canvas.width, (h - 2 * m) / vm.canvas.height);
  view.ox = (w - vm.canvas.width * view.scale) / 2;
  view.oy = (h - vm.canvas.height * view.scale) / 2;
  requestDraw(); hud();
}

const sideOf = (i) => (disp[i].side ? 1 : 0);
const visible = (i) => opts.side === 'both' || vm.components[i].twoSided || sideOf(i) === (opts.side === 'top' ? 0 : 1);

function bodyRect(i, p = disp[i]) {
  const [w, h] = rotatedSize(vm.components[i], p.rotation);
  return [p.x - w / 2, p.y - h / 2, w, h];
}

/** Part under the world point: visible parts, the viewed side first, smallest body wins. */
function pick(wx, wy) {
  let best = -1, bestKey = Infinity;
  const preferred = opts.side === 'bottom' ? 1 : 0;
  for (let i = 0; i < vm.components.length; i++) {
    if (!visible(i)) continue;
    const [x, y, w, h] = bodyRect(i);
    if (wx < x || wx > x + w || wy < y || wy > y + h) continue;
    const key = (sideOf(i) === preferred || vm.components[i].twoSided ? 0 : 1e9) + w * h;
    if (key < bestKey) { bestKey = key; best = i; }
  }
  return best;
}

// ---- pointer input -------------------------------------------------------------------------------
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (!vm) return;
  canvas.setPointerCapture(e.pointerId);
  const sx = e.offsetX, sy = e.offsetY, [wx, wy] = toWorld(sx, sy);
  if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) { pan = { sx, sy, ox: view.ox, oy: view.oy }; canvas.style.cursor = 'grabbing'; return; }
  if (e.button !== 0) return;
  const hit = pick(wx, wy);
  if (hit >= 0) {
    if (e.shiftKey) { selection.has(hit) ? selection.delete(hit) : selection.add(hit); renderSelection(); requestDraw(); return; }
    if (!selection.has(hit)) { selection = new Set([hit]); renderSelection(); }
    const parts = movableSel();
    drag = { sx, sy, wx, wy, parts, origin: parts.map((i) => ({ ...disp[i] })), primary: vm.components[hit].fixed ? parts[0] : hit, moved: false };
  } else {
    box = { sx0: sx, sy0: sy, sx1: sx, sy1: sy, add: e.shiftKey };
  }
  requestDraw();
});
canvas.addEventListener('pointermove', (e) => {
  if (!vm) return;
  const sx = e.offsetX, sy = e.offsetY;
  pointer = toWorld(sx, sy);
  if (pan) { view.ox = pan.ox + sx - pan.sx; view.oy = pan.oy + sy - pan.sy; userView = true; requestDraw(); return; }
  if (drag) {
    if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
    if (!drag.moved) { drag.moved = true; for (const i of drag.parts) anims.delete(i); }
    const dx = pointer[0] - drag.wx, dy = pointer[1] - drag.wy;
    drag.parts.forEach((i, k) => {
      const o = drag.origin[k], [w, h] = rotatedSize(vm.components[i], o.rotation);
      disp[i] = { ...o, x: clamp(o.x + dx, w / 2, vm.canvas.width - w / 2), y: clamp(o.y + dy, h / 2, vm.canvas.height - h / 2) };
    });
    requestDraw(); return;
  }
  if (box) { box.sx1 = sx; box.sy1 = sy; requestDraw(); return; }
  hud();
});
canvas.addEventListener('pointerup', (e) => {
  if (pan) { pan = null; canvas.style.cursor = ''; return; }
  if (drag) {
    const d = drag; drag = null;
    if (d.moved && d.parts.length) {
      const moves = d.parts.map((i) => ({ i, x: disp[i].x, y: disp[i].y }));
      for (const m of moves) { layout[m.i] = { ...layout[m.i], x: m.x, y: m.y }; locked.add(m.i); }
      send('move', { moves, around: d.primary ?? moves[0].i });
      renderSelection();
    }
    requestDraw(); return;
  }
  if (box) {
    const [ax, ay] = toWorld(Math.min(box.sx0, box.sx1), Math.min(box.sy0, box.sy1)), [bx, by] = toWorld(Math.max(box.sx0, box.sx1), Math.max(box.sy0, box.sy1));
    const hits = [];
    if (Math.abs(box.sx1 - box.sx0) > 3 || Math.abs(box.sy1 - box.sy0) > 3) {
      for (let i = 0; i < vm.components.length; i++) {
        if (!visible(i)) continue;
        const [x, y, w, h] = bodyRect(i);
        if (x >= ax && y >= ay && x + w <= bx && y + h <= by) hits.push(i);
      }
    }
    selection = new Set(box.add ? [...selection, ...hits] : hits);
    box = null; renderSelection(); requestDraw();
  }
});
canvas.addEventListener('dblclick', (e) => {
  if (!vm) return;
  const hit = pick(...toWorld(e.offsetX, e.offsetY));
  if (hit < 0) return;
  selection = new Set(moduleOf[hit] >= 0 ? modules[moduleOf[hit]].members : [hit]);
  renderSelection(); requestDraw();
});
canvas.addEventListener('wheel', (e) => {
  if (!vm) return;
  e.preventDefault();
  const f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015));
  const [wx, wy] = toWorld(e.offsetX, e.offsetY);
  view.scale = clamp(view.scale * f, 0.2, 400);
  view.ox = e.offsetX - wx * view.scale; view.oy = e.offsetY - wy * view.scale; userView = true;
  requestDraw(); hud();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  if (e.key === ' ') { spaceDown = true; e.preventDefault(); return; }
  if (!vm) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); send('undo'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') { selection.clear(); renderSelection(); requestDraw(); }
  else if (k === 'r') rotateSelection();
  else if (k === 'f') flipSelection();
  else if (k === 'l') toggleLock();
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- drawing ------------------------------------------------------------------------------------------
let drawQueued = false;
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }

const cssCache = new Map();
function cssVar(name) { if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()); return cssCache.get(name); }
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener('change', () => { cssCache.clear(); if (vm) renderModules(); requestDraw(); });
const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : darkQuery.matches;
function moduleColor(k, alpha = 1) {
  if (k < 0) return cssVar('--part-free');
  const hue = (k * 137.508 + 200) % 360;
  return isDark() ? `hsl(${hue} 45% 42% / ${alpha})` : `hsl(${hue} 60% 70% / ${alpha})`;
}

function resize() {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  return dpr;
}
// Until the user pans or zooms, the board keeps fitting the canvas as it resizes.
let userView = false;
new ResizeObserver(() => { if (vm && !userView) fit(); else requestDraw(); }).observe(canvas);

function worldPinOf(pi) {
  const [c, x, y] = vm.pins[pi], p = disp[c];
  const [lx, ly] = localPin(x, y, p.side);
  const [rx, ry] = rotateQuarter(lx, ly, p.rotation);
  return [p.x + rx, p.y + ry];
}

function draw(now) {
  drawQueued = false;
  const dpr = resize();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = cssVar('--canvas-bg');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!vm) return;
  now = performance.now();

  // Tweens toward the worker's answer.
  for (const [i, a] of anims) {
    const t = Math.min(1, (now - a.t0) / 160), e = t * (2 - t);
    disp[i] = { ...a.to, x: a.from.x + (a.to.x - a.from.x) * e, y: a.from.y + (a.to.y - a.from.y) * e };
    if (t >= 1) { disp[i] = { ...a.to }; anims.delete(i); }
  }
  for (const [i, t0] of flashes) if (now - t0 > 900) flashes.delete(i);

  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
  const px = 1 / view.scale; // one screen pixel in mm

  // Board: outline with holes.
  ctx.beginPath();
  for (const c of vm.contours) { ctx.moveTo(c[0][0], c[0][1]); for (let k = 1; k < c.length; k++) ctx.lineTo(c[k][0], c[k][1]); ctx.closePath(); }
  ctx.fillStyle = cssVar('--board'); ctx.fill('evenodd');
  ctx.lineWidth = 1.5 * px; ctx.strokeStyle = cssVar('--board-edge'); ctx.stroke();

  // Parts: the far side first and faded, then the viewed side.
  const n = vm.components.length, near = opts.side === 'bottom' ? 1 : 0;
  const order = [];
  for (let i = 0; i < n; i++) if (visible(i) && sideOf(i) !== near && !vm.components[i].twoSided) order.push(i);
  const farCount = order.length;
  for (let i = 0; i < n; i++) if (visible(i) && (sideOf(i) === near || vm.components[i].twoSided)) order.push(i);
  const fg = cssVar('--fg'), padColor = cssVar('--pad'), fixedColor = cssVar('--part-fixed');
  const showPads = opts.pads && view.scale >= 2.5;
  order.forEach((i, k) => {
    const far = k < farCount && opts.side === 'both';
    const c = vm.components[i], [x, y, w, h] = bodyRect(i);
    const dim = activeModule >= 0 && moduleOf[i] !== activeModule;
    ctx.globalAlpha = (far ? 0.4 : 1) * (dim ? 0.35 : 1);
    ctx.fillStyle = c.fixed ? fixedColor : moduleColor(moduleOf[i]);
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = px; ctx.strokeStyle = fg; ctx.globalAlpha *= far ? 0.5 : 0.55;
    if (far) ctx.setLineDash([3 * px, 2 * px]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    if (showPads) {
      ctx.globalAlpha = (far ? 0.35 : 0.9) * (dim ? 0.35 : 1);
      ctx.fillStyle = padColor;
      const p = disp[i];
      for (const [lx0, ly0, pw, ph] of vm.pads[i]) {
        const [lx, ly] = localPin(lx0, ly0, p.side), [rx, ry] = rotateQuarter(lx, ly, p.rotation);
        const [sw, sh] = p.rotation & 1 ? [ph, pw] : [pw, ph];
        ctx.fillRect(p.x + rx - sw / 2, p.y + ry - sh / 2, sw, sh);
      }
    }
    ctx.globalAlpha = 1;
    // Locked: a filled corner; fixed (mechanical): a cross.
    if (locked.has(i) && !c.fixed) {
      const s = Math.min(w, h, 6 * px + Math.min(w, h) * 0.25);
      ctx.fillStyle = fg; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.closePath(); ctx.fill();
    } else if (c.fixed) {
      ctx.strokeStyle = fg; ctx.globalAlpha = 0.35; ctx.lineWidth = px;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.moveTo(x + w, y); ctx.lineTo(x, y + h); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (conflicts.has(i)) { ctx.strokeStyle = cssVar('--bad'); ctx.lineWidth = 2 * px; ctx.strokeRect(x, y, w, h); }
    const f = flashes.get(i);
    if (f !== undefined) {
      ctx.globalAlpha = 1 - (now - f) / 900; ctx.strokeStyle = cssVar('--flash'); ctx.lineWidth = 2.5 * px;
      ctx.strokeRect(x - px, y - px, w + 2 * px, h + 2 * px); ctx.globalAlpha = 1;
    }
  });

  if (opts.routes && routes) drawRoutes(px);

  // Ratsnest: a minimum spanning tree per net (a star for very large nets).
  if (opts.rats !== 'none') {
    const nets = new Set();
    if (opts.rats === 'all') vm.nets.forEach((_, k) => nets.add(k));
    else for (const i of selection) for (const k of compNets[i]) nets.add(k);
    ctx.strokeStyle = cssVar('--rats'); ctx.globalAlpha = opts.rats === 'all' ? 0.35 : 0.7; ctx.lineWidth = px;
    ctx.beginPath();
    for (const k of nets) drawNet(vm.nets[k].pins.map(worldPinOf));
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  // Selection outlines.
  ctx.strokeStyle = cssVar('--sel'); ctx.lineWidth = 2 * px;
  for (const i of selection) { const [x, y, w, h] = bodyRect(i); ctx.strokeRect(x - 1.5 * px, y - 1.5 * px, w + 3 * px, h + 3 * px); }

  // Labels in screen space.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (opts.labels) {
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = farCount; k < order.length; k++) {
      const i = order[k], [x, y, w, h] = bodyRect(i), sw = w * view.scale, sh = h * view.scale;
      if (sw < 22 || sh < 9) continue;
      const id = vm.components[i].id, size = Math.min(12, sh * 0.55, sw / Math.max(2, id.length) * 1.7);
      if (size < 7) continue;
      ctx.font = `${size}px system-ui, sans-serif`;
      ctx.fillText(id, view.ox + (x + w / 2) * view.scale, view.oy + (y + h / 2) * view.scale);
    }
  }
  if (box) {
    ctx.strokeStyle = cssVar('--sel'); ctx.fillStyle = cssVar('--sel'); ctx.lineWidth = 1;
    const x = Math.min(box.sx0, box.sx1), y = Math.min(box.sy0, box.sy1), w = Math.abs(box.sx1 - box.sx0), h = Math.abs(box.sy1 - box.sy0);
    ctx.globalAlpha = 0.12; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
  if (anims.size || flashes.size) requestDraw();
}

/**
 * Tracks: the far outer layer first, inner layers, then the viewed outer layer; nets
 * that share cells with another net drawn over them in red, unrouted nets as red
 * airwires. Out-of-date routes are faded.
 */
function drawRoutes(px) {
  const L = routes.layers.length, top = opts.side === 'bottom' ? L - 1 : 0, bottom = L - 1 - top;
  const order = [bottom, ...Array.from({ length: Math.max(0, L - 2) }, (_, k) => k + 1), top].filter((l, k, a) => a.indexOf(l) === k);
  const width = Math.max(1.2 * px, routes.stats.cell * 0.55), fade = routesStale ? 0.25 : 1;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const path = (layer, keep) => {
    const { coords, starts, nets } = routes.layers[layer];
    ctx.beginPath();
    for (let k = 0; k + 1 < starts.length; k++) {
      if (keep && !keep(nets[k])) continue;
      const a = starts[k], b = starts[k + 1];
      ctx.moveTo(coords[2 * a], coords[2 * a + 1]);
      for (let q = a + 1; q < b; q++) ctx.lineTo(coords[2 * q], coords[2 * q + 1]);
    }
  };
  for (const l of order) {
    if (!layerVisible[l]) continue;
    ctx.globalAlpha = fade * (l === top ? 0.85 : 0.5);
    ctx.strokeStyle = layerColor(l, L); ctx.lineWidth = width;
    path(l); ctx.stroke();
  }
  if (!routesStale) {
    ctx.globalAlpha = 0.9; ctx.strokeStyle = cssVar('--bad'); ctx.lineWidth = width * 0.6;
    for (const l of order) if (layerVisible[l]) { path(l, (n) => routes.status[n] === 2); ctx.stroke(); }
  }
  // Vias.
  ctx.globalAlpha = fade * 0.9; ctx.fillStyle = cssVar('--fg');
  const v = routes.vias, r = Math.max(1.5 * px, routes.stats.cell * 0.45);
  ctx.beginPath();
  for (let k = 0; k < v.length; k += 2) { ctx.moveTo(v[k] + r, v[k + 1]); ctx.arc(v[k], v[k + 1], r, 0, 2 * Math.PI); }
  ctx.fill();
  // Unrouted nets.
  if (!routesStale) {
    ctx.globalAlpha = 0.9; ctx.strokeStyle = cssVar('--bad'); ctx.lineWidth = 1.5 * px; ctx.setLineDash([4 * px, 3 * px]);
    ctx.beginPath();
    routes.status.forEach((st, n) => { if (st === 3) drawNet(vm.nets[n].pins.map(worldPinOf)); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

function drawNet(pts) {
  const m = pts.length;
  if (m < 2) return;
  if (m > 40) { // star from the pin nearest the centroid
    let cx = 0, cy = 0; for (const [x, y] of pts) { cx += x; cy += y; } cx /= m; cy /= m;
    let r = 0, best = Infinity; pts.forEach(([x, y], k) => { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d < best) { best = d; r = k; } });
    for (let k = 0; k < m; k++) if (k !== r) { ctx.moveTo(pts[r][0], pts[r][1]); ctx.lineTo(pts[k][0], pts[k][1]); }
    return;
  }
  const inTree = new Uint8Array(m), dist = new Float64Array(m).fill(Infinity), from = new Int32Array(m);
  dist[0] = 0;
  for (let it = 0; it < m; it++) {
    let u = -1; for (let k = 0; k < m; k++) if (!inTree[k] && (u < 0 || dist[k] < dist[u])) u = k;
    inTree[u] = 1;
    if (it) { ctx.moveTo(pts[from[u]][0], pts[from[u]][1]); ctx.lineTo(pts[u][0], pts[u][1]); }
    for (let k = 0; k < m; k++) if (!inTree[k]) { const d = Math.abs(pts[k][0] - pts[u][0]) + Math.abs(pts[k][1] - pts[u][1]); if (d < dist[k]) { dist[k] = d; from[k] = u; } }
  }
}

function hud() {
  if (loading) return;
  const items = [];
  if (vm) {
    items.push(`${vm.components.length} 个器件 · ${modules.filter((m) => m.members.length).length} 个模块`);
    items.push(`缩放 ${view.scale.toFixed(1)} px/mm`);
    if (pointer) items.push(`${pointer[0].toFixed(2)}, ${pointer[1].toFixed(2)} mm`);
    if (inFlight > 0 || workerBusy) items.push(`<span class="busy">计算中${inFlight > 1 ? `（排队 ${inFlight}）` : ''}</span>`);
  }
  $('#hud').innerHTML = items.map((t) => t.startsWith('<span') ? t : `<span>${t}</span>`).join('');
}

requestDraw();

// Read-only handle for debugging and scripted checks.
window.__editor = { routes: () => routes && { stats: routes.stats, ms: routes.ms, stale: routesStale, running: !!routeRun }, drawNow: () => { const t = performance.now(); draw(); return performance.now() - t; }, setRats: (v) => { opts.rats = v; }, state: () => ({ layout: layout.map((p) => ({ ...p })), locked: [...locked], modules: modules.map((m) => ({ ...m, members: [...m.members] })), conflicts: [...conflicts], busy: inFlight > 0 || workerBusy }) };
