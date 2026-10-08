// Editable PPTX of the RSI deck (docs/rsi-deck/index.html): native PowerPoint charts, shapes and
// text boxes, same data as the HTML version.
//   NODE_PATH=<dir with pptxgenjs> node docs/rsi-deck/build-pptx.cjs [out.pptx]
const pptxgen = require('pptxgenjs');
const fs = require('fs');
const path = require('path');
const { applyTheme } = require(process.env.APPLY_THEME);

const DIR = __dirname;
const OUT = process.argv[2] || path.join(DIR, 'rsi-deck-editable.pptx');

// ---------- theme ----------
const HEX = { ink: '0B0B0B', ink2: '52514E', muted: '8A8984', rule: 'DCDAD3', soft: 'F3F2EE', grid: 'E4E2DC',
  blue: '2A78D6', orange: 'EB6834', aqua: '1BAF7A', yellow: 'EDA100', pink: 'E87BA4', gray: 'B9B7B0', human: '52514E',
  blueBg: 'EAF2FB', orangeBg: 'FDEEE6', aquaBg: 'E6F6EF', yellowBg: 'FDF5E0' };
const THEME = { name: 'RSI Deck', headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei',
  colors: { dk1: HEX.ink, lt1: 'FFFFFF', dk2: HEX.ink2, lt2: HEX.soft, accent1: HEX.blue, accent2: HEX.orange, accent3: HEX.aqua,
    accent4: HEX.yellow, accent5: HEX.pink, accent6: HEX.gray, hlink: HEX.blue, folHlink: HEX.ink2 } };

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = '自进化 Harness：PCB 布局';
pres.author = 'oxyflour';
const C = pres.SchemeColor;
const W = 13.333, M = 0.55, CW = W - 2 * M;

pres.defineSlideMaster({ title: 'CONTENT', background: { color: 'FFFFFF' },
  objects: [{ placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.62, w: CW, h: 0.62, fontSize: 26, bold: true, color: C.text1, valign: 'top', margin: 0 }, text: '' } }],
  slideNumber: { x: W - 1.1, y: 7.08, w: 0.6, h: 0.3, fontSize: 10, color: HEX.ink2, align: 'right' } });
pres.defineSlideMaster({ title: 'COVER', background: { color: 'FFFFFF' },
  objects: [{ placeholder: { options: { name: 'title', type: 'title', x: M, y: 2.35, w: CW, h: 1.0, fontSize: 36, bold: true, color: C.text1, valign: 'top', margin: 0 }, text: '' } }] });

// ---------- helpers ----------
const SECTIONS = new Set();
function slide(section, layout = 'CONTENT') {
  if (!SECTIONS.has(section)) { pres.addSection({ title: section }); SECTIONS.add(section); }
  return pres.addSlide({ masterName: layout, sectionTitle: section });
}
const T = (s, text, o) => s.addText(text, { isTextBox: true, margin: 0, valign: 'top', fontSize: 13, color: C.text1, ...o });
function head(s, kicker, title, sub, size) {
  T(s, kicker, { x: M, y: 0.32, w: CW, h: 0.26, fontSize: 11, bold: true, color: C.accent1, objectName: 'Kicker' });
  s.addText(title, { placeholder: 'title', ...(size ? { fontSize: size } : {}) });
  if (sub) T(s, sub, { x: M, y: 1.28, w: CW, h: 0.5, fontSize: 13, color: C.text2, objectName: 'Subtitle' });
}
const foot = (s, text, y = 6.78) => T(s, text, { x: M, y, w: CW, h: 0.5, fontSize: 10, color: HEX.muted.length ? C.text2 : C.text2, objectName: 'Footnote' });
function cardHead(s, x, y, w, h3, note) {
  T(s, h3, { x, y, w, h: 0.3, fontSize: 13, bold: true, objectName: 'Chart title' });
  if (note) T(s, note, { x, y: y + 0.32, w, h: 0.42, fontSize: 10, color: C.text2, objectName: 'Chart note' });
}
const axis = (o = {}) => ({
  catAxisLabelColor: HEX.ink2, valAxisLabelColor: HEX.ink2, catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
  catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt', legendFontFace: '+mn-lt', legendFontSize: 10,
  valAxisTitleFontFace: '+mn-lt', valAxisTitleFontSize: 10, valAxisTitleColor: HEX.ink2, catAxisTitleFontFace: '+mn-lt', catAxisTitleFontSize: 10, catAxisTitleColor: HEX.ink2,
  valGridLine: { color: HEX.grid, size: 0.75 }, catGridLine: { style: 'none' }, catAxisLineShow: true, valAxisLineShow: false,
  showLegend: false, legendPos: 't', ...o });
