# Cypress PCB layout harness for dsh

Goal (AGENTS.md): a dsh agent (DeepSeek Flash, `dsh --profile headless`) uses a CLI tool to
bring the layout metrics of real KiCad boards — routed signal nets, vias, HPWL — close to the
human layout. **NVIDIA Cypress is the only placer.** The agent decides the floorplan (IC
positions/rotations, optional Cypress knobs and net weights); every candidate is
`start layout -> Cypress (CUDA container) -> shared 0.1 mm legalizer -> benchmark router`.
The WebGPU placer / LNS of webgpu-layout-code is not used.

## Layout

| Path | Role |
|---|---|
| `lib/env.mjs` | Paths: adapter checkout (`CYPRESS_LAYOUT_ROOT`, default the `codex/cypress-official-refresh` worktree), boards (`CYPRESS_PLACER_ROOT`), container (`CYPRESS_CONTAINER`). |
| `lib/board.mjs` | Load a registered KiCad case like `bench/cypress/compare.mjs` (THT fixed, original sides; `only` = sub-board); `legalize`; `evaluate` = repository geometry + PathFinder routing at 0.4 mm, board layers, 40 rounds, with per-net status; `evaluateRobust` = median over grid phases; `toolRouting` / `exactRouting`. |
| `native/router.cpp`, `lib/native-router.mjs` | Native routing loop (bit-identical to the JS router; optional layer-aware A*). Build: `cmd /c harness/native/build.cmd` from PowerShell (MSVC 2022). |
| `lib/modules.mjs` | Netlist modules (IC + small parts linked only to it). |
| `lib/cypress.mjs` | One Cypress job: Bookshelf export, warm start, net weights, hard timeout (150 s), import, final pin check (<= 0.025 mm). |
| `cypress/run.py` | Container-side runner: copy of the adapter `run.py` + job-local log (parallel jobs), warm-start orientation (`hints.json`), per-net weights. |
| `lib/start-layout.mjs`, `lib/init.mjs` | Start layout from a partial plan (see "Init" below). `start-layout.mjs` has no Node imports (geometry passed in) so the editor worker loads it too; `init.mjs` binds it for Node. |
| `agent/session.mjs` | Tool commands: `info`, `map`, `check`, `place`, `inspect`, `status`, `knobs`, `submit`. |
| `agent/cli.mjs` | In-sandbox client `pcb` (strict flags, JSON over HTTP). |
| `agent/run-agent.mjs` | One dsh session: gateway outside the sandbox, task prompt, audit, trajectory (`events.jsonl`, `session/tools.jsonl`), independent final re-evaluation. |
| `agent/batch.mjs` | 3 parallel repetitions (AGENTS.md: every evaluation uses 3 dsh runs). |
| `agent/trace.mjs` | Readable trajectory. |
| `prompts/v*.md` | Agent prompts. |
| `experiments/*.mjs` | Key-information experiments without an agent. |

Results go to `harness/results/` (git-ignored).

## Run

```powershell
docker start codex-cypress-official-20261004
node harness/agent/batch.mjs --board k60 --prompt harness/prompts/v6.md --minutes 20 --places 12 --out harness/results/v6-k60
node harness/agent/trace.mjs harness/results/v6-k60/rep1
```

One board per batch: three k60 agents already share the GPU; six concurrent jobs pushed
Cypress over its 150 s limit. A timed-out `place` is not charged to the agent's budget.

## Init (tool algorithm, derived from the netlist only)

Parts not in the agent's plan start as follows, then Cypress refines:

1. each part at the weighted mean of the pins it connects to on positioned parts, weighted by
   1/(pin count of the partner part): humans put small parts next to the partner with fewer
   pins (k60 median 4.3 mm from it vs 15.8 mm from the larger partner);
2. each free part takes the quarter turn that points its pins at the pins they connect to;
3. parts without signal nets (decaps) around a positioned IC sharing a non-ground supply net.

## Cypress settings (harness defaults)

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

Cypress hard timeout = remaining job budget (150 s; 80 s on boards > 1000 parts), at most 3
concurrent Cypress jobs × 6 threads (12-core host). Boards > 1000 parts (ppc) route with
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
