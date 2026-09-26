// Review report (Chinese): summary of the 2-seed benchmark, its limits, and per-board
// renders of the original vs optimized placements.
//
//   node bench/review-report.mjs [--layouts bench/results/review-layouts.json] [--stats bench/results/kicad-boards-v2.json] [--out-dir bench/results]
import fs from 'node:fs';
import path from 'node:path';
import { renderReport } from './render-kicad.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const layouts = JSON.parse(fs.readFileSync(arg('layouts', 'bench/results/review-layouts.json'), 'utf8'));
const stats = JSON.parse(fs.readFileSync(arg('stats', 'bench/results/kicad-boards-v2.json'), 'utf8')).rows;
const outDir = arg('out-dir', 'bench/results');

const LAYERS = { nxp: 4, rx: 4, acc: 6, 'ppc-n3': 10, 'ppc-n1': 10 };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clean = (s) => +String(s).split('/')[0];
const byCase = {};
for (const r of stats) (byCase[r.case] ??= []).push(r);
const fixedOf = Object.fromEntries(layouts.rows.map((r) => [r.case, r.fixed]));

let sumHuman = 0, sumOpt = 0;
const rows = Object.entries(byCase).map(([k, a]) => {
  const human = clean(a[0]['orig clean']), total = +String(a[0].clean).split('/')[1];
  const seeds = a.map((r) => clean(r.clean)), mean = seeds.reduce((x, y) => x + y, 0) / seeds.length;
  const hp = a.map((r) => r['hpwl/orig']).reduce((x, y) => x + y, 0) / a.length;
  sumHuman += human; sumOpt += mean;
  return `<tr><td>${esc(k)}</td><td>${a[0].n}</td><td>${fixedOf[k] ?? a[0].fixed}</td><td>${total}</td><td>${LAYERS[k] ?? 2}</td><td>${human}</td><td>${seeds.join(' / ')}</td><td>${(100 * mean / human).toFixed(0)}</td><td>${hp.toFixed(2)}</td><td>${(a.reduce((x, r) => x + r['total s'], 0) / a.length).toFixed(1)}</td></tr>`;
});

const intro = `
<section class="intro">
<h2>这份报告是什么</h2>
<p class="lead">15 块真实 KiCad 板。每块板从<b>随机初始状态</b>开始布局（配置：<code>--quality --modules auto</code>，GPU，大预算），再用本仓库的评估布线器分别布“人画的原始布局”和“优化后的布局”，比较能干净布通的信号网络数量。下方每块板的三张图依次为：原始布局 + KiCad 真实走线；原始布局用评估布线器布线；优化布局用同一评估布线器布线。随后两张是模块地图。</p>

<h2>汇总（15 块板 × 2 个种子）</h2>
<table>
<thead><tr><th>板子</th><th>器件数（个）</th><th>预放置固定的器件（个，位置取自人画布局）</th><th>信号网络（个）</th><th>评估走线层数（层）</th><th>人画布局：干净布通（个）</th><th>优化布局：干净布通，种子 1 / 种子 2（个）</th><th>优化平均 / 人画（%）</th><th>优化布局 HPWL / 人画 HPWL，平均（倍）</th><th>布局耗时，平均（秒）</th></tr></thead>
<tbody>${rows.join('\n')}
<tr><th>合计</th><td></td><td></td><td></td><td></td><td>${sumHuman}</td><td>${sumOpt}（平均）</td><td>${(100 * sumOpt / sumHuman).toFixed(1)}</td><td></td><td></td></tr>
</tbody></table>
<p class="lead">下方渲染的是另跑的一次（种子 1，保存了布局坐标），各板表格里的数字以那次为准，可能与上表的种子 1 略有差异。</p>

<h2>请带着这些前提复核</h2>
<ul>
<li><b>“干净布通”是一个宽松的代理指标</b>：0.4 mm 网格，焊盘为唯一障碍；没有按网络类别的线宽/间距、差分对、等长、阻抗；电源/地网络不参与评估（视为平面承载）。</li>
<li><b>没有评估</b>：电源完整性、去耦电容到 IC 电源引脚的距离、信号完整性、EMC、散热、装配（器件朝向一致性、丝印、贴片与测试可达性）。这些需要导回 KiCad 用真实布线器和 DRC 才能判断。</li>
<li><b>预放置用了人画布局的位置</b>：连接器、安装孔、测试点、贴板边的器件（按位号前缀和库名推断）固定在原位，见表中第 3 列。这部分骨架不是算法想出来的。</li>
<li><b>PPC 两块 10 层板上指标已饱和</b>：人画和优化都几乎全部布通，干净布通数无法区分好坏，应主要看 HPWL 与图面。</li>
<li><b>走线长度</b>：约一半板子的 HPWL 比人画长 20%–80%（k60 为 1.8 倍）；布通并不代表线短、好布。</li>
<li>明显的差距板：k60（86%）、acc（69%），均为高密度双面板。</li>
</ul>
</section>`;

const ciaa = { ...layouts, rows: layouts.rows.filter((r) => !r.case.startsWith('ppc')) };
const ppc = { ...layouts, rows: layouts.rows.filter((r) => r.case.startsWith('ppc')) };
await renderReport(ciaa, { out: path.join(outDir, 'review-ciaa.html'), intro, title: '布局复核：CIAA 13 块板（人画 vs 优化）', lang: 'zh' });
await renderReport(ppc, { out: path.join(outDir, 'review-ppc.html'), intro, title: '布局复核：PowerPC 笔记本主板 2 块（人画 vs 优化）', lang: 'zh' });
