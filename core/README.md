# core

The PCB problem model and the algorithms the harness and the web editor build on: KiCad parsing and
the board IR (`src/kicad`, `src/ir`), the problem / geometry helpers (`src/problem.js`,
`src/geometry`), the legalizer and module detection (`src/optimizer`), the grid router
(`src/router/board-router.js`, mirrored by `harness/native/router.cpp`), the WebGPU placer used by the
editor (`src/gpu`, `src/optimizer/*placement*`, `src/session.js`, `bench/pipeline.mjs` and its rule
modules), the benchmark board registry (`bench/kicad-cases.mjs`) and the repository geometry metrics
(`bench/repository-metrics.mjs`).

Origin: the webgpu-layout-code project (repository `oxyflour/webgpu-pcb-layout`, branch
`codex/cypress-official-refresh`, commit `af14ed54cf4d70b884f562beece018e1ff3f776d`), copied with
`git archive` and trimmed to the files these entry points import. It is maintained here; changes
since the copy:

- `src/router/board-router.js`: harness hooks (deadline, shared usage / history arrays, search-window
  callback, weighted A*, router internals, physical via count `viaSites`), formerly patched in at run
  time by `harness/lib/router-gen.mjs`.
- `bench/repository-metrics.mjs`: moved from `bench/cypress/`.

The npm package `webgpu` is optional: only the Node WebGPU path (`src/node.js`, used by
`harness/experiments/archive/editor-init.mjs`) needs it. License: MIT (`LICENSE`).
