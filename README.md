# PCB layout harness

Goal and conventions: [AGENTS.md](AGENTS.md). An agent with the `pcb` tool places real KiCad boards
and is scored against the human layout (routed nets, vias, HPWL, decoupling, critical nets).

| Path | Content |
|---|---|
| [harness/](harness/README.md) | Tool, agents, evaluation, experiments; results log [harness/RESULTS.md](harness/RESULTS.md). |
| [core/](core/README.md) | Problem model, KiCad / board-IR import, legalizer, grid router, WebGPU placer of the editor. |
| [ui/](ui/) | Interactive placement editor (served by `npm run ui`). |
| [skills/pcb-eval](skills/pcb-eval/SKILL.md) | How to add a board (KiCad or IR) and run the whole evaluation. |
| [test/](test/) | `npm test` on the IR fixtures in `test/fixtures` (no other checkout needed). |
| docs/ | Slide decks of earlier rounds. |

Setup: Node >= 22, `harness/local.json` from `harness/local.example.json` (only for the benchmark KiCad
boards and the editor sample boards), `cmd /c harness\native\build.cmd` for the native router (MSVC).
No GPU, Docker or Cypress is needed.

## Interactive editor

`ui/` (`editor.html`, `editor.js`, `editor-worker.js`, `route-worker.js`): board IR / KiCad loading,
module-aware drag relayout, lock / rotate / flip, undo, live routing, and whole-board automatic layout
(WebGPU global stage started from the harness tool start layout, then crossing removal). Its `../src`
and `../bench` imports are served from `core/` and the start layout from `harness/lib/`, so the page
and the harness use one problem model.

```powershell
npm run ui        # node harness/ui/server.mjs [--port 8173] [--boards DIR]  ->  http://localhost:8173/
```