function vt(o, title) { return title ? { ...o, showValAxisTitle: true, valAxisTitle: title } : o; }
function bar(s, pos, labels, series, o = {}) {
  s.addChart(pres.ChartType.bar, series.map((x) => ({ name: x.name, labels, values: x.values })), {
    ...pos, barDir: o.h ? 'bar' : 'col', barGapWidthPct: o.gap ?? 60, chartColors: o.pointColors || series.map((x) => x.color),
    ...vt(axis({ showLegend: series.length > 1, valAxisMinVal: o.min, valAxisMaxVal: o.max, catAxisLabelRotate: o.rot ?? 0,
      ...(o.log ? { valAxisLogScaleBase: 10 } : {}), ...(o.extra || {}) }), o.yt) });
}
// Dot plot / line chart on a category axis: series with line:false are markers only.
function lines(s, pos, labels, series, o = {}) {
  const parts = series.map((x) => ({ type: pres.ChartType.line, data: [{ name: x.name, labels, values: x.values }],
    options: { chartColors: [x.color], lineSize: x.line ? 2 : 0, lineDataSymbol: x.line && !x.marker ? 'none' : (x.symbol || 'circle'), lineDataSymbolSize: x.size || 8,
      lineDataSymbolLineColor: 'FFFFFF', lineDataSymbolLineSize: 1, ...(x.dash ? { lineDash: 'dash' } : {}) } }));
  s.addChart(parts, { ...pos, ...vt(axis({ showLegend: !!o.legend, valAxisMinVal: o.min, valAxisMaxVal: o.max, catAxisLabelRotate: o.rot ?? 0,
    ...(o.log ? { valAxisLogScaleBase: 10 } : {}), ...(o.extra || {}) }), o.yt) });
}
const ref = (labels, v, name = '人工') => ({ name, values: labels.map(() => v), color: HEX.human, line: true, dash: true });
// Range plot: invisible base + thin range bar, dots for each run (or the two ends).
function ranges(s, pos, labels, rows, o = {}) {
  const lo = rows.map((r) => Math.min(...(r.runs || [r.min, r.max]))), hi = rows.map((r) => Math.max(...(r.runs || [r.min, r.max])));
  const base = o.min ?? 0;
  const maxRuns = Math.max(...rows.map((r) => (r.runs || [r.min, r.max]).length));
  const dots = [...Array(maxRuns)].map((_, k) => ({ type: pres.ChartType.line, data: [{ name: `运行 ${k + 1}`, labels, values: rows.map((r) => { const v = r.runs || [r.min, r.max]; return k < v.length ? v[k] : null; }) }],
    options: { chartColors: [o.color || HEX.blue], lineSize: 0, lineDataSymbol: 'circle', lineDataSymbolSize: 9, lineDataSymbolLineColor: 'FFFFFF', lineDataSymbolLineSize: 1 } }));
  const extra = o.ref ? [{ type: pres.ChartType.line, data: [{ name: o.ref[1], labels, values: labels.map(() => o.ref[0]) }], options: { chartColors: [HEX.human], lineSize: 1.5, lineDash: 'dash', lineDataSymbol: 'none' } }] : [];
  s.addChart([{ type: pres.ChartType.bar, data: [{ name: 'base', labels, values: lo }, { name: '范围', labels, values: hi.map((v, i) => Math.max(v - lo[i], (o.max - base) * 0.004)) }],
    options: { barGrouping: 'stacked', barGapWidthPct: 400, chartColors: ['FFFFFF', o.rangeColor || 'B8D2F1'], chartColorsOpacity: 100 } }, ...dots, ...extra],
  { ...pos, ...vt(axis({ valAxisMinVal: base, valAxisMaxVal: o.max, valGridLine: { style: 'none' }, valAxisLabelFormatCode: o.fmt || 'General', catAxisLabelRotate: o.rot ?? 0 }), o.yt),
    // the stacked base starts at `base`, so shift the axis labels back
    valAxisDisplayUnit: undefined });
}
function box(s, x, y, w, h, fill, line, o = {}) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: fill }, line: { color: line, width: o.lw || 1 }, objectName: o.name || 'Box' });
}
function boxText(s, x, y, w, h, fill, line, title, body, o = {}) {
  box(s, x, y, w, h, fill, line, o);
  const runs = [{ text: title, options: { bold: true, fontSize: o.ts || 12, color: o.tc || C.text1, breakLine: !!body } }];
  if (body) runs.push({ text: body, options: { fontSize: o.bs || 10, color: C.text2 } });
  s.addText(runs, { isTextBox: true, x, y, w, h, align: o.align || 'center', valign: 'middle', margin: 4 });
}
function arrow(s, x1, y1, x2, y2, color = HEX.ink2, dash) {
  s.addShape(pres.ShapeType.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 0.001, h: Math.abs(y2 - y1) || 0.001,
    flipH: x2 < x1, flipV: y2 < y1, line: { color, width: 1.5, endArrowType: 'triangle', ...(dash ? { dashType: 'dash' } : {}) }, objectName: 'Arrow' });
}
function bullets(s, items, pos, size = 15) {
  s.addText(items.map((it, i) => ({ text: it[0], options: { bullet: true, bold: true, color: C.accent1, fontSize: size, breakLine: false, paraSpaceAfter: 8 } }))
    .flatMap((b, i) => [b, { text: items[i][1], options: { fontSize: size, color: C.text1, breakLine: i < items.length - 1 } }]),
  { isTextBox: true, ...pos, valign: 'top', margin: 0, paraSpaceAfter: 8 });
}
function pngSize(f) { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
function imageFit(s, file, x, y, w, h, alt) {
  const { w: iw, h: ih } = pngSize(file), k = Math.min(w / iw, h / ih), dw = iw * k, dh = ih * k;
  s.addShape(pres.ShapeType.rect, { x, y, w, h, fill: { color: 'FFFFFF' }, line: { color: HEX.rule, width: 0.75 }, objectName: 'Image frame' });
  s.addImage({ path: file, x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh, altText: alt, objectName: alt });
}

// ---------- data ----------
const B = ['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp', 'safety', 'pic', 'nxp', 'rx', 'k60', 'acc'];
const NETS = [46, 86, 124, 108, 162, 157, 163, 186, 310, 370, 400, 318, 617];
const MD = {
  human: [[46, 33], [86, 61], [124, 63], [108, 75], [162, 316], [157, 189], [163, 204], [186, 251], [310, 363], [370, 601], [400, 650], [318, 345], [617, 2708]],
  webgpu: [[46, 41, 3], [86, 116, 3], [124, 123, 3], [108, 201, 4], [156, 541, 6], [157, 351, 5], [163, 433, 5], [172, 939, 7], [199, 1713, 10], [370, 1239, 10], [400, 1292, 11], [92, 2489, 11], [529, 4847, 15]],
  cypress: [[46, 55, 35], [71, 273, 29], [122, 292, 33], [108, 278, 42], [162, 571, 65], [155, 676, 84], [158, 794, 55], [113, 1483, 40], [35, 3595, 129], [360, 2154, 115], [392, 2341, 137], [16, 4245, 206], [431, 5072, 390]],
  init: [[46, 32], [86, 81], [124, 112], [108, 268], [162, 307], [151, 418], [163, 328], [186, 367], [213, 896], [370, 780], [400, 803], [305, 697], [617, 3298]],
  initWeb: [[46, 34], [86, 71], [124, 101], [108, 152], [162, 291], [157, 227], [163, 243], [186, 338], [308, 492], [370, 752], [400, 782], [318, 557], [617, 3434]] };
const rate = (k) => MD[k].map((r, i) => +(100 * r[0] / NETS[i]).toFixed(1));
const vr = (k) => MD[k].map((r, i) => +(r[1] / MD.human[i][1]).toFixed(2));
const A = JSON.parse(fs.readFileSync(path.join(DIR, 'agent-v7.json'), 'utf8'));

// ================= slides =================
// 1 cover
{ const s = slide('开场', 'COVER');
  T(s, 'AI4AI · 递归自我改进（RSI）', { x: M, y: 1.85, w: CW, h: 0.35, fontSize: 14, bold: true, color: C.accent1 });
  s.addText('自进化 Harness：让 Agent 的 PCB 布局接近人工水平', { placeholder: 'title' });
  T(s, '外层 Agent（Opus）编写并改进工具和 prompt，内层 Agent（dsh / DeepSeek Flash）用它们做布局；指标：布通网络数、过孔数、HPWL。全部数字来自 webgpu-layout 与 cypress-layout 两个仓库的实验记录（2026-09-25 至 10-07）。',
    { x: M, y: 3.45, w: 10.5, h: 0.9, fontSize: 15, color: C.text2 });
  [['13', '块真实 KiCad 板（46–1607 个信号网络）'], ['v1→v12', 'prompt / tool 版本，每版 3 个 dsh 会话'], ['0.35–0.52', '元 / 每个 15 分钟布局会话']].forEach(([n, l], i) => {
    const x = M + i * 4.1;
    T(s, n, { x, y: 4.75, w: 3.8, h: 0.8, fontSize: 40, bold: true, color: C.accent1 });
    T(s, l, { x, y: 5.6, w: 3.8, h: 0.4, fontSize: 12, color: C.text2 });
  });
  s.addNotes('封面。'); }

// 2 concept
{ const s = slide('1 基本思路');
  head(s, '1 · 基本思路', 'Agent = LLM + Harness；外层 Agent 优化内层 Agent 的 Harness',
    'LLM 是固定的，能改的是 Harness：给它看什么（prompt / skill / memory）、给它什么手（tool / MCP / CLI）、谁来规划和验收（planner / verifier）。');
  const x0 = M, y0 = 2.0;
  s.addShape(pres.ShapeType.roundRect, { x: x0, y: y0, w: 6.2, h: 4.6, rectRadius: 0.12, fill: { color: 'FFFFFF' }, line: { color: HEX.blue, width: 1.5, dashType: 'dash' }, objectName: 'Outer agent' });
  T(s, '外层 Agent（Opus）：读轨迹 → 改 Harness', { x: x0 + 0.2, y: y0 + 0.15, w: 5.8, h: 0.3, fontSize: 13, bold: true, color: C.accent1 });
  box(s, x0 + 0.35, y0 + 0.6, 5.5, 3.8, HEX.soft, HEX.rule, { name: 'Inner agent' });
  T(s, '内层 Agent（dsh / DeepSeek Flash）', { x: x0 + 0.55, y: y0 + 0.75, w: 5, h: 0.3, fontSize: 12, bold: true });
  boxText(s, x0 + 0.55, y0 + 1.25, 1.4, 0.8, 'FFFFFF', HEX.ink2, 'LLM', '不改模型权重', { ts: 16 });
  T(s, '+', { x: x0 + 2.05, y: y0 + 1.4, w: 0.3, h: 0.4, fontSize: 22, color: C.text2 });
  box(s, x0 + 2.45, y0 + 1.15, 3.2, 3.1, 'FFFFFF', HEX.blue, { lw: 1.5, name: 'Harness' });
  T(s, 'Harness（可被优化）', { x: x0 + 2.45, y: y0 + 1.22, w: 3.2, h: 0.3, fontSize: 12, bold: true, color: C.accent1, align: 'center' });
  [['Prompt', '设计规则、经验、建议；skill / memory', HEX.blueBg], ['Tool', 'CLI：初始布局、布局器、布线器；MCP', HEX.orangeBg], ['Verifier', '评分器：鲁棒路由打分', HEX.aquaBg], ['Planner（可选）', '预算、调用次数、停止条件', HEX.yellowBg]]
    .forEach(([t, b], i) => boxText(s, x0 + 2.6, y0 + 1.6 + i * 0.64, 2.9, 0.56, [HEX.blueBg, HEX.orangeBg, HEX.aquaBg, HEX.yellowBg][i], [HEX.blueBg, HEX.orangeBg, HEX.aquaBg, HEX.yellowBg][i], t, b, { align: 'left', ts: 11, bs: 9.5 }));
  bullets(s, [['AI4AI 的一个用法：', '外层 Agent 不直接解题，而是改进内层 Agent 解题用的 Harness。'],
    ['Prompt：', '外层 Agent 从轨迹里总结的人工布局经验，写成内层 Agent 能执行的规则。'],
    ['Tool：', '外层 Agent 写代码，改接口、改算法、修 bug，每次调用控制在 3 分钟以内。'],
    ['Verifier：', '评分本身也是被优化的对象。评分噪声太大时，好的 prompt 也选不出来。']], { x: 7.2, y: 2.6, w: 5.55, h: 3.6 }); }

// 3 RSI loop
{ const s = slide('1 基本思路');
  head(s, '1 · 基本思路', '基本 RSI 循环：运行 → 收集轨迹 → 分析 → 改 prompt + tool');
  const cx = 2.95, cy = 4.15, r = 1.75;
  s.addShape(pres.ShapeType.ellipse, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: { color: 'FFFFFF' }, line: { color: HEX.blue, width: 2 }, objectName: 'Cycle' });
  T(s, '外层 Agent\n驱动每一轮', { x: cx - 0.9, y: cy - 0.3, w: 1.8, h: 0.6, fontSize: 12, color: C.text2, align: 'center' });
  [['1 运行', '3 个 dsh 会话并行', 0, -1], ['2 轨迹', 'events.jsonl', 1, 0], ['3 分析', '耗时、决策、失败点', 0, 1], ['4 改进', 'prompt vN+1、tool', -1, 0]]
    .forEach(([t, b, dx, dy]) => boxText(s, cx + dx * r - 0.8, cy + dy * r - 0.33, 1.6, 0.66, 'FFFFFF', HEX.ink, t, b, { ts: 12, bs: 9.5 }));
  T(s, '顺时针循环', { x: cx + 1.0, y: cy - 1.75, w: 1.4, h: 0.3, fontSize: 10, color: C.accent1 });
  const X = 5.55, Wc = W - M - X;
  const L = ['Cypress 单独\n随机起点', '工具起点 + Cypress\n无 Agent', '加入 Agent', 'Agent +\nIC 放置规则', 'Agent +\n器件旋转'];
  const clean = [[23, 16, 16], [207, 209, 217], [300, 262, 287], [299, 315, 283], [318, 297, 300]], vias = [[4351, 4165, 4200], [1137, 1135, 1036], [642, 732, 819], [678, 604, 774], [504, 651, 631]];
  const mean = (V) => V.map((v) => Math.round(v.reduce((a, b) => a + b) / v.length));
  const runs = (V, col) => [0, 1, 2].map((k) => ({ name: `会话 / 种子 ${k + 1}`, values: V.map((v) => v[k]), color: col, size: 7 }));
  cardHead(s, X, 1.35, Wc, 'k60（cypress-layout harness）：每一轮 RSI 之后的结果', '点 = 单个会话（或种子），线 = 均值，虚线 = 人工布局。每一步都是外层 Agent 读轨迹后改了 tool 或 prompt。');
  lines(s, { x: X, y: 2.1, w: Wc, h: 2.15 }, L, [{ name: '均值', values: mean(clean), color: HEX.blue, line: true }, ...runs(clean, '7FAEE6'), ref(L, 318, '人工 318')], { min: 0, max: 330, yt: '布通网络（个，共 318）', extra: { catAxisHidden: true } });
  lines(s, { x: X, y: 4.25, w: Wc, h: 2.45 }, L, [{ name: '均值', values: mean(vias), color: HEX.orange, line: true }, ...runs(vias, 'F2A27F'), ref(L, 291, '人工 291')], { log: true, min: 200, max: 6000, yt: '过孔（个，对数轴）' });
  foot(s, '加入 Agent：起点改为 pins-small + 去耦电容，由 Agent 定 IC 布局；IC 放置规则：删掉被人工数据否掉的“大 IC 下不放件”规则，place 提速；器件旋转：冻结 Cypress 旋转，IC 旋转由 Agent 定、小件旋转由工具推导。另一个 harness 上迭代 12 个版本后发现，会话之间的差距大于版本之间的差异，这引出了后面的“评分器降噪”。', 6.72); }

