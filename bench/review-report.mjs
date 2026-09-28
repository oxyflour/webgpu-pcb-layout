// Review report (Chinese): summary of a multi-seed benchmark run with saved layouts, its
// limits, and per-board renders (first seed) of the original vs optimized placements.
//
//   node bench/kicad-boards.mjs --backend gpu --budget large --route --quality --modules auto --seeds 2 --save-layouts --out run.json
//   node bench/review-report.mjs --run run.json [--out-dir bench/results] [--prefix review]
import fs from 'node:fs';
import path from 'node:path';
import { renderReport } from './render-kicad.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const run = JSON.parse(fs.readFileSync(arg('run', 'bench/results/review-v3.json'), 'utf8'));
const outDir = arg('out-dir', 'bench/results'), prefix = arg('prefix', 'review');

const LAYERS = { nxp: 4, rx: 4, acc: 6, 'ppc-n3': 10, 'ppc-n1': 10 };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = (s) => +String(s).split('/')[0];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const byCase = {};
for (const r of run.rows) (byCase[r.case] ??= []).push(r);

let sumHuman = 0, sumOpt = 0;
const gaps = [];
const rows = Object.entries(byCase).map(([k, a]) => {
  const human = clean(a[0]['orig clean']), total = +String(a[0].clean).split('/')[1];
  const seeds = a.map((r) => clean(r.clean)), m = mean(seeds), pct = 100 * m / human;
  sumHuman += human; sumOpt += m;
  if (pct < 97) gaps.push(`${k}（${pct.toFixed(0)}%）`);
  return `<tr><td>${esc(k)}</td><td>${a[0].n}</td><td>${a[0].fixed}</td><td>${total}</td><td>${LAYERS[k] ?? 2}</td><td>${human}</td><td>${seeds.join(' / ')}</td><td>${pct.toFixed(0)}</td>`
    + `<td>${mean(a.map((r) => r['hpwl/orig'])).toFixed(2)}</td><td>${a[0]['orig bottom %']}</td><td>${mean(a.map((r) => r['bottom %'])).toFixed(0)}</td><td>${a[0].backside}</td><td>${mean(a.map((r) => r['total s'])).toFixed(1)}</td></tr>`;
});

const seeds = [...new Set(run.rows.map((r) => r.seed))].length;
const intro = `
<section class="intro">
<h2>这份报告是什么</h2>
<p class="lead">15 块真实 KiCad 板。每块板从<b>随机初始状态</b>开始布局（配置：<code>--quality --modules auto</code>，含模块内分面与自动背面代价，GPU，大预算），再用本仓库的评估布线器分别布“人画的原始布局”和“优化后的布局”，比较能干净布通的信号网络数量。下方每块板的三张图依次为：原始布局 + KiCad 真实走线；原始布局用评估布线器布线；优化布局用同一评估布线器布线。随后两张是模块地图（浅色 = 底面）。</p>

<h2>汇总（15 块板 × ${seeds} 个种子）</h2>
<table>
<thead><tr><th>板子</th><th>器件数（个）</th><th>预放置固定的器件（个，位置取自人画布局）</th><th>信号网络（个）</th><th>评估走线层数（层）</th><th>人画布局：干净布通（个）</th><th>优化布局：干净布通，各种子（个）</th><th>优化平均 / 人画（%）</th><th>优化布局 HPWL / 人画 HPWL，平均（倍）</th><th>人画：底面器件占比（%）</th><th>优化：底面器件占比，平均（%）</th><th>背面代价（HPWL mm / mm²，自动推断）</th><th>布局耗时，平均（秒）</th></tr></thead>
<tbody>${rows.join('\n')}
<tr><th>合计</th><td></td><td></td><td></td><td></td><td>${sumHuman}</td><td>${sumOpt.toFixed(1)}（平均）</td><td>${(100 * sumOpt / sumHuman).toFixed(1)}</td><td></td><td></td><td></td><td></td><td></td></tr>
</tbody></table>
<p class="lead">下方渲染的是每块板的第一个种子；各板表格里的数字就是这一次的结果。</p>

<h2>请带着这些前提复核</h2>
<ul>
<li><b>“干净布通”是一个宽松的代理指标</b>：0.4 mm 网格，焊盘为唯一障碍；没有按网络类别的线宽/间距、差分对、等长、阻抗；电源/地网络不参与评估（视为平面承载）。</li>
<li><b>没有评估</b>：电源完整性、去耦电容到 IC 电源引脚的距离、信号完整性、EMC、散热、装配（器件朝向一致性、丝印、贴片与测试可达性）。这些需要导回 KiCad 用真实布线器和 DRC 才能判断。</li>
<li><b>预放置用了人画布局的位置</b>：连接器、安装孔、测试点、贴板边的器件（按位号前缀和库名推断）固定在原位，见表中第 3 列。这部分骨架不是算法想出来的。</li>
<li><b>PPC 两块 10 层板上指标已饱和</b>：人画和优化都几乎全部布通，干净布通数无法区分好坏，应主要看 HPWL、底面占比与图面。</li>
<li><b>单/双面</b>：人画布局底面器件少于 10% 的板子被当作单面板（背面代价 20），优化基本不使用底面；双面板上模块会拆到两面（小器件放在 IC 投影下方的对面）。</li>
<li><b>走线长度</b>：多数板子的 HPWL 仍比人画长；布通并不代表线短、好布。</li>
<li>干净布通明显低于人画的板子（低于 97%）：${gaps.length ? gaps.join('、') : '无'}。</li>
</ul>
</section>`;

// Render the first seed of every board.
const first = Object.values(byCase).map((a) => a[0]);
const ciaa = { ...run, rows: first.filter((r) => !r.case.startsWith('ppc')) };
const ppc = { ...run, rows: first.filter((r) => r.case.startsWith('ppc')) };
await renderReport(ciaa, { out: path.join(outDir, `${prefix}-ciaa.html`), intro, title: '布局复核：CIAA 13 块板（人画 vs 优化）', lang: 'zh' });
await renderReport(ppc, { out: path.join(outDir, `${prefix}-ppc.html`), intro, title: '布局复核：PowerPC 笔记本主板 2 块（人画 vs 优化）', lang: 'zh' });
