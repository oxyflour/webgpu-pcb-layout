---
name: pcb-eval
description: 为一块新 PCB（KiCad 文件或 kicadToIR 输出的 IR JSON）登记并跑完整评测：人工基准、无 agent 的 tool 布局、3 次 agent 会话、8 网格相位评分、去耦电容与关键网络约束、复核 HTML 页。适用于"加新板子跑评测/对标人工/复核布局"；不用于修改布局算法或 Cypress 容器调用。
---

# 新板子评测（harness）

评测管线在 `harness/`：`start layout -> 0.1 mm 合法化 -> detail pass（小器件局部搜索：HPWL + 布线通道 + 去耦电容到其 IC + 关键网络）-> native 布线器`。不再使用 Cypress，无需 GPU / 容器。算法与历史结果见 `harness/README.md`、`harness/RESULTS.md`。

## 1. 准备板子文件

两种输入都可以：

- **KiCad**：`.kicad_pcb`（KiCad 4–8）。原理图子页（封装的 `path`）和网络类会被自动读取。
- **IR JSON**：`kicadToIR` 的输出（适配仓库 `src/kicad/adapter.js`，`webgpu-layout-code`），即 `{format, yAxis, name, source, board, nets, footprints}`。
  - `footprints[].placement` 是**人工布局**（所有"对标人工"的指标都以它为参照；没有人工布局的板子只能看绝对值）。
  - 可选字段（约束推断用）：`footprints[].sheet`（原理图子页路径，同一子页的 IC 被认为是该页去耦电容的服务对象）、`nets[].netclass`（网络类名）、顶层 `netClasses: [{name, clearance, traceWidth, viaDia}]`。没有它们时，去耦电容退回"同电源上的任一 IC"，关键网络只按命名（晶振、`_P/_N`、`DP/DM`、`+/-`）识别。
  - 从已登记的 KiCad 板导出带这些字段的 IR：`node harness/experiments/export-ir.mjs --board k60 --out boards/k60-ir.json`。

## 2. 登记

在 `harness/boards.json` 加一行（路径相对仓库根目录或绝对路径；以 `_` 开头的键是注释）：

```json
{ "_note": "...", "myboard": "boards/myboard-ir.json" }
```

登记后的板子自动进入所有评测脚本的默认板单（`EVAL_BOARDS`）。验证：`node -e "import('./harness/lib/board.mjs').then(m=>console.log(m.loadBoard('myboard').format))"`。

## 3. 约束（可选，但建议先看）

第一次评测会写出 `harness/constraints/<board>.template.json`（默认推断：去耦电容 -> IC、关键网络）。需要指定时复制为 `harness/constraints/<board>.json` 后修改：

```json
{
  "decaps": { "C201": "U201", "C215": { "ic": "U201", "maxMm": 2 } },
  "critical": [
    { "nets": ["/RF/ANT"], "kind": "rf", "maxLengthMm": 10, "maxVias": 0, "keepoutMm": 0.5, "layer": "top", "priority": 1 },
    { "pair": ["/USB_DP", "/USB_DM"], "maxMismatchMm": 0.5, "maxVias": 2 },
    { "class": "USB", "maxVias": 2 }
  ]
}
```

带限值的关键网络会：在 detail pass 中加大权重并保持直线走廊；布线时优先布、过孔加价、限层、留禁区（`lib/constraints.mjs routerRules`）；在 `place` 结果和评分里逐条报告通过/失败（焊盘分在两面导致 `maxVias` 不可能满足时报 `infeasible`）。只想试验而不改正式配置时，用 `--constraints-dir` 指向另一个目录。

## 4. 跑评测

```bash
node harness/experiments/eval-board.mjs --board myboard --tag eval
```

- 步骤：人工基准与约束模板 -> 无 agent 布局（3 个种子）-> 3 次 dsh agent 会话（prompt v14，20 分钟，12 次 place）-> 8 个网格偏移评分 -> 约束指标 -> 复核页。每步输出已存在则跳过，重跑即续跑。
- 选项：`--no-agent`（只跑 tool）、`--prompt`、`--minutes`、`--places`、`--constraints-dir`。agent 需要 dsh 和本机 gateway（见 `harness/agent/run-agent.mjs`）。
- 耗时：agent 那步约 20–25 分钟，其余几分钟（>1000 器件的板子更久）。整个命令超过 3 分钟，放后台跑；单次工具调用（place）保持在 3 分钟内。
- 同一 `--tag` 下多块板的结果会合并进同一套表格和复核索引。

## 5. 看结果

- `harness/results/<tag>/rows.jsonl`：评分原始行；表格：`node harness/experiments/sweep-eval.mjs --dir <tag> --agent <tag>s --name <tag> --tool-label "start + detail" --summary`（人工 / 无 agent / agent 的布通网络、过孔、相对人工倍数、收敛相位数）。
- `harness/results/<tag>/constraints.jsonl`；表格：`node harness/experiments/constraints-eval.mjs --out harness/results/<tag>/constraints.jsonl --summary`（去耦电容到指定 IC 的距离，关键网络的布通、长度、过孔、差分对长度差）。
- `harness/results/review-<tag>/index.html` 和 `<board>.html`：两栏联动对比任意两个布局（按层显示走线和过孔、网络表按过孔差排序、顶部指标表）。这是本地文件（results 已被 git 忽略），需要给人看时用 SendUserFile 发送，不要发布到网上。
- 所有表头写明指标和单位；新结论写进 `harness/RESULTS.md` 新的一节。

## 注意

- 评测口径：0.4 mm 网格 PathFinder，多相位中位数（≤1000 器件 8 个独立偏移；更大的板子用 tool 布线 3 相位）。单相位噪声大，不要用单次布线下结论。
- 人工布局可能有重叠（例如屏蔽罩下的芯片），runner 会标成非法；对比时以 clean / vias 为主，几何合法性看 `geometry`。
- 去耦电容 / 关键网络的推断依赖原理图子页和网络类；推断不准时用约束文件覆盖，并在报告里说明。
- 实验约定（AGENTS.md）：每个配置 3 次重复；每次工具调用 < 3 分钟；结果表头带单位。
