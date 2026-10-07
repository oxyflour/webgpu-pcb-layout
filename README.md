# Cypress PCB layout harness

Goal and conventions: [AGENTS.md](AGENTS.md). The harness (dsh agent + `pcb` CLI, NVIDIA Cypress as the only placer, shared legalizer and benchmark router) is documented in [harness/README.md](harness/README.md), its results in [harness/RESULTS.md](harness/RESULTS.md). Cypress environment and benchmark: [skills/cypress-layout](skills/cypress-layout/SKILL.md).

## Interactive editor with Cypress selection layout

`ui/` is the interactive placement editor of `C:/Projects/webgpu-layout` `web/` (`editor.html`, `editor.js`, `editor-worker.js`, `route-worker.js`): Board IR / KiCad loading, module-aware drag relayout, lock / rotate / flip, undo and live routing. `harness/ui/server.mjs` serves it and serves its `../src` / `../bench` imports from the harness's adapter checkout (`harness/lib/env.mjs` `LAYOUT_ROOT`), so the page and Cypress use one problem model. The original page's `/agent/*` copilot panel is replaced by a **Cypress 后台布局** panel.

```powershell
docker start codex-cypress-official-20261004
npm run ui        # node harness/ui/server.mjs [--port 8173] [--boards DIR]  ->  http://localhost:8173/
```

- Select parts (box, Shift, double-click a part, or click a module row) and run Cypress. The worker hands over its problem and the layout after every queued edit. `harness/ui/selection.mjs` fixes every unselected part at its current pose, keeps the selection on its side, keeps the signal nets touching the selection, and runs the harness job: `lib/cypress.mjs` `runCypress` warm-started from the current layout (harness defaults; orientations stay as they are unless "允许 Cypress 调整朝向" turns on the crossing term), then `lib/board.mjs` `legalize` (0.1 mm).
- The result is applied with the editor's `setLayout`, so `撤销` / `Ctrl+Z` reverts it and auto-routing re-evaluates it; if the layout changed during the solve it is not applied. The panel reports incident-net HPWL before / after, selected-part overlaps, Cypress convergence and the legalizer's moves / failures.
- Each job writes the request, the Cypress job directory and the result to `harness/results/ui-jobs/<job>/`. One job at a time (409 while busy); it also takes one of the harness's Cypress slots.
- The editor's routing uses `evaluationRouting(board)` (board pitch, 40 rounds, no net-class rules), not the harness evaluation.

`npm test` checks the selection problem and its Bookshelf export on the editor's `edk` sample board.
