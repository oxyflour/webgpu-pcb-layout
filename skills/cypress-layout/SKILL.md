---
name: cypress-layout
description: 调用 NVIDIA NVlabs Cypress CUDA 布局器，在 webgpu-layout-code 中导出和回读 PCB 布局，运行官方 Bookshelf 或仓库 KiCad benchmark，生成可复核的对比报告。适用于 Cypress PCB 布局、镜像调用、布局后处理及 benchmark 刷新；不用于 Cypress 浏览器端到端测试。
---

# Cypress PCB 布局与 benchmark

使用 `webgpu-layout-code/bench/cypress` 的适配层和已编译 CUDA 镜像。将 Cypress 作为全局布局候选，按需要接共同合法化或 WebGPU LNS 精修。

## 选择工作流

- 启动现有镜像、检查 CUDA，或确实需要重新编译时，读 [references/runtime.md](references/runtime.md)。
- 布局单块板、导出 Bookshelf、回读坐标或接入布局管线时，读 [references/layout.md](references/layout.md)。
- 跑仓库三板三种子、官方 20 例、生成报告或刷新对照时，读 [references/benchmark.md](references/benchmark.md)。

## 定位环境

先在当前 checkout 寻找 `bench/cypress/README.md`、`compare.mjs`、`official.mjs`、`run.py`、`bookshelf.mjs` 和 `bench/pipeline.mjs`。优先使用当前仓库；本机历史位置为 `C:/Projects/webgpu-layout-code`，另有 Codex worktree，路径不是固定依赖。找不到适配代码时说明缺少哪项，不把 NVlabs 原始仓库当成已有适配层。

在仓库根目录运行 Node 命令。Node 要求 >=20；原生对照和精修还需要 `webgpu` 包及可用 GPU。KiCad 用例源仓库本机位于 `C:/Projects/webgpu_pcb_placer`，通过 `--placer` 指定；用例注册表是 `bench/kicad-cases.mjs`。

已验证的本机资源：

- 镜像：`cypress:20261004`。
- 首选容器：`codex-cypress-official-20261004`；旧容器：`codex-cypress-bench-20261004`。
- 上游源码版本：`743b07c4e33dc52a00584d55d2e67f38f70957f5`，包含固定版本的子模块。
- 适配工具已合入 `agentic-placement-codex@cd3978f`，后续修复了原面约束。以当前 checkout 的实现和实际 Git revision 为准。

## 运行约束

1. 本用户当前实验约定是每个 Cypress **板/种子求解进程 300 秒**，TERM 后最多再等 5 秒强杀；超时、错误、未收敛保留日志并跳过合格结果统计。用户指定新预算时更新运行参数和报告，不能只改说明；当前 runner 将 300 秒写死在代码中。
2. CUDA 求解、WebGPU 原生布局和精修在同一 GPU 上顺序运行。不要同时启动多个 GPU 阶段；共享容器还使用同一个 `DREAMPlace.log`。
3. 新实验使用新输出目录。现有目录恢复会保留完成行和失败/跳过状态，不会自动重试。区分重新测量与缓存复用，记录输入、配置、种子、二进制/镜像和项目版本。
4. 保留预分配面、固定机械/通孔器件及完整引脚映射。当前 bridge 不提供自由换面搜索；有 `sides: 'any'` 的输入需先确定面。
5. 原始 CUDA 输出不是合法布局。合格配对需通过独立几何检查和共同合法化；未收敛后处理仅在需要诊断时启用并明确标注。

## 解释和交付

交付布局/原始输出、日志、配置、状态、独立几何与质量指标、实际耗时和复现命令。benchmark 还需逐种子结果和报告链接；只有生成并核验后才声称完成。

报告中的 PathFinder `clean/nets` 是整网级启发式指标。Cypress 论文的 RB 是 FreeRouting v1.9.0 的 pin-pair 完成比例，TL 是实际走线长度；现有 runner 没有集成 FreeRouting。连续 crossing penalty 与整数 `crossing_pairs` 也不同。不得把这些指标直接等同或声称完成论文复现。

这里只封装既有已修正 Cypress 构建和固定参数实验，不自动开始多 GPU 调参、扩大用例范围或修改原始 PCB。当前授权下跑完请求的范围，再给结果。
