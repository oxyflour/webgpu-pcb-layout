# Benchmark、报告及刷新

命令从当前项目根目录运行；先读 runtime 参考并确认容器、Node/WebGPU 和输入路径。不要因为要生成报告就自动重跑已有 GPU 结果。

## 仓库 KiCad：默认三板、每板三种子

本用户既定范围是 PICO、EDK、K60，seeds 1000、8919、16838；注册表还有其他板，但扩大范围应来自当前请求。比较方法为 `webgpu`、`cypress+legalize`、`cypress+webgpu`，保存 human 和 cypress-raw 作为参考。

全新测量的调用：

```powershell
$resultRoot = Join-Path (Get-Location) ('bench/results/cypress-benchmark-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$repositoryDir = Join-Path $resultRoot 'repository'
$container = 'codex-cypress-official-20261004'
$placer = 'C:/Projects/webgpu_pcb_placer'
node bench/cypress/repository-run.mjs --out $repositoryDir --container $container --placer $placer --only pico,edk,k60 --seeds 1000,8919,16838 --reuse (Join-Path $resultRoot 'no-cache') --diagnostic-refine
```

`no-cache` 是新结果根目录下不存在的路径，用于覆盖 driver 默认的历史 CUDA 缓存来源；确认它不存在。若请求复用 CUDA 输出，则 `--reuse` 指向已有结果并披露来源。prepare 只在以下七个文件逐字节 SHA-256 一致时复用：`board.aux/.nodes/.nets/.pl/.scl`、`bridge.json`、`config.json`。同一个输出目录的原生/hybrid 完成行也会恢复；修改配置、输入或项目算法时用新目录。

`--diagnostic-refine` 为保留全部三个种子的对比而允许对未收敛候选做后处理；它们只作诊断，不进入合格胜负统计。普通只看收敛候选时去掉该开关。driver 顺序跑 `prepare,native,cypress,evaluate,reconcile`，可用 `--phases` 指定恢复阶段。CUDA 每次有 300 秒限额；其他阶段的 watchdog 是 **每板每阶段 300 秒 × 请求种子数**，不能称为每个评估种子的严格 5 分钟限额。

prepare 和 evaluate 含 CPU 路由，可能比 CUDA 布局更耗时。评估路由不计入 `placement_s`。记录 driver 的 phase_status，阶段退出不等于全部种子完成。

## 官方 Bookshelf：20 个 small-* 用例

`official.mjs` 不自动下载源码。`$officialDir/source` 必须包含相同固定版本的 `benchmarks`、`artifacts/results`、`test/tune/pcb-configspace.json`、`tuner/tuner_configs.py` 和额外生成的 `tuner/base-config.json`。

最简办法是从已核验实验复制 source，再核验 provenance/哈希：

```powershell
$officialDir = $resultRoot
$sourceDir = Join-Path $officialDir 'source'
New-Item -ItemType Directory -Path $officialDir -Force | Out-Null
Copy-Item -LiteralPath 'bench/results/cypress-official-refresh-cd3978f/source' -Destination $sourceDir -Recurse
```

如果历史 source 不存在，Git clone 固定版本到新 source（在 Linux 中导出可避免 Windows FLUTE 表换行问题；仅 benchmark 数据不需要整套编译）。从该版本 `tuner/tuner_configs.py` 的 `AUTODMP_BASE_CONFIG` 生成 `tuner/base-config.json`，不要把完整 config-space 或另一版默认值冒充 base-config。无需 import/tuner 依赖，可在容器中运行下面 Python 内容，再复制生成文件回 source；`source_dir` 指向此次固定版本目录：

```python
import ast, json
from pathlib import Path
source_dir = Path('/Cypress')
tree = ast.parse((source_dir/'tuner/tuner_configs.py').read_text())
value = next(ast.literal_eval(node.value) for node in tree.body
  if isinstance(node, ast.Assign)
  and any(isinstance(t, ast.Name) and t.id == 'AUTODMP_BASE_CONFIG' for t in node.targets))
(source_dir/'tuner/base-config.json').write_text(json.dumps(value, indent=2)+'\n')
```