// 4 Cypress baseline
{ const s = slide('2 场景');
  head(s, '2 · 场景：自动布局', "没有 AI 时：拼算法。Cypress（NVlabs，ISPD'25）单独使用的效果",
    '相同协议：原始板面、机械件和插件固定、0.1 mm 合法化、原生精确布线器（多网格相位取中位）。随机起点，3 个种子取中位数。');
  const w2 = (CW - 0.4) / 2;
  cardHead(s, M, 1.95, w2, '布通率（%，布通的信号网络 ÷ 总数）', '人工布局都是 100%。');
  bar(s, { x: M, y: 2.6, w: w2, h: 4.05 }, B, [{ name: 'Cypress 单独（随机起点）', values: rate('cypress'), color: HEX.orange }], { min: 0, max: 100, rot: -45 });
  cardHead(s, M + w2 + 0.4, 1.95, w2, '过孔数 ÷ 人工过孔数（倍）', '1 = 与人工持平。');
  bar(s, { x: M + w2 + 0.4, y: 2.6, w: w2, h: 4.05 }, B, [{ name: 'Cypress 单独（随机起点）', values: vr('cypress'), color: HEX.orange }], { min: 0, rot: -45 });
  foot(s, 'k60：Cypress 只布通 16/318，过孔 4245，人工 345；pic：35/310。单次放置时间中位数 64.9 s（13 板），acc 上 390 s。'); }

// 5 mapping
{ const s = slide('2 场景');
  head(s, '2 · 场景：自动布局', '用 AI4AI 的思路：布局问题里的 Harness 是什么');
  const cols = [['Prompt：给 Agent 的设计规则', HEX.blueBg, ['先定 IC 的位置、面、旋转', '先写 3 个结构不同的 floorplan', '差值在 metrics.noise 以内就是噪声', '被数据否掉的规则会删掉，比如“大 IC 下面不放件”']],
    ['Tool：布局器、布线器、初始布局', HEX.orangeBg, ['info / map / check / place / inspect / submit', '初始布局（起点）：从网表推导', 'WebGPU 布局器 / Cypress', '原生 C++ 布线器']],
    ['Verifier：评分器', HEX.aquaBg, ['按板子线距和规则布线，用人工的真实走线校准', '多网格相位取中位数，去掉噪声', '每次提交都由外部重新评估', '合法性：重叠、外框、禁布区、固定件']]];
  const w3 = (CW - 0.6) / 3;
  cols.forEach(([t, bg, items], i) => { const x = M + i * (w3 + 0.3);
    box(s, x, 1.6, w3, 4.3, bg, bg, { name: t });
    T(s, t, { x: x + 0.25, y: 1.8, w: w3 - 0.5, h: 0.5, fontSize: 16, bold: true });
    s.addText(items.map((it, k) => ({ text: it, options: { bullet: true, breakLine: k < items.length - 1 } })), { isTextBox: true, x: x + 0.25, y: 2.45, w: w3 - 0.5, h: 3.3, fontSize: 14, color: C.text1, valign: 'top', margin: 0, paraSpaceAfter: 10 }); });
  T(s, '这三样都由外层 Agent 优化。下面依次看流程，以及三个关键模块的演化：初始布局、布局器、布线器。', { x: M, y: 6.15, w: CW, h: 0.4, fontSize: 14, color: C.text2 }); }

// 6 metrics
{ const s = slide('2 场景');
  head(s, '2 · 场景：自动布局', '三个关键指标怎么算：布通网络数、过孔数、HPWL', '每个候选布局都先过同一个合法化器，再用同一个布线器真实地布一遍线，指标从布线结果里读出来。HPWL 不需要布线。');
  const w3 = (CW - 0.6) / 3, y = 1.95;
  const xs = [0, 1, 2].map((i) => M + i * (w3 + 0.3));
  [['布通网络数（个，越多越好）'], ['过孔数（个，越少越好）'], ['HPWL（mm，越短越好）']].forEach(([t], i) => T(s, t, { x: xs[i], y, w: w3, h: 0.35, fontSize: 15, bold: true }));
  // clean diagram
  { const x = xs[0], y0 = y + 0.5, pad = (a, b) => s.addShape(pres.ShapeType.rect, { x: a, y: b, w: 0.18, h: 0.18, fill: { color: HEX.ink2 }, line: { color: HEX.ink2 }, objectName: 'Pad' });
    const seg = (x1, y1, x2, y2, col, dash) => s.addShape(pres.ShapeType.line, { x: x1, y: y1, w: x2 - x1 || 0.001, h: y2 - y1 || 0.001, line: { color: col, width: dash ? 1.25 : 3.5, ...(dash ? { dashType: 'dash' } : {}) }, objectName: 'Track' });
    pad(x + 0.1, y0 + 0.1); pad(x + 3.3, y0 + 0.1); seg(x + 0.28, y0 + 0.19, x + 3.3, y0 + 0.19, HEX.blue); T(s, 'A：布通（clean）', { x: x + 1.1, y: y0 - 0.12, w: 1.6, h: 0.22, fontSize: 9.5, color: C.accent1 });
    pad(x + 0.1, y0 + 0.65); pad(x + 3.3, y0 + 0.65); seg(x + 0.28, y0 + 0.74, x + 3.3, y0 + 0.74, HEX.aqua);
    pad(x + 1.6, y0 + 0.35); pad(x + 1.6, y0 + 1.0); seg(x + 1.69, y0 + 0.53, x + 1.69, y0 + 1.0, HEX.yellow);
    s.addShape(pres.ShapeType.rect, { x: x + 1.6, y: y0 + 0.65, w: 0.18, h: 0.18, fill: { type: 'none' }, line: { color: 'E34948', width: 2 }, objectName: 'Conflict' });
    T(s, 'B、C 抢同一格：overflow', { x: x + 1.9, y: y0 + 0.9, w: 1.9, h: 0.22, fontSize: 9.5, color: 'E34948' });
    pad(x + 0.1, y0 + 1.35); pad(x + 3.3, y0 + 1.35); seg(x + 0.28, y0 + 1.44, x + 1.4, y0 + 1.44, HEX.pink); seg(x + 1.4, y0 + 1.44, x + 3.3, y0 + 1.44, 'E34948', true);
    T(s, 'D：没连上（open）', { x: x + 1.9, y: y0 + 1.18, w: 1.7, h: 0.22, fontSize: 9.5, color: 'E34948' }); }
  // via diagram
  { const x = xs[1], y0 = y + 0.55, gap = 0.42;
    ['L1 顶层', 'L2', 'L3', 'L4 底层'].forEach((l, k) => { T(s, l, { x, y: y0 + k * gap - 0.1, w: 0.7, h: 0.22, fontSize: 9.5, color: C.text2 });
      s.addShape(pres.ShapeType.line, { x: x + 0.75, y: y0 + k * gap, w: w3 - 0.8, h: 0.001, line: { color: HEX.rule, width: 0.75 }, objectName: 'Layer' }); });
    s.addShape(pres.ShapeType.line, { x: x + 0.8, y: y0, w: 0.75, h: 0.001, line: { color: 'E34948', width: 3.5 }, objectName: 'Track' });
    s.addShape(pres.ShapeType.rect, { x: x + 1.5, y: y0 - 0.05, w: 0.12, h: 3 * gap + 0.1, fill: { color: HEX.orange }, line: { color: HEX.orange }, objectName: 'Via' });
    s.addShape(pres.ShapeType.line, { x: x + 1.6, y: y0 + 3 * gap, w: 0.7, h: 0.001, line: { color: HEX.blue, width: 3.5 }, objectName: 'Track' });
    s.addShape(pres.ShapeType.line, { x: x + 2.5, y: y0, w: 0.4, h: 0.001, line: { color: 'E34948', width: 3.5 }, objectName: 'Track' });
    s.addShape(pres.ShapeType.rect, { x: x + 2.86, y: y0 - 0.05, w: 0.12, h: gap + 0.1, fill: { color: HEX.orange }, line: { color: HEX.orange }, objectName: 'Via' });
    s.addShape(pres.ShapeType.line, { x: x + 2.96, y: y0 + gap, w: 0.55, h: 0.001, line: { color: HEX.aqua, width: 3.5 }, objectName: 'Track' });
    T(s, '贯穿 L1→L4：层间切换 3 次，物理过孔 1 个', { x: x + 0.75, y: y0 + 3 * gap + 0.12, w: 3.2, h: 0.22, fontSize: 9.5, color: C.accent2 });
    T(s, 'L1→L2：切换 1 次', { x: x + 2.35, y: y0 + gap + 0.12, w: 1.5, h: 0.22, fontSize: 9.5, color: C.accent2 }); }
  // HPWL diagram
  { const x = xs[2] + 0.4, y0 = y + 0.6, bw = 2.8, bh = 1.3;
    s.addShape(pres.ShapeType.rect, { x, y: y0, w: bw, h: bh, fill: { color: HEX.aquaBg }, line: { color: HEX.aqua, width: 1.25, dashType: 'dash' }, objectName: 'Bounding box' });
    [[0, 0.7], [1.1, 0], [2.8, 1.0], [1.7, 1.3], [0.7, 0.8]].forEach(([dx, dy]) => s.addShape(pres.ShapeType.ellipse, { x: x + dx - 0.07, y: y0 + dy - 0.07, w: 0.14, h: 0.14, fill: { color: HEX.ink }, line: { color: HEX.ink }, objectName: 'Pin' }));
    s.addShape(pres.ShapeType.line, { x, y: y0 + bh + 0.15, w: bw, h: 0.001, line: { color: HEX.aqua, width: 1.25, beginArrowType: 'triangle', endArrowType: 'triangle' }, objectName: 'Width' });
    T(s, '宽 w', { x: x + bw / 2 - 0.3, y: y0 + bh + 0.2, w: 0.6, h: 0.22, fontSize: 10, align: 'center' });
    s.addShape(pres.ShapeType.line, { x: x + bw + 0.15, y: y0, w: 0.001, h: bh, line: { color: HEX.aqua, width: 1.25, beginArrowType: 'triangle', endArrowType: 'triangle' }, objectName: 'Height' });
    T(s, '高 h', { x: x + bw + 0.2, y: y0 + bh / 2 - 0.11, w: 0.5, h: 0.22, fontSize: 10 });
    T(s, '一个网络的 5 个引脚', { x, y: y0 - 0.32, w: bw, h: 0.22, fontSize: 10, align: 'center' }); }
  const tx = [
    '在 0.4 mm 网格上，用板子自己的层数做 PathFinder 协商布线：所有网络先各自走最短路，再逐轮给拥挤格加价重布，最多 40 轮。结束时一条信号网络所有引脚都连通、且不与别的网络共用格子，才算布通；占用冲突（overflow）或没连上（open）都不算。',
    '布线在相邻两层之间每换一次层，记 1 次层间切换。本片中的“过孔”默认就是层间切换数，对全部信号网络的布线求和。10 层的 ppc 板上，一个贯穿孔最多会被记 9 次，所以另外统计物理过孔：同一格上叠在一起的切换只算 1 个。双层板上两者相同。',
    '对每个信号网络，取它所有引脚的外接矩形，记半周长 w + h；全部信号网络加起来就是 HPWL。电源和地网络不计，各网络权重相同。它不需要布线、算得最快，是布局器的主目标，但衡量不了绕线和换层：k60 上 Agent v7 的 HPWL 只比人工高约 16%（6711 vs 5799 mm），过孔却多了约 69%（489 vs 289）。'];
  tx.forEach((t, i) => T(s, t, { x: xs[i], y: 4.35, w: w3, h: 2.3, fontSize: 12, color: C.text1 }));
  foot(s, '去噪：同一个布局只平移 0.01 mm，布线结果就会变。所以工具、人工目标和最终评估都把网格整体平移若干相位（5 个；超过 1000 件的板 3 个）各布一遍，取中位数并报告范围（harness/lib/board.mjs 的 evaluate / evaluateRobust）。'); }

