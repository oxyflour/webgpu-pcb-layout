# Archived experiments

Scripts behind earlier sections of `harness/RESULTS.md` that are not part of the current workflow
(see `skills/pcb-eval/SKILL.md` and `harness/experiments/`). Imports point at the current `harness/lib`
and `core/`; they are kept runnable but not maintained, and some depend on result files of their
time under `harness/results/`. `editor-init.mjs` needs the optional npm package `webgpu`;
`freerouting.mjs` needs `freeroutingDir` (harness/local.json). The Cypress experiments (and
`link-direction.mjs` / `templates-error.mjs`, which used one of them) were removed on 2026-10-11
(see the git history before commit "Refactor 1").
