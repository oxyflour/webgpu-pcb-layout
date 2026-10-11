# Vendored: webgpu-layout-code adapter

Verbatim copy (`git archive`) of the files the harness and the web editor import, so this branch does
not depend on another checkout.

- Source: repository `oxyflour/webgpu-pcb-layout`, branch `codex/cypress-official-refresh`, commit
  `af14ed54cf4d70b884f562beece018e1ff3f776d` (2026-10, "Add the three-seed repository KiCad cohort to
  the Cypress report"); the branch builds on `master` (`a0a8de6`) with 57 commits.
- Copied: `src/` (all), `bench/kicad-cases.mjs`, `bench/pipeline.mjs` and its imports (`rudy`,
  `decap-rules`, `anchors`, `edge-rules`, `power-edges`), `bench/cypress/repository-metrics.mjs`,
  `bench/cypress/bookshelf.mjs`, `package.json` (package name `webgpu-pin-layout`, needed for its
  self-import `webgpu-pin-layout/node`), `LICENSE` (MIT).
- Not copied: tests, examples, results, the other bench scripts.
- Optional dependency: the npm package `webgpu` is only needed by the GPU experiments
  (`lib('src/node.js')`, WebGPU placer comparisons); the tool, the router, the detail pass and the
  evaluation do not use it. Install with `npm install --prefix vendor/webgpu-layout-code webgpu`.

Do not edit these files in place; to update, copy again from a commit of the source branch and update
this note. `harness/lib/env.mjs` points here unless `CYPRESS_LAYOUT_ROOT` / `harness/local.json`
`layoutRoot` says otherwise.