// 7 flow
{ const s = slide('3 流程');
  head(s, '3 · AI4AI 流程', '流程：初版 CLI → 小板并行 + 预算 → 分析轨迹');
  const w3 = (CW - 0.6) / 3, xs = [0, 1, 2].map((i) => M + i * (w3 + 0.3));
  T(s, [{ text: '① 初版 CLI（2026-10-03）', options: { bold: true, fontSize: 13, breakLine: true } }, { text: 'board-info / place / evaluate / submit。dsh 的沙箱拦掉了 GPU 进程池的命名管道，于是改由 broker 在沙箱外执行工具。', options: { fontSize: 10, color: C.text2, breakLine: true } },
    { text: '② 并行 + 预算', options: { bold: true, fontSize: 13, breakLine: true } }, { text: '每版 3 个会话并行，15–30 分钟，place 调用次数有上限，单次调用不超过 3 分钟。第一批试跑：pic / k60 / acc。', options: { fontSize: 10, color: C.text2 } }],
  { x: xs[0], y: 1.4, w: w3, h: 1.7, paraSpaceAfter: 4 });
  bar(s, { x: xs[0], y: 3.15, w: w3, h: 3.2 }, ['会话 1', '会话 2', '会话 3', '人工'], [{ name: '首批 dsh 在 pic 上的 HPWL（mm）', values: [4751, 4774, 4605, 5955], color: HEX.blue }], { min: 0, yt: 'HPWL（mm）', pointColors: [HEX.blue, HEX.blue, HEX.blue, HEX.human] });
  T(s, '首批 dsh 在 pic 上的 HPWL（mm），第 4 根为人工 5955。', { x: xs[0], y: 6.38, w: w3, h: 0.3, fontSize: 10, color: C.text2 });
  cardHead(s, xs[1], 1.4, w3, '③ 一个会话的时间花在哪（k60，v1–v5）', '工具调用占了大头。所以先优化工具速度，而不是模型。');
  s.addChart(pres.ChartType.bar, [{ name: '放置 / 布线工具调用 75–78%', labels: ['会话时间'], values: [76] }, { name: '模型推理 15%', labels: ['会话时间'], values: [15] }, { name: '其他（约 9%）', labels: ['会话时间'], values: [9] }],
    { x: xs[1], y: 2.3, w: w3, h: 3.6, barDir: 'bar', barGrouping: 'stacked', barGapWidthPct: 80, chartColors: [HEX.blue, HEX.orange, HEX.gray], ...axis({ showLegend: true, legendPos: 'b', valAxisMaxVal: 100, valAxisMinVal: 0, showValAxisTitle: true, valAxisTitle: '占会话时间（%）', showValue: true, dataLabelPosition: 'ctr', dataLabelColor: 'FFFFFF', dataLabelFontSize: 11 }) });
  cardHead(s, xs[2], 1.4, w3, '③ 一条典型轨迹：在最好布局上连续 refine（k60）', '从最好的布局出发，连续 refine 带来了大部分提升。');
  const L = ['首个 place', 'refine 1', 'refine 2', 'refine 3', 'refine 4'];
  lines(s, { x: xs[2], y: 2.3, w: w3, h: 3.7 }, L, [{ name: '布通网络', values: [237, 272, 281, 284, 309], color: HEX.blue, line: true, marker: true }, ref(L, 308, '人工 308')], { min: 220, max: 320, yt: '布通网络（个，共 318）' });
  foot(s, '轨迹里还查出几个工具 bug：v2 用 edit 设定的面，被下一次 refine 翻回去；坐标用 toFixed(6) 保存，布通数因此抖动 2–11 条。'); }

// 8 init 1
{ const s = slide('4 初始布局');
  head(s, '4 · 关键模块：初始布局（最关键）', '起点决定结构：从“调目标函数”转向“给一个好起点”');
  const w2 = (CW - 0.4) / 2;
  cardHead(s, M, 1.4, w2, 'pico：布通网络数（个，共 86）随方法演进', '多种子均值。每一步的配置都比前一步多加一项；最后一步把连接器作为任务约束给定。');
  const L = ['随机起点基线', '+ modules', '+ 间距 0.5', '8 种子均值', '+ 连接器贴边', '连接器作为约束'];
  lines(s, { x: M, y: 2.2, w: w2, h: 4.4 }, L, [{ name: 'pico 布通网络', values: [31.8, 44.7, 55.0, 68.9, 74.0, 86], color: HEX.blue, line: true, marker: true }, ref(L, 86, '人工 86')], { min: 0, max: 95, yt: '布通网络（个，共 86）' });
  cardHead(s, M + w2 + 0.4, 1.4, w2, '好起点测试：起点 → 全流程 → 布通网络数', '从人工布局出发，流程能保持结果；从随机起点出发，波动很大（4 个种子）。');
  bar(s, { x: M + w2 + 0.4, y: 2.2, w: w2, h: 4.4 }, ['pico（86）', 'edk（124）'], [{ name: '随机起点：最差种子', values: [60, 103], color: 'F5B89E' }, { name: '随机起点：最好种子', values: [86, 120], color: HEX.orange }, { name: '人工布局作起点', values: [86, 124], color: HEX.blue }], { min: 0, yt: '布通网络（个）' });
  foot(s, '结论：后续阶段不会破坏好结构；不稳定来自随机起点。所以 VLM 的指导应该以“起点”的形式进入，而不是弱锚点。'); }

