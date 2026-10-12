# PCB layout harness

Goal (AGENTS.md): an agent (dsh / DeepSeek Flash by default; Claude Code or Codex optional) uses the
`pcb` CLI tool to bring the layout metrics of real boards (routed signal nets, vias, HPWL, decoupling
and critical nets) close to the human layout. The agent decides the floorplan (IC positions and
rotations); every candidate is

`start layout -> 0.1 mm legalizer -> detail pass (small parts) -> grid router`.

The algorithms underneath (problem model, KiCad / IR import, legalizer, router) are in `../core`.
No GPU, Docker or Cypress is needed. Results of all experiments: [RESULTS.md](RESULTS.md); adding and
evaluating a board: [skills/pcb-eval](../skills/pcb-eval/SKILL.md).

## Layout

| Path | Role |
|---|---|
| `lib/env.mjs` | Repository paths (`core/`) and machine-specific locations from env variables or `harness/local.json`. |
| `lib/board.mjs` | Board registry (`core/bench/kicad-cases.mjs` + `boards.json`; KiCad or IR), `loadBoard`, `legalize`, `evaluate` (router at 0.4 mm, board layers, 40 rounds, per-net status), `evaluateRobust` (median over grid phases, worker threads), `toolRouting` / `exactRouting`. |
| `lib/native-router.mjs`, `native/router.cpp` | Native router loop, bit-identical to `core/src/router/board-router.js`; optional layer-aware A*, cleanup, constraint rules (priority, via cost, layers, keepout). Build: `cmd /c harness\native\build.cmd` (MSVC; `VCVARS` overrides vcvars64.bat). |
| `lib/start-layout.mjs`, `lib/init.mjs` | Start layout from a partial plan (below). `start-layout.mjs` has no Node imports (geometry passed in). |
| `lib/detail.mjs`, `native/detail.cpp` | Detail pass: annealed local search on small parts (< 8 pins) for HPWL + routing-channel deficit + decoupling capacitors to their IC + critical nets with limits. The native pass (built by `build.cmd`, used when present) gives the same result as the JS one, ~10x faster. |
| `lib/constraints.mjs`, `constraints/` | Design constraints: decap -> IC assignment, critical nets and limits; `constraints/<board>.json` overrides, `<board>.template.json` defaults, `examples/` test files. |
| `lib/human-metrics.mjs` | Decoupling / critical-net metrics against the human layout. |
| `lib/geometry.mjs` | Shared pad / net geometry. |
| `lib/uncross.mjs` | Crossing removal. |
| `lib/kicad-export.mjs` | KiCad export of a layout with the router's tracks (review). |
| `agent/session.mjs` | Tool commands: `info`, `map`, `check`, `place`, `inspect`, `status`, `submit`. |
| `agent/cli.mjs`, `agent/run-agent.mjs`, `agent/batch.mjs`, `agent/trace.mjs` | Sandbox client `pcb`; one agent session (gateway, prompt, audit, trajectory, final re-evaluation); 3 repetitions; readable trajectory. |
| `prompts/v*.md` | Agent prompts (v14 current). |
| `experiments/` | Current evaluation workflow (`eval-board.mjs` and the scripts it runs), objective / constraint studies; `experiments/archive/` = scripts of earlier RESULTS sections. |
| `ui/server.mjs` | Static server of the web editor (`../ui`); `POST /api/tool-place` / `tool-route` run `ui/tool-place.mjs` (the editor's 自动布局 = the no-agent tool layout) / `ui/tool-route.mjs` (routing under the evaluation protocol) in child processes; `ui/editor-board.mjs` builds the evaluation board of the editor's file. |

Results go to `harness/results/` (git-ignored).

## Setup

Node >= 22. Copy `harness/local.example.json` to `harness/local.json` (git-ignored) or set the
environment variables named in `lib/env.mjs`:

- `boardsRoot` (`PCB_BOARDS_ROOT`): checkout with the benchmark KiCad boards of
  `core/bench/kicad-cases.mjs`; boards registered in `harness/boards.json` need nothing;
- `uiBoards` (`UI_BOARDS`): web editor sample boards;
- `freeroutingDir`: archived FreeRouting experiment only.

Build the native router once (without it the JS router is used: same results, slower). Tests run on
the IR fixtures in `test/fixtures` and need no other checkout: `npm test`.

## Run

```powershell
node harness/experiments/eval-board.mjs --board k60 --tag eval        # whole evaluation of one board
node harness/agent/batch.mjs --board k60 --prompt harness/prompts/v14.md --minutes 20 --places 12 --out harness/results/v14-k60
node harness/agent/trace.mjs harness/results/v14-k60/rep1
npm run ui                                                             # editor at http://localhost:8173/
```

Other agents with the same gateway, tool, prompt and budget: `--agent claude` (Claude Code `claude -p`,
default `--model claude-haiku-5-5`, restricted mode) and `--agent codex` (`codex exec`, workspace-write
sandbox with `windows.sandbox="unelevated"`). A failed `place` is not charged to the agent's budget.

## Init (tool algorithm, derived from the netlist only)

Parts not in the agent's plan start as follows, then the legalizer and the detail pass refine:

1. each part at the weighted mean of the pins it connects to on positioned parts, weighted by
   1/(pin count of the partner part): humans put small parts next to the partner with fewer
   pins (k60 median 4.3 mm from it vs 15.8 mm from the larger partner);
2. each free part takes the quarter turn that points its pins at the pins they connect to;
3. parts without signal nets (decaps) around a positioned IC sharing a non-ground supply net.

## Time limits (every tool call < 3 min)

Detail pass 20000 tries per small part, at most 60 s (`PCB_DETAIL_TRIES`, `PCB_DETAIL_BUDGET`), then routing until 150 s after the
start of the call. Boards > 1000 parts (ppc) route with incremental PathFinder (<= 20 rounds) and
stop after the round that passes the deadline; the result says when routing was cut short. The
final evaluation of a submitted layout uses the full routing.

## Protocol notes

- Mechanical and through-hole parts stay fixed, parts keep their board side, 0.1 mm legalization.
- The human layout can have rectangle overlaps (k60: 55 pairs; fsl-mini: U601 under the shield
  SH701), so human metrics are reported as is (the target shown to the agent).
- The router is grid-phase sensitive: compare medians over grid phases (`evaluateRobust`; sweeps use
  8 independent offsets), never single routings.