在已验证镜像中 `/Cypress` 是固定版本。其他容器先用 `git -C /Cypress rev-parse HEAD` 核验。四个 source 子目录可从镜像复制，保留同样的目录结构；保存来源和文件哈希。

前 10 例使用 checked-in 的逐板 tuned 参数；后 10 例使用 base-config 加公开 config-space 的 defaults，按 `GP_` 映射到 global stage。统一改动 GPU、seed、路径及关闭可选 plot/congestion extraction；不进行新的调参搜索，也不把两组混为一种配置。

```powershell
docker start $container
foreach ($phase in @('prepare','cypress','native','evaluate','reconcile')) {
  node bench/cypress/official.mjs --phase $phase --out $officialDir --container $container --seeds 1000
  if ($LASTEXITCODE -ne 0) { throw "Official phase failed: $phase" }
}
```

试跑可每次加 `--only small-1`，要跑完整 20 例则不加。保持所有阶段的用例和 seeds 一致。timeout/error/unconverged 都保存明确状态，跳过合格质量比较；失败状态在同目录恢复时不会重新求解。

## 验证与报告

正式 benchmark 按当前项目运行适当检查并保存真实日志。现有 verify 读取 `project-tests.log`；它要求 GPU 测试实际运行、fail/skipped 为 0，仓库 verifier 还要求至少 67 tests。不能把缺日志或 GPU 缺失填成通过。

```powershell
npm test *> (Join-Path $resultRoot 'project-tests.log')
if ($LASTEXITCODE -ne 0) { throw 'Project tests failed' }
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Project checks failed' }
Copy-Item -LiteralPath (Join-Path $resultRoot 'project-tests.log') -Destination (Join-Path $repositoryDir 'project-tests.log')
node bench/cypress/official-verify.mjs $officialDir --complete
node bench/cypress/repository-verify.mjs $repositoryDir
node bench/cypress/official-report.mjs $officialDir
```

以上块适用于官方全量与仓库三种子诊断都跑完的组合实验。只跑官方时不复制 repository 日志也不运行 repository verifier；只跑部分官方用例时去掉 `--complete`。repository verifier 当前要求每个种子都有四种算法行和 output；超时、或者未启用未收敛诊断时可能缺行。此时说明具体覆盖缺口，逐项核验实际存在的输出，不为了通过而伪造行或重新开启超预算求解。

`verification.json` 中的几何冲突明细必须读取；验证脚本退出 0 仅说明核验一致性，不证明每个布局合法。合格胜负要求同板同种子各比较方法均收敛/有效、0.1 mm 器件间距、无可动重叠/越界/禁布冲突、固定位置和侧面保持、合法化失败为 0。固定-固定原有冲突按现有协议豁免，并披露。

组合报告将 `$officialDir/repository` 嵌入 `report.html#repository`。只跑仓库 cohort 时，用导出的 `repositoryReport(root,{prefix:'./'})` 生成 standalone HTML 包裹，并保留其中独立几何/诊断说明；不要用旧 `report.mjs` 的宽松合法性汇总代替严格检查。仓库 generator 的图表标题当前写着“三个种子”，试跑单种子若交付报告需改成实际数量。

## 图表和查看

使用镜像中 Python/matplotlib，避免本机 NumPy/matplotlib 版本冲突。各绘图脚本仅需对应 `comparison.json`，无需复制整套结果；它们输出 `summary.png` 和 `summary.svg`。组合实验示例：