// 9 init 2
{ const s = slide('4 初始布局');
  head(s, '4 · 关键模块：初始布局', 'VLM 出 floorplan、复现 VeoPlace：都赢不过“从最好的结果重启”');
  const w3 = (CW - 0.6) / 3, xs = [0, 1, 2].map((i) => M + i * (w3 + 0.3));
  cardHead(s, xs[0], 1.4, w3, 'VeoPlace 复现，pico，HPWL（mm）', '每组 160 次运行的最好值。接通“构造式起点”这个通道后，VLM 才有作用。');
  const L1 = ['仅布局器对照', 'VeoPlace 弱锚点', 'VeoPlace 构造式', '重启最好 无 VLM'];
  lines(s, { x: xs[0], y: 2.2, w: w3, h: 4.4 }, L1, [{ name: '最好 HPWL', values: [929, 931, 870, 856], color: HEX.orange, size: 11 }, ref(L1, 915, '人工 915')], { min: 840, max: 940, yt: 'HPWL（mm）', rot: -30 });
  cardHead(s, xs[1], 1.4, w3, '构造式起点：大件定位，其余放到邻居引脚中位点', 'HPWL ÷ 人工（倍），6 个种子均值，越低越好。');
  const L2 = ['默认流程', '20 大件固定，其余默认', '20 大件定位，其余放邻居中位'];
  lines(s, { x: xs[1], y: 2.2, w: w3, h: 4.4 }, L2, [{ name: 'pico', values: [1.111, 1.158, 0.967], color: HEX.blue, size: 11 }, { name: 'edk', values: [1.003, 1.011, 0.961], color: HEX.aqua, size: 11, symbol: 'diamond' }, ref(L2, 1, '人工')], { min: 0.9, max: 1.2, yt: 'HPWL ÷ 人工（倍）', legend: true, rot: -20 });
  // restart chain diagram
  const x = xs[2];
  T(s, '“从最好的结果重启”链的结构', { x, y: 1.4, w: w3, h: 0.3, fontSize: 13, bold: true });
  T(s, 'pico，10 轮，每轮 16 次运行；两条链结构和运行次数相同，只差新起点从哪来。', { x, y: 1.72, w: w3, h: 0.42, fontSize: 10, color: C.text2 });
  const cx = x + w3 / 2;
  boxText(s, cx - 1.0, 2.25, 2.0, 0.5, 'FFFFFF', HEX.ink, '当前最好布局', '按 HPWL 选', { ts: 11, bs: 9 });
  boxText(s, x, 3.05, w3 / 2 - 0.1, 0.75, HEX.orangeBg, HEX.orange, 'VeoPlace：问 VLM', '看图，给 20 个大件各画框', { ts: 10.5, bs: 9 });
  boxText(s, cx + 0.1, 3.05, w3 / 2 - 0.1, 0.75, HEX.blueBg, HEX.blue, '重启：不问 VLM', '取最好布局里 20 个大件的位置', { ts: 10.5, bs: 9 });
  arrow(s, cx - 0.4, 2.75, x + 0.9, 3.05, HEX.orange); arrow(s, cx + 0.4, 2.75, x + w3 - 0.9, 3.05, HEX.blue);
  boxText(s, x + 0.3, 4.15, w3 - 0.6, 0.6, 'FFFFFF', HEX.ink, '构造式起点', '20 个大件就位，其余放到邻居引脚中位点', { ts: 11, bs: 9 });
  arrow(s, x + 0.9, 3.8, cx - 0.2, 4.15); arrow(s, x + w3 - 0.9, 3.8, cx + 0.2, 4.15);
  boxText(s, x + 0.3, 5.05, w3 - 0.6, 0.6, 'FFFFFF', HEX.ink, '布局运行 ×8（+ 无引导 ×8）', '全局放置 + LNS + 合法化', { ts: 11, bs: 9 });
  arrow(s, cx, 4.75, cx, 5.05);
  boxText(s, x + 0.3, 5.95, w3 - 0.6, 0.42, 'FFFFFF', HEX.ink, '更新最好布局，下一轮', '', { ts: 11 });
  arrow(s, cx, 5.65, cx, 5.95);
  T(s, [{ text: '最好 HPWL 870 mm', options: { color: C.accent2, bold: true } }, { text: '　　' }, { text: '最好 HPWL 856 mm', options: { color: C.accent1, bold: true } }], { x, y: 6.45, w: w3, h: 0.3, fontSize: 11, align: 'center' });
  foot(s, 'VLM 每次的回答都是“在当前最好的布局周围画紧框”，等于纯利用。在 HPWL 目标上，VLM 没有提供布局器自己做不到的东西；HPWL 也早就低于人工（856–870 vs 915 mm），它不是和人工的差距所在。'); }

// 10 ladders
{ const s = slide('4 初始布局');
  head(s, '4 · 关键模块：初始布局', '关键信息阶梯：人工解里哪部分真正决定结果？', '按 AGENTS.md 的思路：先加入人工解的一部分，确认它确实能提升指标，再引导 Agent 从输入自己推导出来。');
  const w2 = (CW - 0.4) / 2;
  cardHead(s, M, 1.95, w2, 'WebGPU 流程，k60：布通网络数（个）', '每个点是一条链（共 4 条）的结果，浅色条连起最低和最高。缺的是“面”：有了面就能全布通，单给旋转反而更差。');
  ranges(s, { x: M, y: 2.75, w: w2, h: 3.9 }, ['L0 关键件位置+模块中心', 'L0 + 关键件旋转', 'L0 + 关键件面', 'L0 + 面 + 旋转', 'L4 完整人工起点'],
    [{ runs: [294, 305, 303, 297] }, { runs: [271, 288, 266, 263] }, { runs: [316, 318, 311, 316] }, { runs: [318, 318, 318, 314] }, { runs: [316, 316, 316, 316] }], { min: 250, max: 322, yt: '布通网络（个，共 318）', ref: [318, '人工 318'], rot: -20 });
  const X = M + w2 + 0.4;
  cardHead(s, X, 1.95, w2, 'Cypress 流程，k60：起点给了什么 → 布通数 / 过孔', '条的两端 = 3 个种子的最低 / 最高（原始记录只有范围）；最后一项只跑了 1 个种子。');
  const LAD = ['IC x,y,旋转；其余放中心', '+ 引脚加权起点（pins）', '+ pins-small', '≥2 引脚件都给人工位置'];
  ranges(s, { x: X, y: 2.75, w: w2, h: 1.85 }, LAD, [{ min: 188, max: 217 }, { min: 223, max: 240 }, { min: 302, max: 316 }, { runs: [312] }], { min: 150, max: 330, yt: '布通网络（个）', ref: [318, '人工 318'] });
  ranges(s, { x: X, y: 4.65, w: w2, h: 2.05 }, LAD, [{ min: 997, max: 1090 }, { min: 830, max: 922 }, { min: 569, max: 581 }, { runs: [459] }], { min: 0, max: 1150, yt: '过孔（个）', color: HEX.orange, rangeColor: 'F5C6B1', ref: [323, '人工合法化 323'] });
  foot(s, 'pins-small：两引脚件放在引脚更少的那个伙伴旁边，权重 1/伙伴引脚数（人工 k60 上到小伙伴中位距离 4.3 mm，到大伙伴 15.8 mm）。旋转建议器在人工 IC 位置上，20 个 IC 里有 16 个选出了人工的旋转。'); }

// 11 start layout
{ const s = slide('4 初始布局');
  head(s, '4 · 关键模块：初始布局', '当前起点算法（start-layout.mjs）：只用网表，0 秒，13 块板');
  const w2 = (CW - 0.4) / 2;
  const series4 = (f) => [{ name: 'Cypress 随机起点', values: f('cypress'), color: HEX.gray, symbol: 'triangle' }, { name: 'WebGPU 随机起点', values: f('webgpu'), color: HEX.orange, symbol: 'square' }, { name: '起点单独', values: f('init'), color: HEX.yellow, symbol: 'diamond' }, { name: '起点 + WebGPU 全局', values: f('initWeb'), color: HEX.blue }];
  cardHead(s, M, 1.4, w2, '过孔数 ÷ 人工（倍，对数轴），3 个种子中位数', '起点单独使用已远好于两个布局器的随机起点；在它之上跑 WebGPU 全局阶段最好。');
  lines(s, { x: M, y: 2.2, w: w2, h: 4.45 }, B, [...series4(vr), ref(B, 1)], { log: true, min: 0.5, max: 15, legend: true, rot: -45, yt: '过孔 ÷ 人工（倍）' });
  cardHead(s, M + w2 + 0.4, 1.4, w2, '布通率（%）', 'k60、pic 上，随机起点基本布不通。');
  bar(s, { x: M + w2 + 0.4, y: 2.2, w: w2, h: 4.45 }, B, series4(rate).map((x) => ({ ...x, color: x.color })), { min: 0, max: 100, rot: -45, gap: 40 });
  foot(s, '13 板汇总：起点单独 97.0% / 过孔 1.59 倍 / HPWL 1.04 倍；起点 + Cypress 97.0% / 1.55 / 1.03；起点 + WebGPU 全局 100% / 1.30 / 0.99。被数据否掉的规则：“大 IC 下不放件”（人工 k60 在 U201 下放了 21 个件）；“大 IC 外围成排放置”（提升被噪声淹没，HPWL 还涨 1.5–2%）。'); }

