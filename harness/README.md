# PCB layout harness for dsh

Goal (AGENTS.md): a dsh agent (DeepSeek Flash, `dsh --profile headless`) uses a CLI tool to
bring the layout metrics of real KiCad boards — routed signal nets, vias, HPWL — close to the
human layout. The agent decides the floorplan (IC positions/rotations); every candidate is
`start layout -> shared 0.1 mm legalizer -> detail pass (small parts) -> benchmark router`.
NVIDIA Cypress was the global placer until 2026-10-11; after the detail pass it no longer changed
the result (RESULTS.md, "Attraction test"), so `place` no longer runs it. `lib/cypress.mjs` and the
container remain for the experiments that use them.
The WebGPU placer / LNS of webgpu-layout-code is not used.

## Layout

| Path | Role |
|---|---|
| `lib/env.mjs` | Locations from env variables or `harness/local.json`: adapter code (default `vendor/webgpu-layout-code`), KiCad boards checkout, UI boards, Cypress container / FreeRouting (optional). No machine paths in the code. |
| `lib/board.mjs` | Load a registered KiCad case like `bench/cypress/compare.mjs` (THT fixed, original sides; `only` = sub-board); `legalize`; `evaluate` = repository geometry + PathFinder routing at 0.4 mm, board layers, 40 rounds, with per-net status; `evaluateRobust` = median over grid phases; `toolRouting` / `exactRouting`. |
| `native/router.cpp`, `lib/native-router.mjs` | Native routing loop (bit-identical to the JS router; optional layer-aware A*). Build: `cmd /c harness/native/build.cmd` from PowerShell (MSVC 2022). |
| `lib/tracks.mjs` | Human routing (KiCad track segments / arcs per problem net, per-net graph with the pads attached) for key-information experiments. |
| `lib/modules.mjs` | Netlist modules (IC + small parts linked only to it). |
| `lib/cypress.mjs` | One Cypress job: Bookshelf export, warm start, net weights, hard timeout (150 s), import, final pin check (<= 0.025 mm). |
| `cypress/run.py` | Container-side runner: copy of the adapter `run.py` + job-local log (parallel jobs), warm-start orientation (`hints.json`), per-net weights. |
| `lib/start-layout.mjs`, `lib/init.mjs` | Start layout from a partial plan (see "Init" below). `start-layout.mjs` has no Node imports (geometry passed in) so the editor worker loads it too; `init.mjs` binds it for Node. |
| `lib/detail.mjs` | Detail pass after the legalizer: annealed local search on small parts (< 8 pins) for HPWL + routing-channel deficit between facing pads + 0.5 x decoupling-capacitor distance to the IC supply pins (30 s per place; `PCB_DETAIL=0` turns it off). |
| `lib/human-metrics.mjs` | Metrics against the human layout: decoupling-capacitor distance to IC supply pins, critical-net (crystal, clock, reset, differential pair) lengths and vias. |
| `lib/constraints.mjs`, `constraints/` | Design constraints: decap -> IC assignment (schematic sheet or `constraints/<board>.json`) and critical nets (net classes, crystal, pairs, file limits); `<board>.template.json` = defaults to copy and edit; `examples/` = USB-pair test files. Limits become router rules (`routerRules`: route first, via cost, layers, keepout; native router only); `place` and the human target use them; agents read them with `info --section constraints`. |
| `lib/uncross.mjs` | Crossing removal (180 deg turns of 2-pin parts, same-size swaps); used by the editor's auto layout, not by `place` (not additive after the detail pass). |
| `agent/session.mjs` | Tool commands: `info`, `map`, `check`, `place`, `inspect`, `status`, `knobs`, `submit`. |
| `agent/cli.mjs` | In-sandbox client `pcb` (strict flags, JSON over HTTP). |
| `agent/run-agent.mjs` | One dsh session: gateway outside the sandbox, task prompt, audit, trajectory (`events.jsonl`, `session/tools.jsonl`), independent final re-evaluation. |
| `agent/batch.mjs` | 3 parallel repetitions (AGENTS.md: every evaluation uses 3 dsh runs). |
| `agent/trace.mjs` | Readable trajectory. |
| `prompts/v*.md` | Agent prompts. |
| `experiments/*.mjs` | Key-information experiments without an agent. |

