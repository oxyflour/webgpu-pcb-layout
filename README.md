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
boards and the editor sample boards), `cmd /c harness\native\build.cmd` for the native router and detail pass (MSVC).
No GPU, Docker or Cypress is needed.

## Interactive editor

`ui/` (`editor.html`, `editor.js`, `editor-worker.js`): board IR / KiCad loading,
module-aware drag relayout, lock / rotate / flip, undo, live routing, and whole-board automatic layout.
自动布局 is the evaluation's no-agent tool layout (start layout -> 0.1 mm legalizer -> detail pass, at
most 60 s -> legalizer) on the evaluation's problem (original sides, through-hole parts fixed, the
body margin of a board registered in `harness/boards.json`): the server runs it in Node
(`POST /api/tool-place`, `harness/ui/tool-place.mjs`; the native detail pass is not available in the
browser). Routing is the evaluation's too (`POST /api/tool-route`, `harness/ui/tool-route.mjs`):
0.1 mm legalization (not for the file's own layout, like the human layout), native router, median over
8 grid offsets (> 1000 parts: tool routing, 3 phases); the median-vias phase is drawn. A drag re-places
the moved part's module and every module the dropped parts overlap (`PlacementSession.relayout({ moved })`,
default budget 300 ms); 重排选中 (E) re-places the selected unlocked parts. Its `../src` and `../bench` imports are served from `core/`, so the page and the
harness use one problem model.

```powershell
npm run ui        # node harness/ui/server.mjs [--port 8173] [--boards DIR]  ->  http://localhost:8173/
```