// 12 why
{ const s = slide('5 WebGPU 布局器');
  head(s, '5 · 关键模块：WebGPU 布局器', 'Cypress 是 GPU 加速的布局器，但仍有提升空间：一次梯度下降 vs 多起点 + GPU 批量搜索',
    '同一协议：固定件、板面、合法化器、布线器都相同，只换布局器。差别在于“搜索方式”和“PCB 特有的知识”。', 21);
  const rows = [['起点', '1 个随机起点，1 次求解', '32 个起点各做粗放置，按精确分挑 4 个继续细化'],
    ['全局放置', '解析式：logsumexp 线长 + 静电密度，Adam 1000 轮', '解析式全局放置；GPU 打分含线长 + 重叠 + 越界 + 粗粒度拥塞'],
    ['局部搜索', '无（legalize / detailed place 都关闭）', '快速 delta LNS：每轮 1024 个候选在 GPU 上并行打分，共 400 轮；再精确 polish'],
    ['布线余量', '静电密度，目标密度 0.65', '每个引脚预留 0.6 mm² 布线面积；顶、底面各算一张密度图'],
    ['PCB 规则', '无', '去耦电容吸附到 IC 电源引脚、晶振靠 IC、电源网络加权'],
    ['交叉项', '开（权重 0.001）', '本对比中关闭']];
  const tw = 7.1;
  s.addTable([[{ text: '' }, { text: 'Cypress（benchmark 配置）', options: { bold: true, color: HEX.orange } }, { text: 'WebGPU 流水线', options: { bold: true, color: HEX.blue } }],
    ...rows.map((r) => [{ text: r[0], options: { bold: true, color: HEX.ink2 } }, { text: r[1] }, { text: r[2] }])],
  { x: M, y: 1.95, w: tw, colW: [0.95, 2.75, 3.4], fontSize: 10, color: HEX.ink, fill: { color: 'FFFFFF' }, border: { type: 'solid', color: HEX.grid, pt: 0.75 }, valign: 'middle', margin: 0.05, rowH: 0.52 });
  T(s, 'Cypress 配置：cypress-config.json（128×128 bins、lr 0.01、net_crossing_flag 1、legalize_flag 0、detailed_place_flag 0）。WebGPU：--preplace --power --legalize --sides original --density 3 --congestion 3，大预算。', { x: M, y: 5.75, w: tw, h: 0.5, fontSize: 9.5, color: C.text2 });
  const X = M + tw + 0.35, w = W - M - X;
  T(s, '19 / 39', { x: X, y: 1.9, w: w / 2, h: 0.6, fontSize: 30, bold: true, color: C.accent1 });
  T(s, 'Cypress 随机起点的运行中达到收敛标准（overflow ≤ 0.1）的次数（13 板 × 3 种子）', { x: X, y: 2.5, w: w / 2 - 0.1, h: 0.6, fontSize: 9.5, color: C.text2 });
  T(s, '14 s vs >150 s', { x: X + w / 2, y: 1.9, w: w / 2, h: 0.6, fontSize: 24, bold: true, color: C.accent1 });
  T(s, 'acc 上一次 Cypress：关掉交叉项 vs 开着交叉项（超时）', { x: X + w / 2, y: 2.5, w: w / 2, h: 0.6, fontSize: 9.5, color: C.text2 });
  T(s, '给同一个好起点后，差距大幅缩小（13 板汇总）', { x: X, y: 3.15, w, h: 0.3, fontSize: 12, bold: true });
  bar(s, { x: X, y: 3.45, w: w / 2, h: 2.85 }, ['随机起点', '工具起点'], [{ name: 'Cypress', values: [3.95, 1.55], color: HEX.orange }, { name: 'WebGPU', values: [2.38, 1.30], color: HEX.blue }], { min: 0, yt: '过孔 ÷ 人工（倍）' });
  bar(s, { x: X + w / 2, y: 3.45, w: w / 2, h: 2.85 }, ['随机起点', '工具起点'], [{ name: 'Cypress', values: [78.4, 97.0], color: HEX.orange }, { name: 'WebGPU', values: [89.8, 100], color: HEX.blue }], { min: 0, max: 100, yt: '布通率（%）' });
  foot(s, '解读（根据配置和实验推断）：① 随机起点下差距主要来自搜索方式：一次梯度下降只给一个答案，一半运行没收敛；多起点 + LNS 在 GPU 上并行评估大量候选。② 好起点补上这部分后，剩下的差距（过孔 1.55 vs 1.30 倍）来自 PCB 知识。③ 速度差主要来自交叉项本身和 1000 轮串行迭代。', 6.4); }

// 13 webgpu
{ const s = slide('5 WebGPU 布局器');
  head(s, '5 · 关键模块：WebGPU 布局器', 'WebGPU 布局器：比 Cypress 快约 12 倍，过孔少约 40%');
  const w2 = (CW - 0.4) / 2, X = M + w2 + 0.4;
  cardHead(s, M, 1.4, w2, '单次放置时间（s，对数轴），随机起点，3 种子中位数', 'WebGPU：多起点全局放置 + 快速 delta LNS + 精确 polish。Cypress：benchmark 配置。');
  lines(s, { x: M, y: 2.2, w: w2, h: 4.45 }, B, [{ name: 'Cypress', values: MD.cypress.map((r) => r[2]), color: HEX.orange, symbol: 'square' }, { name: 'WebGPU', values: MD.webgpu.map((r) => r[2]), color: HEX.blue, size: 10 }], { log: true, min: 1, max: 500, legend: true, rot: -45, yt: '放置时间（s）' });
  cardHead(s, X, 1.4, w2, '逐板对比（随机起点，每组柱子一块板，3 种子中位数）', '上图：过孔 ÷ 人工（倍，越低越好）；下图：布通率（%，越高越好）。');
  bar(s, { x: X, y: 2.2, w: w2, h: 2.1 }, B, [{ name: 'Cypress', values: vr('cypress'), color: HEX.orange }, { name: 'WebGPU', values: vr('webgpu'), color: HEX.blue }], { min: 0, yt: '倍', extra: { catAxisHidden: true } });
  bar(s, { x: X, y: 4.3, w: w2, h: 2.35 }, B, [{ name: 'Cypress', values: rate('cypress'), color: HEX.orange }, { name: 'WebGPU', values: rate('webgpu'), color: HEX.blue }], { min: 0, max: 100, rot: -45, yt: '%', extra: { showLegend: false } });
  foot(s, 'CPU 参考实现上，v0.1 → v0.2 放置提速 11.85 倍，目标函数只差 0.66%。GPU 交叉计数在 batch 1024 时，每个候选 4–27 µs。'); }

// 14 objective
{ const s = slide('5 WebGPU 布局器');
  head(s, '5 · 关键模块：WebGPU 布局器', '目标函数的演化：从 HPWL 到“路由器才看得见的东西”');
  const w2 = (CW - 0.4) / 2, OBJ = ['只用 HPWL', '+ 双面网络', '+ 交叉代价', '+ 接口件锚定', '人工'];
  cardHead(s, M, 1.4, w2, 'k60，相同 floorplan：校准规则下的布通网络数（个，共 318）', '每一步在前一步上加一项；最后一根为人工。');
  bar(s, { x: M, y: 2.2, w: w2, h: 4.4 }, OBJ, [{ name: '布通网络', values: [219, 260, 230, 293, 308], color: HEX.blue }], { min: 0, max: 320, pointColors: [HEX.blue, HEX.blue, HEX.blue, HEX.blue, HEX.human] });
  cardHead(s, M + w2 + 0.4, 1.4, w2, '同一组布局：交叉数和只按线距布线的过孔数（个）', '接口件锚定：只和某个固定连接器相连的件，放到该连接器周围的区域里。');
  bar(s, { x: M + w2 + 0.4, y: 2.2, w: w2, h: 4.4 }, OBJ, [{ name: '交叉数', values: [1879, 1635, 1556, 1343, 1068], color: HEX.orange }, { name: '只按线距布线的过孔', values: [688, 592, 592, 535, 298], color: HEX.blue }], { min: 0 });
  foot(s, '过孔地图：k60 多出来的过孔集中在 MCU 模块 M1（人工 97 个，我们 210–260 个），原因是接口件被放到错误的固定连接器旁边，离人工位置 15–45 mm。单次运行间差距很大：pic 同一设置跑两次，完整规则下的布通数分别是 202 和 235。'); }

// 15 router
{ const s = slide('6 布线器');
  head(s, '6 · 关键模块：布线器', '布线器：单线程 JS → 去掉闭包 → 多线程 → 剪枝 + 层启发 → C++ → 增量', '', 23);
  const w1 = 7.4, X = M + w1 + 0.4, w2 = W - M - X;
  cardHead(s, M, 1.4, w1, '每一步改动前后：一次路由的耗时（s，对数轴）', '灰 = 改动前，蓝 = 改动后。除标明的项外，路由结果完全一致。');
  const L = ['① 去掉 A* 闭包（acc）', '② worker 线程池（acc 鲁棒检查）', '③ 缓存不可达目标（edu-nxp）', '③ 层启发 A*（acc）', '④ 原生 C++（ppc-n3）', '④ C++ + 层启发 + 增量（ppc-n3）'];
  bar(s, { x: M, y: 2.2, w: w1, h: 4.45 }, L, [{ name: '改动前', values: [18.2, 111, 41.7, 29, 151, 151], color: HEX.gray }, { name: '改动后', values: [10.6, 26, 4.2, 6.8, 97, 6.9], color: HEX.blue }], { h: true, log: true, min: 1, max: 200, gap: 50, yt: '秒（对数轴）', extra: { catAxisOrientation: 'maxMin', valAxisLabelPos: 'high' } });
  cardHead(s, X, 1.4, w2, 'ppc-n3（2207 件，10 层）：一次路由（s）', '这块板决定了工具调用能否守住 3 分钟。');
  const P = ['JS 精确', 'C++ 精确', '+ 层启发', '+ 增量拆线'];
  lines(s, { x: X, y: 2.2, w: w2, h: 3.7 }, P, [{ name: 'ppc-n3', values: [151, 97, 22.4, 6.9], color: HEX.blue, line: true, marker: true }], { log: true, min: 5, max: 200, yt: '秒（对数轴）' });
  T(s, '原生 C++ 与 JS 逐位一致（布通数、过孔、轮数、每个网络的状态）。加层启发和增量后不再逐位一致：16 个布局的布通数全部相同，过孔排序 Spearman 0.974。', { x: X, y: 5.95, w: w2, h: 0.75, fontSize: 10, color: C.text2 }); }

