// HTML report of webgpu-vs-cypress.mjs: grouped column charts (median of seeds, min-max whisker)
// of clean-net rate, vias / human and HPWL / human per board, plus overview and tables.
// node harness/experiments/webgpu-vs-cypress-report.mjs [DIR]  ->  DIR/report.html
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'harness/results/webgpu-vs-cypress');
const rows = fs.readFileSync(path.join(dir, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const last = new Map(rows.map((r) => [`${r.board}|${r.seed}|${r.method}`, r]));
const METHODS = [
  ['webgpu', 'WebGPU（随机初始化）', 'adapter bench/pipeline.mjs placeBoard，选项同 bench/cypress/compare.mjs（--preplace --power --legalize --density 3 --congestion 3，budget large），随机多起点全局布局 + LNS + 精修 + 合法化'],
  ['cypress', 'Cypress（随机初始化）', 'Cypress 基准配置：随机初始布局，1000 次迭代，lr 0.01，交叉项开，deterministic'],
  ['tool-init', '只用工具初始布局', 'harness lib/init.mjs startLayout（空 plan，等同 agent 的 place from centroid）：按网表把器件放到相连引脚的加权中心，旋转对准，去耦电容靠近 IC；不跑布局器'],
  ['tool', '工具初始布局 + Cypress', '同一初始布局交给 Cypress，harness 默认参数（600 次迭代，lr 0.002，交叉项关，朝向冻结）'],
  ['tool-webgpu-global', '工具初始布局 + WebGPU 完整流程', '同一初始布局作为 WebGPU 全局布局的唯一起点（initMode global，无随机多起点），再走完整流程'],
  ['tool-webgpu-lns', '工具初始布局 + WebGPU 只做局部搜索', '同一初始布局，跳过全局布局，只做 LNS + 精修 + 合法化（initMode lns）'],
];
const boards = [...new Set(rows.map((r) => r.board))];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const data = { methods: METHODS.map(([id, name, desc]) => ({ id, name, desc })), boards: boards.map((board) => {
  const h = last.get(`${board}|null|human-legal`), raw = last.get(`${board}|null|human-raw`);
  const runs = Object.fromEntries(METHODS.map(([m]) => [m, [...last.values()].filter((r) => r.board === board && r.method === m).sort((a, b) => a.seed - b.seed)
    .map((r) => ({ seed: r.seed, clean: r.clean, vias: r.vias, hpwl: Math.round(r.hpwlMm), s: r.placementS, status: r.status ?? null }))]));
  return { board, nets: h.nets, human: { clean: h.clean, vias: h.vias, hpwl: Math.round(h.hpwlMm) }, humanRaw: { clean: raw.clean, vias: raw.vias, hpwl: Math.round(raw.hpwlMm) }, runs };
}) };
// Board-by-board wins on medians.
const PAIRS = [['tool-webgpu-global', 'tool'], ['tool-webgpu-global', 'webgpu'], ['tool', 'tool-init'], ['tool-webgpu-lns', 'tool-init'], ['tool', 'webgpu'], ['webgpu', 'cypress']];
data.wins = PAIRS.map(([a, b]) => ({ a, b, ...Object.fromEntries([['clean', 1], ['vias', -1], ['hpwl', -1]].map(([k, sign]) => {
  const c = [0, 0, 0];
  for (const B of data.boards) { const d = sign * (med(B.runs[a].map((r) => r[k])) - med(B.runs[b].map((r) => r[k]))); c[d > 0 ? 0 : d < 0 ? 1 : 2]++; }
  return [k, c];
})) }));
data.date = new Date().toISOString().slice(0, 10);

const html = fs.readFileSync(path.join(import.meta.dirname, 'webgpu-vs-cypress-report.html'), 'utf8').replace('/*DATA*/null', JSON.stringify(data));
fs.writeFileSync(path.join(dir, 'report.html'), html);
console.log(path.join(dir, 'report.html'));
