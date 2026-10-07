# dsh 布局 harness（Cypress 为唯一布局器）

本仓库 `harness/` 让 dsh（DeepSeek Flash, headless）通过 `pcb` CLI 做 PCB 布局：agent 给出 IC 布局规划，Cypress 求解，共享 0.1 mm 合法化器与 benchmark 路由评估。不使用 WebGPU 布局器或 LNS。说明、命令和协议见 `harness/README.md`。

- 评估：`node harness/agent/batch.mjs --board <pico|edk|k60> --prompt harness/prompts/v2.md --minutes 25 --places 6 --out harness/results/<新目录>`，固定 3 个 dsh 重复；一次只跑一块板，避免 GPU 争用导致 Cypress 超时。
- 关键信息实验（无 agent）：`node harness/experiments/keyinfo.mjs --board k60 --level ics --seed 1`，`--level none|ics|ics-pos|all`，`--min-pins`，`--init pins-small|pins|centres`。
- 轨迹：`node harness/agent/trace.mjs <run 目录>`。
- 每次 Cypress 调用硬限 150 s，dsh shell 175 s，runner 178 s 监控，满足单次工具调用 < 3 min。
- 人工布局有包围盒重叠，报告同时给出原始人工指标和同协议合法化后的人工参考。
