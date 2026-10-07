# Cypress agent harness

The layout engine is the corrected NVIDIA NVlabs Cypress CUDA build. dsh / DeepSeek Flash reads board connectivity and writes placement constraints through a narrow CLI. Every `place` invokes Cypress; there is no WebGPU/LNS/polish fallback. The existing shared geometric legalizer follows Cypress, and raw CUDA coordinates remain in each job.

The incremental bridge bakes the candidate's existing orientation and bottom-side mirror into pad geometry, then maps Cypress's delta rotation back. Export and final engine pins are checked individually, retaining duplicate node/net pads. Power/ground pads separated by the KiCad adapter are restored to the CUDA objective. Reported HPWL and PathFinder `clean/nets` remain signal-net metrics. The current K60 experiment uses the existing calibrated-full router: actual board pitch, 80 rounds and board net-class rules. These remain proxy metrics, not FreeRouting or manufacturing DRC.

Every worker has a 165-second watchdog, dsh tools have 175 seconds, and CUDA has `timeout 120s` plus a three-second kill grace. Jobs and dsh runs are sequential on the shared GPU. The K60 preset disables Cypress's expensive net-crossing term while retaining every signal, power and ground pin in its HPWL/density/rotation objective. A candidate can be selected only after CUDA convergence, successful legalization and independent 0.1 mm geometry checks. Fixed-fixed source conflicts are exempt under the existing evaluator.

The isolated container receives two small, recorded Python fixes: respect the existing crossing flag in per-iteration evaluation and rotation selection; cap only the post-solve FLUTE diagnostic at its compiled `MAXD=150` limit. The CUDA placer and its HPWL/density/rotation kernels remain Cypress. RSMT excludes degree >=150 and is never used for ranking or reported as a complete-board metric. Each job records both patched engine source hashes; the installer saves original/patched files and diffs. Other containers and adapter checkouts are untouched.

## Prepare and run

The runtime snapshot records actual source files, revisions and hashes from the existing local adapter repositories; it does not alter those repositories. Use a fresh runtime and experiment directory. The runtime's Node dependency directory is a junction to the source checkout, whose package-lock hash is recorded. Docker must already expose CUDA in the configured container.

```powershell
node harness/prepare.mjs --source C:/Projects/webgpu-layout-code --bridge C:/Users/oxyfl/.codex/worktrees/7fa1/webgpu-layout-code --out results/runtime-cypress-v1
$env:CYPRESS_RUNTIME = (Resolve-Path results/runtime-cypress-v1).Path
$env:CYPRESS_CONTAINER = 'codex-cypress-harness-20261005'
node harness/install-engine-patch.mjs --container $env:CYPRESS_CONTAINER --out results/cypress-crossing-flag-patch
node --test test/bridge.test.mjs
node harness/compare-cypress.mjs --out results/k60-compare-v1
node analysis/compare-report.mjs --out results/k60-compare-v1
```

The experiment runs three dsh repetitions in each of two paired conditions: unassisted inference and three explicit human K60 main-IC poses (U201/U302/U1302). Starts, solver seeds, prompt, tools, CUDA configuration and routing match within each pair. Only the teacher text differs; the middle pair reverses arm order. Movable initialization is seeded uniform placement, never a hidden human scaffold. Mechanical/through-hole positions and board sides are declared constraints in both arms. PICO was used for initial interface checks; its incomplete pilot was stopped when the user directed attention to K60 and is excluded from three-repetition claims.

The current CLI supports `board-info`, `inspect`, read-only `preview`/`evaluate`, `place`, `status`, and `submit`. Part pages contain 48 poses. `inspect` pages contain 96 physical pads and 32 small nets; U201's 144 pads can be read completely without output truncation. `targets` are exact held poses, `relax.refs` specifies the movable scope, and `preserveRotation` retains chosen orientations. Other layouts remain available as diagnostic artifacts but cannot be silently substituted for eligible output. Model commands and tool ledgers are saved in `events.jsonl` and `workspace/tools.jsonl`; source, start, input board and prompt hashes are in each run's manifest. A separate offline worker independently reroutes every saved candidate, verifies complete per-net statuses as well as metrics and geometry, and renders layout figures.

K60's current direct comparison is `node harness/compare-cypress.mjs --out results/k60-compare-v1`. It runs three dsh repetitions in each condition, without human movable poses. The standalone condition executes exactly two global Cypress solves with a fixed warm restart; its gateway forbids advisor targets, rotation hints and scoped changes. The harness condition may inspect connectivity and choose those inputs. Both use identical seeded starts, solver-seed sequence, two-solve allowance, nine-minute session limit, engine source, geometric legalizer and calibrated-full 80-round routing. This comparison only tests this declared Cypress preset and restart baseline.

`place` now saves CUDA output and independent geometric metrics before returning an unscored candidate. Explicit `score` does the full routing in a separate <=165-second call, updates eligibility/ranking and leaves poses, sides, constraints and engine evidence exact. A scoring timeout preserves the candidate. `evaluate` remains read only. Unscored candidates and c000 cannot be submitted. `preview.targetCompatibility` checks held targets against immutable anchors separately from unrelated random-body conflicts, preventing temporary fixed targets from hiding behind the source fixed-fixed exemption.

Each evaluation requires all three repetitions. Report failures and unconverged outputs; do not compute a winning median from only successful runs or call three pairs statistically significant. After testing whether explicit key information helps, remove its numeric answers and make the model infer the corresponding decisions from netlist/pad/anchor context.

## Interactive editor with Cypress selection layout

`ui/` is the interactive placement editor from `C:/Projects/webgpu-layout` `web/` (`editor.html`, `editor.js`, `editor-worker.js`, `route-worker.js`; last web change `03ab224`): Board IR / KiCad loading, module-aware drag relayout, lock/rotate/flip, undo, and live routing. `harness/ui-server.mjs` serves it and serves its `../src` and `../bench` imports from the same runtime snapshot the harness uses, so the editor and Cypress share one problem model (`irToProblem`). The `/agent/*` copilot panel of the original page is replaced by a **Cypress 后台布局** panel.

```powershell
docker start codex-cypress-harness-20261005   # container with the recorded crossing-flag/FLUTE patches
node harness/ui-server.mjs --runtime C:/Projects/cypress-layout/results/runtime-cypress-v1 --container codex-cypress-harness-20261005
```

Open `http://localhost:8173/` in Chrome/Edge. `--boards` sets the sample-board directory (default `C:/Projects/webgpu-layout/web/boards`).

- Select parts (box, Shift, double-click a part or click a module row), then run Cypress. The worker sends the adapted problem, power rails and its layout after every queued edit. `harness/ui-cypress.mjs` fixes every unselected part at its current pose, keeps the selection on its current side, restores power/ground pads to the objective as the harness does, and keeps only nets touching the selection. `solve()` then runs the CUDA engine and the shared legalizer with the panel's clearance (default 0.1 mm; harness experiments use 0.35 mm).
- The result is applied with the editor's `setLayout`, so `撤销` / `Ctrl+Z` reverts it and auto-routing re-evaluates it. If the layout changed during the solve, the result is not applied. The panel reports incident-net HPWL (signal + power) before/after, selected-part overlaps, rotations, convergence, legalizer moves/failures and timing.
- Each job writes the request, Bookshelf export, engine logs and result to `results/ui-jobs/<job>/`. Jobs run one at a time in a worker thread (409 while busy).
