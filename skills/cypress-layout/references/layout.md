# 单板布局和管线接入

优先使用仓库现有 adapter。Cypress 使用 y-up、矩形左下角和数据库单位；项目 IR 使用 mm、y-down 和器件中心。不要手写坐标转换、旋转或背面镜像。

## 注册用例的单次布局

下面只调用 Cypress，`prepare` 还会记录人工布局并进行评估路由；它不是零成本的文件导出。先按 runtime 参考启动容器。

```powershell
$resultDir = Join-Path (Get-Location) ('bench/results/cypress-single-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$container = 'codex-cypress-official-20261004'
$placer = 'C:/Projects/webgpu_pcb_placer'
node bench/cypress/compare.mjs --phase prepare --out $resultDir --container $container --placer $placer --only pico --seeds 1000
node bench/cypress/compare.mjs --phase cypress --out $resultDir --container $container --placer $placer --only pico --seeds 1000
```

查看 `$resultDir/comparison.json` 的 `status['pico/1000']` 和 `pico-1000/output.json`。需要原生对照及后处理时再运行 `native`、`evaluate`、`reconcile`，每次使用相同的 `--out/--only/--seeds/--placer/--container`。

## 自定义 KiCad/IR 输入

注册表之外的文件不是 `compare.mjs --only` 的合法值。编写小型调用脚本，使用真实板文件和以下接口；import 路径相对于调用脚本位置调整。以下示意假设脚本位于项目根目录。

```javascript
import fs from 'node:fs';
import {parseKicadBoard, designToProblem} from './src/kicad/adapter.js';
import {normalizeProblem} from './src/problem.js';
import {randomLayout} from './bench/pipeline.mjs';
import {exportBookshelf, importCypressPlacement} from './bench/cypress/bookshelf.mjs';

const a = designToProblem(parseKicadBoard(fs.readFileSync(boardFile, 'utf8'), boardName),
  {preplace: true, sides: 'original'});
a.input.components.forEach((c, i) => {
  if (c.twoSided && !c.fixed) c.fixed = {...a.originalLayout[i]};
});
const p = normalizeProblem(a.input);
exportBookshelf(a, randomLayout(p, seed), jobDir);
// config.json 写入下述已验证配置；jobDir/boardFile/boardName/seed 由调用方提供。
```

直接接 IR 时，`a` 至少含 `input`、与组件数组对应的 `originalLayout`；若调用 `placeBoard`/路由评估，还需 adapter 的 `routing` 等信息。先固定需要固定的器件，并把自由面输入约束到确定面。当前导出器对可动器件以原始矩形和局部焊盘初始化，不表示保持任意初始旋转的增量布局。

导出产生 `board.aux/.nodes/.nets/.pl/.scl` 和 `bridge.json`。以 `compare.mjs` 的 prepare 配置为权威；已验证单板配置要点是：

- GPU 0、float32、8 CPU 线程、128×128 bins。
- 单一 global stage：Adam、1000 steps、learning rate 0.01、logsumexp、density iterations 5、inner iterations 2、decay 0.995。
- target density 0.65、density weight 0.001、gamma 1、stop overflow 0.1。
- crossing 和 rotation 开启；crossing weight 0.001；`ignore_net_degree=10000`。
- seed 取调用值；fillers 开启；scale factor 1；`gp_noise_ratio=0.025`。
- `global_place_flag=1`、`legalize_flag=0`、`detailed_place_flag=0`。
- `random_center_init_flag=0`、`macro_overlap_flag=false`、`macro_halo_x/y=0`、`plot_flag=0`、`get_congestion_map=0`、`sort_nets_by_degree=0`、`deterministic_flag=1`。

不要把官方逐板 tuned 配置替换成此配置仍称为“官方参数”。需要完整 JSON 时从当前 `compare.mjs` 的 config 对象生成，而非凭要点猜测字段层级。

## 直接调用 wrapper

此命令只适用于已有六个导出文件和 `config.json` 的 job。使用唯一容器内目录，先确认其中没有旧输出。

```powershell
$jobDir = Join-Path $resultDir 'pico-1000'
$jobIn = '/work/single-pico-1000-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
docker cp bench/cypress/run.py "${container}:/work/run.py"
docker exec $container mkdir -p $jobIn
docker cp "$jobDir/." "${container}:${jobIn}"
$timer = [Diagnostics.Stopwatch]::StartNew()
docker exec -w /Cypress/install $container timeout --signal=TERM --kill-after=5s 300s python3 /work/run.py $jobIn *> (Join-Path $jobDir 'cypress.log')
$exitCode = $LASTEXITCODE
$timer.Stop()
```

退出 0 后才复制本次 `output.json`、`engine-metrics.json`、`engine.log`，并在输出里补记 `$timer.Elapsed.TotalSeconds` 为 `process_wall_s`。124 表示 timeout；137 且耗时达到预算可视为强杀超时，其余非零为 error。保留状态和日志，不导入残留文件。完整 runner 已实现这些逻辑，批量任务优先用它。

```powershell
docker cp "${container}:${jobIn}/output.json" (Join-Path $jobDir 'output.json')
docker cp "${container}:${jobIn}/engine-metrics.json" (Join-Path $jobDir 'engine-metrics.json')
docker cp "${container}:${jobIn}/engine.log" (Join-Path $jobDir 'engine.log')
```

`run.py` 重建完整 pin/node/net 映射和侧面约束，解决上游 parser 合并重复 node/net 引脚的问题。它校验初始引脚误差 <=0.011 mm，并从 solver 最终 GPU 矩形回读中心，避免 halo removal 导致的中心偏移。

## 导入和后处理

在上述调用脚本中回读，不修改输入板文件：

```javascript
import {legalizeLayout} from './src/optimizer/legalizer.js';
import {createNodeWebGpuDevice} from './src/node.js';
import {parseOptions, placeBoard} from './bench/pipeline.mjs';
import {repositoryMetrics} from './bench/cypress/repository-metrics.mjs';

const output = JSON.parse(fs.readFileSync(`${jobDir}/output.json`, 'utf8'));
const L = importCypressPlacement(a, output);
const candidate = legalizeLayout(p, L, {clearance: 0.1});
const metrics = repositoryMetrics(p, candidate.layout);
// 如需 hybrid：原始 L 直接交给 LNS，跳过另一个全局布局阶段。
if (output.engine_converged) {
  const device = await createNodeWebGpuDevice();
  try {
    const o = parseOptions(['--preplace','--power','--legalize','--sides','original',
      '--density','3','--congestion','3'], {backend:'gpu', budget:'large'});
    const refined = await placeBoard(a, o, {device, seed, initLayout:L, initMode:'lns'});
    // 保存 refined.layout、timing、legal 及独立指标。
  } finally { device.destroy(); }
}
```

还应按 `compare.mjs` 的 evaluate 实现，将 `engine_pins` 与 `worldPin` 逐个匹配，重复 node/net 引脚用最近点逐一消费；KiCad 最终误差要求 <=0.025 mm。只比较器件中心会漏掉背面/旋转错误。官方 Bookshelf 的对应核验要求 <0.011 mm。

保存 `engine_converged`、`final_overflow`、`iterations`、CUDA `solve_s` 和完整冷进程耗时。wrapper 用 engine 有限 HPWL 反映其收敛判定，不应自行把存在 output 文件解释成成功。独立核验 0.1 mm 间距、重叠、轮廓、禁布区、固定器件和原面；legalizer 的 `failed=0` 不能替代这些检查。