// 16 calibration
{ const s = slide('6 布线器');
  head(s, '6 · 关键模块：布线器', '评估口径：用人工的真实走线校准布线器；GPU 路由走不通');
  const w3 = (CW - 0.6) / 3, xs = [0, 1, 2].map((i) => M + i * (w3 + 0.3));
  cardHead(s, xs[0], 1.4, w3, '人工布局的过孔数（个）', '人工的真实走线（从 .kicad_pcb 读出）、校准前、校准后（完整规则）。');
  bar(s, { x: xs[0], y: 2.2, w: w3, h: 4.45 }, ['pic', 'k60'], [{ name: '人工真实走线', values: [322, 236], color: HEX.human }, { name: '校准前', values: [354, 346], color: HEX.orange }, { name: '校准后', values: [322, 303], color: HEX.blue }], { min: 0, yt: '过孔（个）' });
  cardHead(s, xs[1], 1.4, w3, '换成真实线距后，acc 的布通网络数（个，共 617）', '旧口径（0.4 mm）对 acc 严了一倍：它的真实线距是 0.19 mm。');
  bar(s, { x: xs[1], y: 2.2, w: w3, h: 4.45 }, ['人工', '轨迹最好', '首批布局 1', '首批布局 3'], [{ name: '旧口径（0.4 mm，12 轮）', values: [617, 617, 602, 549], color: HEX.gray }, { name: '新口径（真实线距，40 轮）', values: [617, 617, 617, 617], color: HEX.blue }], { min: 0, max: 650 });
  T(s, '失败或放弃的路线', { x: xs[2], y: 1.4, w: w3, h: 0.3, fontSize: 13, bold: true });
  bullets(s, [['GPU 波前路由：', '每轮约 38 s，CPU 只要 0.06 s，慢约 600 倍'], ['Jacobi 并行协商：', '会振荡，k60 只有 70–160 条，正常 229–314'], ['粗粒度全局路由：', '在 ppc 上的排序和 HPWL 一样差'],
    ['FreeRouting 2.5：', 'pico 要 200 s，k60 590 s 还没布完；我们的 pico 不到 1 s'], ['warm 增量探针：', '和完整评估无相关（Spearman −0.07）']], { x: xs[2], y: 1.85, w: w3, h: 4.8 }, 13); }

// 17 noise
{ const s = slide('7 其他模块');
  head(s, '7 · 其他关键模块：评分器', '评分器降噪：同一个布局平移 0.01–0.1 mm，布通数能差 15 条');
  const w2 = (CW - 0.4) / 2;
  cardHead(s, M, 1.4, w2, 'k60：同一布局只做微小扰动，布通数范围（个，共 318）', '平移 / 抖动各 8 次；条的两端 = 8 次中的最低 / 最高。人工 8 次都是 318。');
  ranges(s, { x: M, y: 2.2, w: w2, h: 4.4 }, ['人工：平移', '人工：抖动', 'Agent v4：平移', 'Agent v4：抖动'], [{ runs: [318] }, { runs: [318] }, { min: 285, max: 303 }, { min: 276, max: 310 }], { min: 260, max: 322, yt: '布通网络（个，共 318）', color: HEX.orange, rangeColor: 'F5C6B1' });
  cardHead(s, M + w2 + 0.4, 1.4, w2, '布通数的标准差（个）：单次路由 vs 3 个网格相位取中位', '8 个抖动副本（ppc 为 4 个）。');
  bar(s, { x: M + w2 + 0.4, y: 2.2, w: w2, h: 4.4 }, ['k60 v4 会话 1', 'k60 v4 会话 2', 'k60 v4 会话 3', 'ppc-n3 v6 会话 1'], [{ name: '单次路由', values: [2.0, 9.7, 2.7, 1.7], color: HEX.gray }, { name: '3 个相位取中位', values: [1.6, 2.6, 2.9, 0.8], color: HEX.blue }], { min: 0, yt: '标准差（个）' });
  foot(s, '工具、人工目标和最终评估都用 evaluateRobust：在 worker 线程里布 5 个网格相位（超过 1000 件的板布 3 个），取中位数并报告范围。prompt v7 告诉 Agent：差值在 metrics.noise 以内就是噪声。'); }

// 18 decap + codesign
{ const s = slide('7 其他模块');
  head(s, '7 · 其他关键模块', '去耦电容规则、人机协同');
  const w2 = (CW - 0.4) / 2;
  cardHead(s, M, 1.4, w2, '去耦电容到 IC 电源引脚的中位距离（mm）', '随机起点，4 个种子。规则：电源边权 1 + 不拉地 + 吸附到电源引脚。');
  const b7 = ['z3r0', 'pico', 'edk', 'edu-fpga', 'fsl-mini', 'edu-k60', 'edu-nxp'];
  bar(s, { x: M, y: 2.2, w: w2, h: 4.4 }, b7, [{ name: '基线设置', values: [4.5, 8.7, 12.7, 16.3, 51.9, 48.2, 25.7], color: HEX.gray }, { name: '+ 去耦规则', values: [2.1, 2.0, 4.5, 2.6, 3.6, 3.3, 3.3], color: HEX.blue }, { name: '人工', values: [4.9, 1.6, 3.4, 5.8, 5.7, 7.0, 5.0], color: HEX.human }], { min: 0, rot: -30, yt: '中位距离（mm）' });
  cardHead(s, M + w2 + 0.4, 1.4, w2, '协同轨迹：鲁棒布通率随时间（%）', '不用 Agent 的近实时流程：4 个 floorplan → 并行放置 → 连续改进。');
  const ts = [...Array(35)].map((_, i) => i * 10), step = (pts, n) => ts.map((t) => { let v = null; pts.forEach(([x, y]) => { if (t >= x) v = +(100 * y / n).toFixed(1); }); return v; });
  lines(s, { x: M + w2 + 0.4, y: 2.2, w: w2, h: 4.1 }, ts.map(String), [{ name: 'k60', values: step([[58, 310], [165, 312]], 318), color: HEX.blue, line: true }, { name: 'pic', values: step([[34, 306], [97, 308]], 310), color: HEX.aqua, line: true }, { name: 'acc', values: step([[190, 611], [208, 615], [329, 617]], 617), color: HEX.orange, line: true }],
    { min: 96, max: 100.5, legend: true, yt: '鲁棒布通 ÷ 总网络（%）', extra: { catAxisLabelFrequency: 5, showCatAxisTitle: true, catAxisTitle: '墙钟时间（s）' } });
  T(s, '编辑器里：首批布局 24 s 出来；用户编辑后，20 s 内从 255 改进到 262。', { x: M + w2 + 0.4, y: 6.35, w: w2, h: 0.3, fontSize: 10, color: C.text2 }); }

// 19 summary (v7 sweep)
{ const s = slide('8 总结');
  head(s, '8 · 总结：人工 vs Agent', '13 块板：Agent（prompt v7，每板 3 个会话）对比人工布局', '旧数据：webgpu-layout 的 v7 sweep（2026-10-04/05），每个会话取最好布局，用同一个校准规则布线器单次路由。两层板用完整规则，nxp / rx / acc 只按线距。');
  const w3 = (CW - 0.6) / 3, xs = [0, 1, 2].map((i) => M + i * (w3 + 0.3)), bs = Object.keys(A);
  const sess = (f) => [0, 1, 2].map((k) => ({ name: `会话 ${k + 1}`, values: bs.map((b) => (A[b].reps[k] ? f(A[b].reps[k], A[b]) : null)), color: HEX.blue, size: 8 }));
  [['布通网络数：Agent − 人工（个）', '≥ 0 表示不少于人工。', (r, a) => r.clean - a.human.clean, 0], ['过孔：Agent ÷ 人工（倍）', '1 = 持平。', (r, a) => +(r.vias / a.human.vias).toFixed(2), 1], ['HPWL：Agent ÷ 人工（倍）', '< 1 表示线更短。', (r, a) => +(r.hpwl / a.human.hpwl).toFixed(2), 1]]
    .forEach(([t, n, f, rv], i) => { cardHead(s, xs[i], 1.95, w3, t, n); lines(s, { x: xs[i], y: 2.6, w: w3, h: 4.05 }, bs, [...sess(f), ref(bs, rv)], { rot: -60 }); });
  foot(s, '布通数：12 块板至少有一个会话不少于人工（k60 例外：279–306，人工 308）。HPWL：8 块板有会话低于人工。过孔是剩下的主要差距（k60 +57–65%，acc +40–46%）。'); }

// 20 current tool
{ const s = slide('8 总结');
  head(s, '8 · 总结：人工 vs Agent', '当前工具（cypress-layout harness）在大板上的结果', '起点 → Cypress → 合法化 → 原生精确布线器，取多相位中位数；每板 3 个 dsh 会话。口径与上一页不同，不能混比。');
  const cur = { k60: { h: [318, 291, 5799], r: [[318, 504, 5572], [297, 651, 6036], [300, 631, 5754]] }, acc: { h: [617, 2600, 17115], r: [[617, 2801, 16006], [617, 2889, 16158], [617, 2895, 16099]] }, 'ppc-n3': { h: [1607, 8729, 54188], r: [[1603, 9541, 60296], [1606, 9790, 52832], [1606, 9753, 54501]] } };
  const cb = Object.keys(cur), w3 = (CW - 0.6) / 3, xs = [0, 1, 2].map((i) => M + i * (w3 + 0.3));
  [['布通网络数：Agent ÷ 人工（%）', 0, (a, h) => +(100 * a / h).toFixed(2), 100, 93, 100.5], ['过孔：Agent ÷ 人工（倍）', 1, (a, h) => +(a / h).toFixed(2), 1, 1, 2.4], ['HPWL：Agent ÷ 人工（倍）', 2, (a, h) => +(a / h).toFixed(2), 1, 0.92, 1.12]]
    .forEach(([t, j, f, rv, mn, mx], i) => { cardHead(s, xs[i], 1.95, w3, t);
      lines(s, { x: xs[i], y: 2.35, w: w3, h: 4.3 }, cb, [...[0, 1, 2].map((k) => ({ name: `会话 ${k + 1}`, values: cb.map((b) => f(cur[b].r[k][j], cur[b].h[j])), color: HEX.blue, size: 10 })), ref(cb, rv)], { min: mn, max: mx }); });
  foot(s, '人工：k60 318 / 291 / 5799 mm，acc 617 / 2600 / 17115 mm，ppc-n3 1607 / 8729 / 54188 mm（布通网络 / 过孔 / HPWL）。ppc-n3 的过孔按层间切换计数。'); }