Results go to `harness/results/` (git-ignored).

## Setup

Self-contained: the adapter code (problem model, KiCad/IR import, legalizer, router source) is vendored
in `vendor/webgpu-layout-code` (see its VENDOR.md). Machine-specific locations go in
`harness/local.json` (git-ignored; copy `harness/local.example.json`) or environment variables
(`harness/lib/env.mjs`): `placerRoot` (checkout with the registered KiCad benchmark boards; boards in
`harness/boards.json` need nothing), `uiBoards` (web editor only), `cypressContainer` / `freeroutingDir`
(older experiments only). Cypress, Docker and a GPU are not needed for the tool, the agents or the
evaluation. Build the native router once: `cmd /c harness
ativeuild.cmd` (MSVC; `VCVARS` overrides
the vcvars64.bat path); without it the JS router is used (same results, slower). Node >= 22.

## Run

```powershell
node harness/agent/batch.mjs --board k60 --prompt harness/prompts/v12.md --minutes 20 --places 12 --out harness/results/v12-k60
node harness/agent/trace.mjs harness/results/v6-k60/rep1
```

Other agents with the same gateway, tool, prompt and budget: `--agent claude` (Claude Code `claude -p`,
default `--model claude-haiku-5-5`, restricted mode: file tools confined to the workspace, shell limited to
`./pcb`, node, python, ls, cat) and `--agent codex` (`codex exec`, default `--model gpt-6-luna`,
workspace-write sandbox with `windows.sandbox="unelevated"`, network on for the local gateway; without the
unelevated sandbox every command is rejected "blocked by policy" on Windows).

A failed `place` is not charged to the agent's budget. Without Cypress there is no GPU limit; each
place uses one core for the detail pass and up to 5 for the routing phases.

## Init (tool algorithm, derived from the netlist only)

Parts not in the agent's plan start as follows, then the legalizer and the detail pass refine:

1. each part at the weighted mean of the pins it connects to on positioned parts, weighted by
   1/(pin count of the partner part): humans put small parts next to the partner with fewer
   pins (k60 median 4.3 mm from it vs 15.8 mm from the larger partner);
2. each free part takes the quarter turn that points its pins at the pins they connect to;
3. parts without signal nets (decaps) around a positioned IC sharing a non-ground supply net.

## Cypress settings (experiments only since 2026-10-11)

600 iterations, lr 0.002, crossing term off, non-deterministic kernels, orientations frozen at
the warm start. Measured reasons:

- Upstream logs the net-crossing count every iteration; skipping that log (run.py) took acc
  from 122 s to 6.5 s of optimizer time with identical output.
- The crossing term itself is slow on acc (600 iterations > 150 s). With it off, upstream's
  rotation step must not accept samples on wirelength alone (that wrecked the human k60 warm
  start: 318/346 -> 265/755), so run.py freezes orientations; the plan and init set them.
- `net_crossing_weight` and `deterministic` are fixed by the harness for agents (crossing made
  acc runs exceed the time limit); experiments may still set them.

## Time limits (every tool call < 3 min)

Detail pass 30 s (60 s on boards > 1000 parts), then routing until a deadline 150 s after the
start of the call. Boards > 1000 parts (ppc) route with
incremental PathFinder (<= 20 rounds) and stop after the round that passes a deadline; the
result says when routing was cut short. The router deadline is a one-line runtime patch of
the adapter's `board-router.js` (generated under `results/.cache`, the other repository is
untouched). Final evaluation of the submitted layout uses the full benchmark routing.

## Protocol notes

- Same evaluation as the repository Cypress benchmark; the random-start run reproduces the
  historical pico/1000 row exactly (71/86 clean, 273 vias, HPWL 1861 mm).
- The human layout has rectangle overlaps (k60: 55 pairs), so human metrics are reported raw
  (target shown to the agent) and also after the same legalizer + Cypress pass
  (k60: 318/318, 323 vias, 5814 mm), which is the fair reference for legal candidates.
- Warm starts keep rotation enabled. `enable_rotation=0` or -inf orientation logits made
  warm-started parts drift ~9 mm on pico, so those are not exposed.