```powershell
docker exec $container mkdir -p /work/skill-official-plot /work/skill-repository-plot
docker cp bench/cypress/official-plot.py "${container}:/work/official-plot.py"
docker cp bench/cypress/repository-plot.py "${container}:/work/repository-plot.py"
docker cp (Join-Path $officialDir 'comparison.json') "${container}:/work/skill-official-plot/comparison.json"
docker cp (Join-Path $repositoryDir 'comparison.json') "${container}:/work/skill-repository-plot/comparison.json"
docker exec $container python3 /work/official-plot.py /work/skill-official-plot
docker exec $container python3 /work/repository-plot.py /work/skill-repository-plot
foreach ($ext in @('png','svg')) {
  docker cp "${container}:/work/skill-official-plot/summary.$ext" (Join-Path $officialDir "summary.$ext")
  docker cp "${container}:/work/skill-repository-plot/summary.$ext" (Join-Path $repositoryDir "summary.$ext")
}
node bench/cypress/serve.mjs $officialDir 8176
```

server 是长驻前台进程；检查端口是否空闲，在支持持久 session 的终端中启动，不让前台命令挡住后续核验。浏览器访问 `http://127.0.0.1:8176/report.html`，可在 Codex 中打开。核验图片存在、board/seed/连接选择器有效、布局数量与状态一致，及浏览器错误；不要默认之前的 server 仍在运行。

## 刷新、指标与 provenance

用户要求合并/刷新时，在获授权的 checkout 中合并指定分支，记录 merge revision，按最新算法重跑 native 与 hybrid，并统一重新评估路由。不要把另一分支的缓存行作为最新对照。

`refresh-official.mjs --from <旧实验> --out <新实验>` 复制旧 source/CUDA 结果，保存 previous JSON 并清空算法行。它要求旧目录有 `comparison.json`、`summary.json`、`merged-project-tests.log`，以及本地 `agentic-placement-codex` ref；这是历史实验专用假设。缺少这些时用新目录显式复制 source/经核验的 CUDA 缓存及 provenance，再重跑需要的阶段，不盲目套用脚本。旧测试日志只是历史证据，刷新后替换为本次真实日志。

不能仅因七个输入文件匹配就跨二进制/运行环境复用：还需相同源码修补、wrapper、镜像和 CUDA 参数，并披露复用。某些 runner 默认记录旧 RTX 3090 Ti、旧 image ID 和 cd3978f 分支信息；交付前修正为实际硬件/版本或明确历史来源。

两组指标独立报告：

| 项目 | 官方 Bookshelf | 仓库 KiCad |
|---|---|---|
| 无权重 HPWL | 全部多引脚 nets；同时核验 Cypress degree mask | 信号网络；供电/地由 adapter 单独处理 |
| 单位 | 10 database units/mm | 100 database units/mm |
| 路由 | 两层、0.1 mm 点焊盘，grid=max(0.4 mm,长边/300) | 真实焊盘/通孔/铜层/轮廓，0.4 mm grid |
| 协商轮数 | 最多 40 | 最多 40 |
| DRC 解释 | 启发式 proxy | 默认未启用完整 net-class DRC |

官方 Cypress 通常屏蔽 degree>=100 的 nets；独立主指标仍包括这些 nets，并另列屏蔽线长。旧 12 轮与当前 40 轮路由的布通率不可直接比较。论文连续 NC、FreeRouting pin-pair RB 和实际 TL 均不能用当前整数 crossing 或 PathFinder 整网结果替代。

布局耗时报告 CUDA `solve_s`、冷进程 `process_wall_s` 和 hybrid 尾部耗时；下载、编译、评估路由分别列出。原生 GPU device 通常在计时前创建，应披露这个计时差异。

历史参考：`bench/results/cypress-official-refresh-cd3978f` 包含官方及仓库三板三种子；使用前确认文件实际存在，读当前 summary/verification。不要把历史胜率、未收敛数或时间估计写成新运行结果。

官方参数出处：[固定版本 tuner 配置](https://github.com/NVlabs/Cypress/blob/743b07c4e33dc52a00584d55d2e67f38f70957f5/tuner/tuner_configs.py)。项目操作细节以当前 `bench/cypress/README.md` 和脚本为准。