// 21-26 image pairs
{ const withImg = Object.keys(A).filter((k) => A[k].shown);
  for (let i = 0; i < withImg.length; i += 2) {
    const s = slide('8 总结');
    head(s, '8 · 总结：人工 vs Agent，逐板', '逐板对比：每板展示 3 个会话中最好的一个（v7 sweep 旧数据，同一布线器）');
    const w2 = (CW - 0.4) / 2;
    withImg.slice(i, i + 2).forEach((k, j) => { const a = A[k], r = a.reps.find((x) => x.rep === a.shown), x = M + j * (w2 + 0.4), iw = (w2 - 0.15) / 2;
      T(s, [{ text: `${k}`, options: { bold: true, fontSize: 14, breakLine: true } }, { text: `人工 ${a.human.clean}/${a.nets} 布通 · ${a.human.vias} 过孔 · ${a.human.hpwl} mm`, options: { fontSize: 10.5, color: C.text2, breakLine: true } }, { text: `Agent ${r.clean}/${a.nets} 布通 · ${r.vias} 过孔 · ${r.hpwl} mm`, options: { fontSize: 10.5, color: C.accent1 } }], { x, y: 1.35, w: w2, h: 0.85 });
      imageFit(s, path.join(DIR, 'img', `${k}-human.png`), x, 2.3, iw, 4.0, `${k} 人工布局`);
      imageFit(s, path.join(DIR, 'img', `${k}-agent.png`), x + iw + 0.15, 2.3, iw, 4.0, `${k} Agent 布局`);
      T(s, '人工布局', { x, y: 6.35, w: iw, h: 0.25, fontSize: 10, color: C.text2, align: 'center' });
      T(s, `Agent（v7，会话 ${a.shown}）`, { x: x + iw + 0.15, y: 6.35, w: iw, h: 0.25, fontSize: 10, color: C.text2, align: 'center' }); });
    foot(s, '件：青 = 顶面，紫 = 底面，红 = 重叠；走线：红 = 顶层，蓝 = 底层，绿 = 内层，橙 = 冲突，红虚线 = 未布通。acc 的最好会话没有存图，只在第 19 页给数字。', 6.75);
  } }

// 27 conclusions
{ const s = slide('总结');
  head(s, '总结', '结论与下一步');
  const w2 = (CW - 0.5) / 2;
  box(s, M, 1.5, w2, 5.1, HEX.blueBg, HEX.blueBg, { name: 'Findings' });
  T(s, '结论', { x: M + 0.3, y: 1.7, w: w2 - 0.6, h: 0.35, fontSize: 16, bold: true, color: C.accent1 });
  bullets(s, [['RSI 循环有效，但瓶颈不在 prompt。', '迭代 12 个版本后，同一版本会话之间的差距仍大于版本之间的差异。'], ['起点是最关键的模块。', '只用网表推导的起点，在 13 板上把过孔从 2.4–4.0 倍降到 1.3 倍。'], ['工具速度决定 Agent 能试几次。', '放置调用占会话 76% 的时间；布线器在 ppc 上从 151 s 降到 6.9 s。'], ['评分器也要被优化。', '单次路由的噪声（±15 条网络）会淹掉 prompt 之间的比较。']],
    { x: M + 0.3, y: 2.2, w: w2 - 0.6, h: 4.2 }, 13);
  const X = M + w2 + 0.5;
  box(s, X, 1.5, w2, 5.1, HEX.soft, HEX.soft, { name: 'Next' });
  T(s, '下一步', { x: X + 0.3, y: 1.7, w: w2 - 0.6, h: 0.35, fontSize: 16, bold: true, color: C.accent2 });
  bullets(s, [['剩下的差距是过孔', '（k60 557 vs 345，pic 492 vs 363），集中在 IC 周边小件的精确排布上。'], ['重跑 agent sweep：', '用当前工具在 13 板 + ppc 上统一口径；第 19 页用的是旧数据。'], ['路由器在环：', '把 IC 邻居的排布交给路由器评估；前提是有和评估一致、足够快的路由器。'], ['编辑器：', '默认使用新起点；edk 出现回退，原因未查。']],
    { x: X + 0.3, y: 2.2, w: w2 - 0.6, h: 4.2 }, 13); }

// 28 RSI frameworks
{ const s = slide('展望');
  head(s, '展望 · RSI 的将来演进', '被改进的对象逐层上移：产物持续改进 → 复杂问题规划 → 反思和策略探索', '三种常见 RSI 框架共享同一条纪律：Agent 只负责提议，Host 用预先固定的 verifier 在全新的工作树里验收；Agent 自己报告的结果不算证据。', 22);
  const w3 = (CW - 0.6) / 3, xs = [0, 1, 2].map((i) => M + i * (w3 + 0.3));
  const cols = [
    ['VeriLoop：产物持续改进', HEX.blue, '清华 SIGS，VeriLoop E2 技术报告（2026）。生成和验收分离，模型不能自证进步。', ['从当前最优出发', '提议一个候选', '外部验证', '不回退 + 至少一项严格变好：提交；否则回滚并反馈原因'],
      '单链爬山，每轮 1 个 Agent；成本随迭代数线性增长。', '有确定性 verifier 的单一产物：修代码、补推导、调配置。', '把 refine 链的接受规则改成“鲁棒评分下布通数不回退、过孔或 HPWL 严格变好”，由 Host 判定而不是 Agent 自己挑。'],
    ['Raven：复杂问题规划', HEX.orange, 'EverMind AI，arXiv 2609.33439（2026-09），“Harness 的 Harness”。', ['Planner 拆成 DAG', '按能力派给不同 Agent 并行执行', '集成 → 整体验收', '失败：记入记忆，重新规划'],
      '每轮一张图，没改动的节点复用缓存；论文中还有 harness 自进化和技能库。', '多专家协作的复合任务（研究、代码、设计、值班）。', '按模块拆（MCU、电源、接口、存储）并行布局，再集成成全板验收。ppc 上单个 Agent 只做了 4–8 次 place 就自行停止（预算 16 次）。'],
    ['Dream-RSI：反思和策略探索', HEX.aqua, 'UMD · Google DeepMind · UVA，arXiv 2609.14858（2026-09）。已积累的发现历史就是回放模拟器。', ['在线：策略驱动 Agent 扩展发现树（贵）', '离线“做梦”：在历史树上回放、改写 policy（便宜）', '回放分严格更高：换上新策略'],
      '只改“扩展哪个节点、并行几个、何时停”；论文在 Lasso 任务上调用数从 550 降到 317。', '成千上万次“提议-评估”的长程发现任务：算法、数学优化、GPU kernel。', '会话 75–78% 的时间花在放置调用上：把 v1–v12 的轨迹当回放语料，离线优化“何时新开 floorplan、何时 refine、何时停”。']];
  cols.forEach(([t, col, src, flow, st, use, pcb], i) => { const x = xs[i];
    T(s, t, { x, y: 1.95, w: w3, h: 0.35, fontSize: 15, bold: true, color: col });
    T(s, src, { x, y: 2.3, w: w3, h: 0.5, fontSize: 9.5, color: C.text2 });
    s.addText(flow.map((f, k) => ({ text: f, options: { bullet: { type: 'number' }, breakLine: k < flow.length - 1 } })), { isTextBox: true, x, y: 2.85, w: w3, h: 1.35, fontSize: 10.5, margin: 0, valign: 'top', paraSpaceAfter: 3 });
    T(s, [{ text: '结构：', options: { bold: true } }, { text: st, options: { breakLine: true } }, { text: '适用场景：', options: { bold: true } }, { text: use }], { x, y: 4.25, w: w3, h: 1.1, fontSize: 10.5, paraSpaceAfter: 4 });
    box(s, x, 5.4, w3, 1.25, HEX.blueBg, HEX.blueBg, { name: 'PCB idea' });
    T(s, [{ text: '在 PCB 上：', options: { bold: true } }, { text: pcb }], { x: x + 0.12, y: 5.48, w: w3 - 0.24, h: 1.1, fontSize: 10.5 }); });
  foot(s, '出处整理自 SilverRetort 仓库 doc/slides/rsi-algorithms.html（三个 recipe 的论文对照与 v9 实现）。“在 PCB 上”一栏是设想，尚未实验。'); }

// Missing values (sessions without a result, dots before a step starts) must be absent points, not empty <c:v>.
async function dropEmptyPoints(f) {
  const JSZip = require(require.resolve('jszip', { paths: [require.resolve('pptxgenjs')] }));
  const zip = await JSZip.loadAsync(fs.readFileSync(f));
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))) {
    const x = await zip.file(name).async('string');
    zip.file(name, x.replace(/<c:pt idx="\d+"><c:v><\/c:v><\/c:pt>/g, ''));
  }
  fs.writeFileSync(f, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
pres.writeFile({ fileName: OUT }).then(async (f) => { await applyTheme(f, THEME); await dropEmptyPoints(f); console.log('wrote', f); });
