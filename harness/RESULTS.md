# Results log (2026-10-05)

All numbers use the same protocol: repository KiCad cases, original sides, mechanical +
through-hole parts fixed, 0.1 mm shared legalizer, PathFinder routing on the board's two
layers at 0.4 mm / 40 rounds, unweighted signal HPWL. Cypress image `cypress:20261004`,
RTX 3090 Ti. "Clean" = signal nets routed without overflow.

## Reference points

| Board | Signal nets (count) | Human raw: clean (count) | Human raw: vias (count) | Human raw: HPWL (mm) | Human after legalizer + gentle Cypress: clean / vias / HPWL (mm) |
|---|---|---|---|---|---|
| pico | 86 | 86 | 59 | 915 | 86 / 59 / 904 |
| edk | 124 | 124 | 64 | 3089 | 124 / 62 / 3059 |
| k60 | 318 | 318 | 291 | 5799 | 318 / 323 / 5814 |

Human raw layouts contain rectangle overlaps (k60: 55 pairs), so the legal column is the fair
target for legal candidates. Warm-starting Cypress from the human layout keeps it (mean move
0.18 mm pico, 0.01 mm k60): the tool does not destroy the input's key information.

## Cypress alone vs harness (3 runs each)

| Board | Cypress alone, random start, benchmark config + legalizer: clean (count) | Same: vias (count) | Tool init + Cypress, no agent, no human info: clean | Same: vias | Same: HPWL (mm) | dsh agent + tool: clean | Same: vias | Same: HPWL (mm) |
|---|---|---|---|---|---|---|---|---|
| pico | 71 / 76 / 19 | 273 / 254 / 422 | 84 / 83 / 80 | 127 / 153 / 124 | 1402 / 1437 / 1447 | 86 / 86 / 86 (v1) | 76 / 81 / 75 | 880 / 891 / 909 |
| edk | 119 / 124 / 122 | 381 / 148 / 328 | 124 / 124 / 124 | 135 / 121 / 131 | 3136 / 3138 / 3209 | 124 / 124 / 124 (v1) | 82 / 101 / 119 | 2927 / 3049 / 2969 |
| k60 | 23 / 16 / 16 | 4351 / 4165 / 4200 | 207 / 209 / 217 | 1137 / 1135 / 1036 | 8048 / 7930 / 8020 | 300 / 262 / 287 (v2) | 642 / 732 / 819 | 6020 / 6074 / 6725 |

Cypress-alone rows are the historical benchmark (`cypress-official-refresh-cd3978f`, seeds
1000/8919/16838, including unconverged runs as diagnostics); this harness reproduces the
pico/1000 row exactly. pico/edk agent rows were run with the first init (`pins`), k60 v2 with
the current init (`pins-small` + decaps); v2 k60 lost most place calls to CPU-oversubscription
timeouts, fixed afterwards (2 Cypress slots × 6 threads).

## Key-information ladder (Cypress gentle, no agent)

Which part of the human solution must Cypress be given? Others start from the tool init.

| Board | Given from human | Init | Clean (count, 3 seeds) | Vias (count) | HPWL (mm) |
|---|---|---|---|---|---|
| pico | nothing | centres | 75-82 | 184-211 | 1435-1448 |
| pico | IC x,y only (rotation 0) | centres | 80-81 | 132-142 | 1378-1384 |
| pico | IC x,y + rotation | centres | 86 | 91-94 | 928-930 |
| pico | IC x,y + rotation | pins-small | 86 | 66-70 | 900-924 |
| edk | IC x,y + rotation | centres | 124 | 118-151 | 2925-3238 |
| edk | IC x,y + rotation | pins-small | 124 | 112-141 | 2950-3158 |
| k60 | IC x,y + rotation | centres | 188-217 | 997-1090 | 6659-6712 |
| k60 | IC x,y + rotation | pins | 223-240 | 830-922 | 5886-5978 |
| k60 | IC x,y + rotation | pins-small | 302-316 | 569-581 | 5782-5873 |
| k60 | all parts with >= 2 signal pins | centres | 312 (1 seed) | 459 | 5828 |

Findings that shaped the tool and prompt:
1. IC position **and rotation** are the decisive agent decision; the `check` rotation advisor
   recovers the human rotations from human positions (pico U5 → 3, U2 → 0).
2. Humans put two-pin parts next to the partner with fewer pins (k60: median 4.3 mm from it,
   15.8 mm from the larger one) → init weights partner pins by 1/pin count (`pins-small`).
3. Decaps (no signal nets) start beside an IC sharing their supply net.
4. Cypress at 600 iterations / lr 0.002 converges more often than 300 and adds fewer vias;
   default (1000 / 0.01) re-places globally and is worse.
5. Rule rejected after checking human data: "no parts under a large IC on the other side"
   (human k60 has 21 parts, incl. the SPI flash, under U201).

6. Rejected after measurement: rail decaps at their own IC pin (acc 2884 -> 2999-3093 vias,
   k60 305 -> 214-222 clean), down-weighting rail nets in Cypress (acc 2919-2942, no gain).
8. Rotation advisor (`check` bestRotation) at the human IC positions picks the human rotation
   for 16 of 20 ICs (k60 6/8, pico 2/2, edk 5/5, acc 3/5). A position hint was rejected: the
   connectivity centroid is 3-50 mm from the human IC spot (fixed partners only: up to 36 mm).
7. acc's remaining via gap is in its 297 one-signal-pin parts (decaps on +1.5V/+1.0V/... rails
   that the adapter keeps as signal nets): human poses for all parts with >= 2 signal pins
   give 2840 vias, adding the one-pin parts gives 2613 (human-legal reference 2620). Humans
   put these pads ~1 mm (median) from an IC pin of the rail.

## Speed and correctness of the Cypress pass

| Board | Configuration | Cypress wall (s) | Start given | Clean (count) | Vias (count) | HPWL (mm) |
|---|---|---|---|---|---|---|
| k60 | crossing on, deterministic (old default) | 59-83 | human ICs | 307 | 528 | 5869 |
| k60 | crossing off, rotation accepted on wirelength (bug) | 14 | human layout | 265 | 755 | 7096 |
| k60 | crossing on | 45 | human layout | 318 | 341 | 5814 |
| k60 | crossing off, rotations frozen | 24 | human layout | 318 | 359 | 5683 |
| k60 | crossing off, frozen, derived small-part rotation (current) | 16 | human ICs | 311 | 553 | 5586 |
| acc | crossing off, frozen, derived rotation (current) | 14 | human ICs | 617 | 2885 | 17037 |
| acc | crossing on | > 150 (timeout) | human ICs | - | - | - |

The acc v3 and k60 v3b agent rows below ran with the buggy rotation acceptance; v4 reruns
them with the current tool.

## Agent runs on the large boards (3 runs each)

| Board, prompt/tool | Clean (count) | Vias (count) | HPWL (mm) | Run time (min) |
|---|---|---|---|---|
| acc, v3 (buggy rotation) | 617 / 617 / 617 of 617 | 2799 / 2715 / 2840 | 16413 / 16131 / 16629 | 11.5-13.1 |
| k60, v3 slow Cypress | 299 / 315 / 283 of 318 | 678 / 604 / 774 | 6049 / 5983 / 6233 | 14.9-19.2 |
| k60, v3b fast (buggy rotation) | 278 / 314 / 303 of 318 | 801 / 629 / 645 | 6011 / 5896 / 5865 | 10.5-13.6 |

Human acc: 617 / 2600 / 17115 (legal reference 617 / 2620 / 17295).

## Current tool (frozen rotation, derived small-part rotation, fast Cypress, deadline routing)

Agent runs, 3 dsh repetitions each (DeepSeek Flash). Final layouts re-evaluated with the full
benchmark routing; all legal (0 overlaps, outline, keepouts, fixed parts, sides).

| Board, prompt | Clean nets (count, of total) | Vias (count) | HPWL (mm) | Run time (min) | Human: clean / vias / HPWL (mm) |
|---|---|---|---|---|---|
| k60, v4 | 318 / 297 / 300 of 318 | 504 / 651 / 631 | 5572 / 6036 / 5754 | 9.3-16.2 | 318 / 291 / 5799 |
| acc, v4 | 617 / 617 / 617 of 617 | 2801 / 2889 / 2895 | 16006 / 16158 / 16099 | 9.8-19.5 | 617 / 2600 / 17115 |
| ppc-n3, v5 | 1599 / 1606 / 1605 of 1607 | 9624 / 10003 / 9684 | 61019 / 55800 / 63857 | 12.0-27.9 | 1607 / 8729 / 54188 |
| ppc-n3, v6 (`info --section ics`) | 1606 / 1606 / 1607 of 1607 | 9506 / 10112 / 9542 | 58684 / 56837 / 54075 | 20.8-28.1 | 1607 / 8729 / 54188 |

ppc v5 rows are after the tiny-overlap nudge (the original v5 run left 1-4 legalizer
grid-rounding overlaps of 3-16 um; fixed for v6).

## Standalone Cypress on acc / ppc (benchmark config, random start, legalizer, full routing)

| Board | Seed | Cypress status | Cypress wall (s) | Clean nets (count, of total) | Vias (count) | HPWL (mm) |
|---|---|---|---|---|---|---|
| acc | 1000 | converged | 172 | 615 of 617 | 3647 | 20491 |
| acc | 8919 | converged | 182 | 483 of 617 | 5163 | 26979 |
| acc | 16838 | unconverged | 315 | 444 of 617 | 5939 | 35169 |

## Router noise and robust scoring (2026-10-07)

Same layout, routed again after moving the 0.4 mm grid phase (shift) or every movable part by
<= 0.01 mm (jitter); `experiments/router-noise.mjs`.

| Board, layout | Perturbation (runs) | Clean nets (count, min-max) | Vias, layer steps (count, min-max) |
|---|---|---|---|
| k60, human | shift (8) / jitter (8) | 318-318 / 318-318 | 291-316 / 283-323 |
| k60, agent v4 rep2 | shift (8) / jitter (8) | 285-303 / 276-310 | 650-716 / 645-696 |
| ppc-n3, human, exact routing | shift (5) | 1602-1607 | 8437-8729 |
| ppc-n3, agent v6 rep1, exact routing | shift (5) | 1599-1606 | 9457-9506 |

`evaluateRobust` (lib/board.mjs) routes 5 grid phases (3 on boards > 1000 parts) in worker
threads and reports the median and the min-max; the tool, the human target and the final
evaluation use it. Standard deviation over 8 (ppc: 4) jittered copies (`experiments/robust-check.mjs`):

| Board, layout | Single routing: clean SD (count) | Median of phases: clean SD (count) | Single routing: vias SD (count) | Median of phases: vias SD (count) |
|---|---|---|---|---|
| k60, v4 rep1 (3 phases) | 2.0 | 1.6 | 16.8 | 5.6 |
| k60, v4 rep2 (3 phases) | 9.7 | 2.6 | 17.6 | 16.3 |
| k60, v4 rep3 (3 phases) | 2.7 | 2.9 | 13.9 | 6.8 |
| ppc-n3, v6 rep1, fast routing (3 phases) | 1.7 | 0.8 | 62.4 | 39.8 |

`viaSites` counts physical vias (a stack of layer changes at one cell = 1); `vias` keeps the old
layer-step count (a through via on 10-layer ppc counts up to 9). ppc-n3 viaSites ~4400-4700 vs
4629 through vias in the human KiCad file.

FreeRouting 2.5.0 (`experiments/freerouting.mjs`, DSN of the same pads/nets, board rules):
human pico 83/86 routed in 200 s (harness router 86/86 in < 1 s), human k60 not finished in 590 s.
Not usable inside a < 3 min tool call.

## Module split, key information (no agent, 3 seeds, robust scoring)

Modules (`lib/modules.mjs`): each IC (movable, >= 8 signal pins) plus the small parts whose only
IC/fixed partner is that IC (ppc-n3: 36 modules, 641 of 2042 movable parts; human distance to the
IC outline median 1.3 mm, p90 9.6 mm). All levels get the human IC poses. `experiments/modules.mjs`.

| Board, level | Clean nets (count, seeds 1/2/3) | Vias, layer steps (count) | Vias, physical (count) | HPWL (mm) |
|---|---|---|---|---|
| k60, ics (tool init) + global Cypress | 310/301/306 | 532/532/573 | = layer steps | 5586/5574/5621 |
| k60, + human module members + global Cypress | 310/309/309 | 491/507/496 | = layer steps | 5674/5744/5686 |
| k60, + per-module Cypress members + global Cypress | 264/255/254 | 819/828/779 | = layer steps | 6063/6055/5999 |
| ppc-n3, ics (tool init) + global Cypress | 1605/1606/1602 | 9369/9377/9245 | 4720/4688/4606 | 55376/55935/55122 |
| ppc-n3, + human module members + global Cypress | 1605/1606/1605 | 9155/9147/9172 | 4447/4379/4413 | 56402/57441/56406 |
| ppc-n3, + human module members, no global pass | 1605/1605/1604 | 9146/9114/9104 | 4378/4384/4343 | 57925/57864/57918 |

Human module internals are key information (ppc -6 % physical vias, k60 -8 % vias). Laying out a
module alone (sub-board Cypress, IC locked) packs the members against the IC because their links to
parts outside the module are missing (k60 U201: human members median 13 mm from the IC outline,
tool ~0) and is much worse than the plain init.
(ppc-n3 module-context row, seed 1 only: clean 1603, vias 9373, physical vias 4638, HPWL 56137 mm; no
gain over the ics row. 6 of 30 module jobs returned NaN, module precompute 348 s.)

## Native router (2026-10-07)

`native/router.cpp` (build `native/build.cmd`, MSVC) runs the negotiation loop of the adapter router;
JS still rasterizes and orders nets. Bit-identical to the JS router (clean, vias, rounds, per-net
status) on pico, k60 (human + agent layout) and acc (`experiments/native-check.mjs`). Optional
layer-aware A* heuristic: + viaCost x layers left to the target pad's layer range (admissible and
consistent; same path cost, different ties, so not bit-identical).

| Routing of one grid phase | ppc-n3 human: time (s) | acc human: time (s) | k60 agent v4 rep2: time (s) |
|---|---|---|---|
| JS exact (old final evaluation) | 151 | 11.3 | 3.1 |
| Native exact | 87-108 | 7.2 | 1.8 |
| Native + layer heuristic | 22.4 | - | 2.0 |
| Native + layer heuristic + incremental rip-up | 6.9 | 2.4 | 1.5 |

Ranking check on 16 ppc-n3 layouts (human, agent v6, module experiments), median of 3 phases,
reference = exact (`experiments/rank-check.mjs`): native + layer heuristic + incremental gives the
same clean count on all 16, Spearman 0.974 on vias (layer steps), 0.926 on physical vias; physical
vias are 20-48 % higher (the cost counts layer steps only, so via stacking is decided by ties) and
are not a reliable objective in this mode.

Tool routing (`toolRouting` in lib/board.mjs): boards > 1000 parts native + layer heuristic +
incremental, others native exact; final evaluation native exact. ppc-n3 `place` call: 71 s
(Cypress 19 s, routing 41 s, converged) instead of ~135 s with weighted A* and a routing deadline.

## Agent runs with the native-router tool (ppc-n3, prompt v7, 3 runs)

v7 = v6 with the tool facts updated (router layers, ~70 s per place, metrics are medians over grid
phases, differences inside `metrics.noise` are noise). Budget 30 min / 16 place calls. Final
evaluation: exact routing, median of 3 grid phases (v6: one exact routing).

| Prompt / tool | Clean nets (count, of 1607) | Vias, layer steps (count) | Vias, physical (count) | HPWL (mm) | Place calls used (count, of budget) | Run time (min) |
|---|---|---|---|---|---|---|
| v6, JS weighted fast routing in the tool | 1606 / 1606 / 1607 | 9506 / 10112 / 9542 | - | 58684 / 56837 / 54075 | 6 / 10 / 7 of 10 | 20.8-28.1 |
| v7, native routing in the tool | 1603 / 1606 / 1606 | 9541 / 9790 / 9753 | 4972 / 5292 / 5257 | 60296 / 52832 / 54501 | 5 / 4 / 8 of 16 | 11.5-18.8 |

Human (exact, median of 3 phases): 1607 clean, 8729 vias (8437-8729 over phases). The faster tool did
not change the outcome: agents stopped on their own after 4-8 place calls, and successive
candidates differ by less than the routing noise.

## Via gap of the v7 agent layouts (ppc-n3)

`experiments/export-review.mjs` (KiCad files with the router's routing, per-net CSV) and
`experiments/via-gap.mjs`: the v7 runs have ~980 more layer-step vias than the human layout (exact
router, phase 0). By net kind: IC + small parts 552, small parts only 228, IC + fixed part 137,
IC-IC 60. 367 nets are > 20 mm longer (HPWL) than in the human layout and carry ~500 of the gap.
U1 (CPU, 462 pins) anchors 313.

U1 small parts (`experiments/u1-transplant.mjs`; movable parts with < 8 signal pins on a signal net
with U1: 133 linked only to U1, 134 also to another IC / fixed part), exact router, median of 3
grid phases:

| Layout | Vias, layer steps (count, v7 rep1 / rep2 / rep3) | Vias, physical (count) | HPWL (mm) |
|---|---|---|---|
| Human, legalized | 8802 | 3955 | 56567 |
| Human + v7's U1 parts linked only to U1 | 8990 / 8979 / 9017 | 4169 / 4120 / 4208 | 57120 / 57167 / 57475 |
| Human + v7's U1 series parts | 8933 / 9000 / 8923 | 4096 / 4184 / 4135 | 61893 / 57978 / 58035 |
| Human + v7's U1 small parts (both) | 9052 / 9120 / 9087 | 4345 / 4313 / 4309 | 61965 / 58046 / 58457 |
| v7 final | 9560 / 9770 / 9738 | 4989 / 5284 / 5215 | 60320 / 52854 / 54560 |
| v7 final + human's U1 small parts (relative to U1) | 9551 / 9788 / 9786 | 5139 / 5351 / 5379 | 66551 / 57726 / 60243 |

In the human context v7's U1 small-part placement costs +250 to +320 vias (~30 % of the gap), both
halves contribute; human relative poses do not transfer into the v7 layout (different surroundings,
U1 ~8 mm off; the legalizer pushes 10 % of the inserted parts 8-17 mm). Review page:
`experiments/review-html.mjs` (two synchronized panes, routes per layer, net table).

### Large-IC start rules (lib/init.mjs placeNearLargeICs, option largeIc, default off)

Rules from the human ppc layouts (results/bigic-stats.mjs): around ICs with >= 100 pins, series parts
on the IC's side and parts linked only to the IC go just outside the outline on the side of their
IC pin (rows), except parts on the other board side at pins > 5 mm inside the outline (may stay
under the IC); series parts on the other side keep the pins-small start. Exact router, median of 3
grid phases (`experiments/largeic-check.mjs`, `experiments/modules.mjs --large-ic`):

| Context | Without the rules: vias, layer steps (count, 1 / 2 / 3) | With the rules: vias, layer steps (count) | Without: vias, physical (count) | With: vias, physical (count) | Without: HPWL (mm) | With: HPWL (mm) |
|---|---|---|---|---|---|---|
| Human + v7's U1 small parts (rep1 / rep2 / rep3) | 9052 / 9120 / 9087 | 8902 / 8965 / 8971 | 4345 / 4313 / 4309 | 4214 / 4209 / 4219 | 61965 / 58046 / 58457 | 59422 / 57917 / 57727 |
| v7 final layouts (rep1 / rep2 / rep3) | 9560 / 9770 / 9738 | 9574 / 9758 / 9789 | 4989 / 5284 / 5215 | 5068 / 5334 / 5390 | 60320 / 52854 / 54560 | 62353 / 54864 / 57124 |
| Tool, no agent: human IC poses + start layout + global Cypress (seed 1 / 2 / 3) | 9369 / 9377 / 9245 | 9291 / 9405 / 9234 | 4720 / 4688 / 4606 | 4670 / 4773 / 4643 | 55376 / 55935 / 55122 | 57001 / 57760 / 56751 |

Human reference: 8802 / 3955 / 56567. The rules recover about half of the cost of v7's U1 placement
when everything else is human, but change nothing in the agent layouts or at tool level (within the
routing noise) while HPWL rises 1.5-2 %: series parts pulled next to U1 lengthen the other leg
unless the partner IC also sits next to U1. Kept off.

## WebGPU vs Cypress vs tool start layout (2026-10-07, 13 non-ppc boards, 3 seeds)

`experiments/webgpu-vs-cypress.mjs` (report: `webgpu-vs-cypress-report.mjs` -> `results/webgpu-vs-cypress/report.html`).
Harness protocol (THT + mechanical fixed, original sides, shared 0.1 mm legalizer, evaluateRobust with the
exact native router). Methods: WebGPU = adapter `placeBoard` with the `compare.mjs` options (random
multi-start); Cypress = benchmark config from a random start; tool start layout = `lib/start-layout.mjs`
(empty plan), alone, + Cypress (harness defaults), + WebGPU (`initMode` global: the start layout is the only
global-stage start) and + WebGPU LNS only. Medians of 3 seeds per board, aggregated over the 13 boards:

| Method | Clean rate, mean over boards (%) | Vias ÷ human legal, geometric mean (×) | HPWL ÷ human legal, geometric mean (×) | Placement time, median (s) |
|---|---|---|---|---|
| WebGPU, random start | 89.8 | 2.38 | 1.46 | 5.5 |
| Cypress, random start | 78.4 | 3.95 | 2.24 | 64.9 |
| Tool start layout alone | 97.0 | 1.59 | 1.04 | 0.0 |
| Tool start layout + Cypress | 97.0 | 1.55 | 1.03 | 14.7 |
| Tool start layout + WebGPU global | 100.0 | 1.30 | 0.99 | 4.5 |
| Tool start layout + WebGPU LNS only | 96.5 | 1.61 | 1.09 | 5.0 |

The start layout carries most of the gain: Cypress's gentle pass barely changes it (clean equal on 11
boards, vias 6 better / 7 worse). Starting WebGPU's global stage from it is best (fewer vias than
start + Cypress on 11 / 13 boards; k60 318/318 clean, pic 308/310). Remaining gap is vias (k60 557 vs
human 345, pic 492 vs 363).

### Editor whole-board layout with the tool start layout (`experiments/editor-init.mjs`)

The editor's 自动布局 (its problem: `irToProblem` sides 'ir', THT not pinned; its options: `--quality
--modules auto --cohesion 3`, budget same) with and without the start layout as the global start. Same
routing evaluation; seeds 1 / 2 / 3; now the editor default.

| Board | Editor before, median of 3 seeds: clean nets / vias / HPWL (mm) | Editor + tool start layout, median of 3 seeds: clean nets / vias / HPWL (mm) | Start layout better on clean / vias / HPWL (seeds, of 3) |
|---|---|---|---|
| z3r0 | 46/46 / 39 / 743 | 46/46 / 30 / 689 | 0 / 3 / 3 |
| pico | 86/86 / 80 / 1033 | 86/86 / 71 / 975 | 0 / 2 / 3 |
| edk | 124/124 / 140 / 3332 | 122/124 / 207 / 3003 | 0 / 0 / 3 |
| edu-fpga | 108/108 / 113 / 2225 | 108/108 / 116 / 2130 | 0 / 2 / 2 |
| fsl-mini | 162/162 / 341 / 6560 | 162/162 / 279 / 5676 | 1 / 3 / 3 |
| edu-k60 | 157/157 / 283 / 5620 | 157/157 / 264 / 5378 | 0 / 3 / 3 |
| edu-nxp | 163/163 / 343 / 5970 | 163/163 / 268 / 5390 | 0 / 3 / 3 |
| safety | 184/186 / 544 / 6411 | 186/186 / 421 / 5494 | 2 / 3 / 3 |
| pic | 300/310 / 826 / 8118 | 310/310 / 580 / 7098 | 3 / 3 / 3 |
| nxp | 370/370 / 898 / 10855 | 370/370 / 844 / 9908 | 0 / 3 / 3 |
| rx | 400/400 / 1007 / 11383 | 400/400 / 874 / 8995 | 0 / 3 / 3 |
| k60 | 211/318 / 1302 / 10101 | 308/318 / 892 / 8989 | 3 / 3 / 3 |
| acc | 517/617 / 4551 / 22117 | 617/617 / 3459 / 18157 | 3 / 3 / 3 |

Placement time unchanged (1.5-2.9 s). Regression: edk is worse on every seed (vias 140 -> 167 / 207 /
209, clean 124 -> 122 / 122 / 120) although HPWL drops 7-15 %; with the benchmark options the same start
layout improved edk (vias 123 -> 101), so it interacts with the editor's module / free-side setup. Open.

## Router cleanup stage and passive-array key information (2026-10-07)

### Cleanup after negotiation (native/router.cpp `cleanup`, default off)

After the 40 PathFinder rounds every net that is not clean is ripped up; the clean nets become
hard obstacles and the ripped nets are rerouted one by one on free cells only, in 4 orders (span
ascending, descending, 2 shuffles), keeping the order with most nets routed. Nets that still fail
keep a soft route for vias / length and count as not clean. With cleanup 0 the router is still
bit-identical to the JS router (native-check, k60). `experiments/cleanup-check.mjs`: each layout
routed at 8 random sub-cell grid offsets (4 on ppc-n3; independent phases, unlike evaluateRobust's
shifts, where shift 4 repeats shift 1 exactly: k60 290 / 980 both), exact native router (ppc-n3:
tool routing), legalized layouts. Values: median (min-max) over the offsets.

| Board | Layout | No cleanup: clean nets (count) | Cleanup ×4: clean nets (count) | No cleanup: vias, layer steps (count) | Cleanup ×4: vias, layer steps (count) | Nets ripped up by cleanup (count, median) | Of those rerouted clean (count, median) |
|---|---|---|---|---|---|---|---|
| k60 | human | 318 (318-318) | 318 (318-318) | 303 (291-328) | 303 (291-328) | 0 | 0 |
| k60 | editor+init 1 | 286 (270-294) | 309 (305-311) | 991 (956-1037) | 1103 (1033-1156) | 31 | 23 |
| k60 | editor+init 2 | 308 (299-311) | 316 (314-317) | 897 (852-916) | 897 (865-941) | 9 | 7 |
| k60 | editor+init 3 | 307 (300-314) | 315 (313-317) | 885 (838-924) | 906 (845-955) | 8 | 6 |
| k60 | editor (no init) 1 / 2 / 3 | 203 / 218 / 205 (spread 8-11) | 264 / 272 / 269 (spread 6-15) | 1277 / 1277 / 1325 | 1369 / 1394 / 1442 | 114 / 99 / 111 | 61 / 52 / 64 |
| pic | human, editor+init 1-3 | 310 everywhere (min 308) | 310 (310-310) | unchanged | unchanged | 0 | 0 |
| acc | editor+init 1 / 2 / 3 | 617 / 612 (606-617) / 617 | 617 / 615 (613-617) / 617 | unchanged (±4) | unchanged (±4) | 0 / 4 / 0 | 0 / 2 / 0 |
| ppc-n3 | human, v7 rep1-3 | 1607 / 1604 / 1606 / 1606 | same | unchanged (±12) | unchanged (±12) | 0-3 (opens) | 0 |

On congested layouts (k60) cleanup recovers most nets lost to the last overflow cells and shrinks
the clean-net spread over grid phases from 14-24 to 4-6 nets; the ranking of the layouts stays.
Vias rise 0-11 % (recovered nets detour). Boards that already route clean are unchanged; route time
+5-40 %. Not yet the default: switching changes the metric (human targets unchanged).

### Human passive arrays: injection and reverse ablation

`lib/modules.mjs findArrays`: >= 3 same-size 2-pin parts bridging the same pair of big parts over
small signal nets. `experiments/array-inject.mjs` copies the human arrangement (arrays, or whole
buildModules modules) into an agent layout relative to the anchor IC (mirrored when the IC is on
the other side), then the legalizer; `experiments/array-shuffle.mjs` permutes array parts over
their own slots in the HUMAN layout (geometry and legality unchanged, only the order). No cleanup.

| Board | Layout | Original: vias, layer steps (count, median (min-max) of 4 offsets) | + human arrays: vias (count) | + human modules: vias (count) | Original / + arrays / + modules: HPWL (mm) |
|---|---|---|---|---|---|
| ppc-n3 | v7 rep1 (clean 1604 / 1602 / 1604) | 9656 (9628-9680) | 9625 (9623-9632) | 9602 (9597-9649) | 60320 / 63549 / 64042 |
| ppc-n3 | v7 rep2 (clean 1606 / 1606 / 1607) | 9814 (9790-9837) | 9756 (9698-9825) | 9716 (9714-9838) | 52854 / 56065 / 56602 |
| ppc-n3 | v7 rep3 (clean 1606 / 1606 / 1606) | 9804 (9799-9903) | 9707 (9705-9865) | 9737 (9729-9776) | 54560 / 57077 / 57956 |

Arrays: 24 groups, 154 parts, mean move 29-38 mm; legalizer then moves 400-500 parts.

| Board | Arrays (count) / parts (count) | Human, legalized: vias (count, median (min-max), 8 offsets; ppc 4) | Human, array order shuffled, seed 1 / 2 / 3: vias (count, median) | Shuffled - human: vias (count) |
|---|---|---|---|---|
| ppc-n3 | 24 / 154 | 8798 (8718-8953) | 8879 / 8947 / 8905 | +81 to +149 (+0.9-1.7 %) |
| pic | 2 / 12 | 353 (341-368) | 376 / 381 / 383 | +23 to +30 (+7-8 %) |
| k60 | 2 / 8 | 330 (321-346) | 341 / 334 / 338 | +4 to +11 (within noise) |

Clean nets unchanged in all shuffles (k60 one offset 316). Array order is real key information
(about +0.5-2.5 vias per scrambled part) but small: on ppc-n3 it accounts for ~100 of the ~1000
via gap, consistent with the injection (-30 to -100). Human relative poses again transfer poorly
(HPWL +4-6 %), as in the U1 transplant above.

### Why the human layout routes the same at every grid phase (k60)

`experiments/why-stable.mjs`: 8 grid offsets per layout, routing capacity changed through the grid
pitch (0.45 mm = 21 % fewer cells than 0.4 mm, 0.3 mm = 78 % more). Native exact router, 40 rounds.

| Layout | Grid pitch (mm) | Clean nets (median, min-max of 8 offsets) | Offsets reaching overflow 0 (count of 8) | Round reaching overflow 0 (median) | Overflow cells after round 1 (median) | Overflow cells after round 40 (median) |
|---|---|---|---|---|---|---|
| human | 0.4 | 318 (318-318) | 8 | 11 | 432 | 0 |
| human | 0.45 | 318 (318-318) | 8 | 16 | 477 | 0 |
| human | 0.5 | 318 (314-318) | 5 | 27 | 527 | 0 |
| human | 0.55 | 310 (306-315) | 3 | 27 | 547 | 1 |
| editor+init 1 / 2 / 3 | 0.3 | 318 / 318 / 318 (min 316) | 5 / 7 / 8 | 29 / 14 / 15 | 1546 / 1448 / 1324 | 0 |
| editor+init 1 / 2 / 3 | 0.35 | 311 / 318 / 315 (min 309 / 314 / 314) | 0 / 5 / 4 | - / 22 / 33 | 1645 / 1489 / 1430 | 3 / 0 / 0 |
| editor+init 1 / 2 / 3 | 0.4 | 288 / 307 / 308 (min 269 / 298 / 293) | 0 / 0 / 0 | - | 1713 / 1576 / 1501 | 22 / 6 / 5 |

Stability is margin, not a property of human layouts: clean nets are phase-independent exactly when
negotiation reaches overflow 0. The human layout keeps that with 21 % less capacity and becomes
noisy like the agent layouts at 0.55 mm; the agent layouts become stable with 30-78 % more capacity.
First-round overflow (shortest routes, no negotiation) is 3.5-4x the human's: the agent layouts
demand more of the same cells. Pads enclosed by other owners in the rasterization: 476 in both
(not a cause). Vias stay phase-dependent even for the human layout (291-319).

### Routing-margin feedback to the agent (prompt v8, k60, 3 dsh sessions each, 2026-10-08)

Tool output gained `routingMargin` (overflowRound1 / overflowRound5 / phasesConverged / roundsToZero,
with the human values), `congestion` (top areas by round-1 overflow, averaged over grid phases,
with the ICs touching them and the small parts inside), `fragileNets`, and `inspect --congestion 1`.
Prompt v8 = v7 + a routing-margin section. Baseline: prompt v7 with that output hidden
(PCB_MARGIN_FEEDBACK=0). 20 min, 12 place calls. Why use it: on 15 good k60 layouts overflowRound1
ranks clean / vias at Spearman 0.65 / 0.74, HPWL at -0.04 / 0.19 (overflowRound5 vs vias 0.93).
Submitted layouts re-routed at 8 independent grid offsets (exact native router):

| Configuration, session | Clean nets (count, median (min-max) of 8 offsets) | Vias, layer steps (count, median) | Overflow cells after round 1 (count, median) | Offsets converged (count of 8) | HPWL (mm) | Place calls used (count of 12) |
|---|---|---|---|---|---|---|
| v7, no margin output, rep1 | 307 (299-312) | 573 | 923 | 0 | 5596 | 9 |
| v7, no margin output, rep2 | 291 (276-308) | 692 | 974 | 0 | 5831 | 7 |
| v7, no margin output, rep3 | 299 (284-304) | 611 | 877 | 0 | 5551 | 10 |
| v8 + margin output, rep1 | 284 (274-291) | 636 | 1002 | 0 | 5638 | 6 |
| v8 + margin output, rep2 | 310 (305-318) | 491 | 749 | 2 | 5548 | 12 |
| v8 + margin output, rep3 | 294 (284-304) | 621 | 891 | 0 | 5619 | 8 |
| Tool, no agent, human IC poses (seed 1 / 2 / 3; 5 phases) | 297 / 306 / 304 | 559 / 546 / 556 | 842 / 811 / 857 | 0 | 5574 / 5593 / 5592 | - |
| Human | 318 (318-318) | 310 | 468 | 8 | 5799 | - |

No significant difference over 3 sessions (mean clean 296 vs 299, vias 583 vs 625); v8 rep2 is the
best agent layout so far (only one converging in some phases). The agents read the feedback and
reason with it (rep1: U201's east pin row squeezed into a 2.5 mm channel to J601; rep2 tuned U201's
y by overflowRound1), but their lever is the IC floorplan, and even the HUMAN IC poses give
overflowRound1 811-857 with this tool: the remaining gap to 468 is in the tool's small-part
placement (Cypress + legalizer around the IC), which the agent does not control. 5 of 6 sessions
also stopped after 8-10 of 20 minutes believing time was up.

### Small parts in the congested areas: key information, start-layout fix, relieve (k60 / 13 boards)

`experiments/hotspot-inject.mjs`: tool layouts with the HUMAN IC poses (place with the human IC
plan, 3 seeds), then human poses for chosen small parts, legalized, 5 grid phases:

| Small parts given their human pose | Parts (count) | Clean nets (count, seed 1 / 2 / 3) | Vias (count) | Overflow cells after round 1 (count) | Phases converged (count of 5) |
|---|---|---|---|---|---|
| none | 0 | 297 / 301 / 295 | 553 / 542 / 567 | 846 / 830 / 862 | 0 |
| in the 4 most congested areas | 36-38 | 318 / 318 / 318 | 492 / 503 / 527 | 752 / 741 / 731 | 3 |
| in the 8 most congested areas | 66-76 | 318 / 318 / 318 | 472 / 473 / 463 | 678 / 673 / 650 | 3-4 |
| all linked to U201 | 199 | 318 | 468 / 428 / 444 | 669-675 | 4-5 |
| all | 396 | 318 | 327 / 339 / 345 | 498-505 | 4-5 |

Of the 38 tool parts in the 4 areas only 11 are there in the human layout (median 9.5 mm from
their human pose, 29 with another rotation); decaps 37-71 mm off. Cause in lib/start-layout.mjs:
parts left without a usable net stayed at the board centre (= on the MCU): decaps whose supply has
no IC (k60: 13 on +5V) and capacitors whose only signal net is a > 30-part net (+3.3V routed as a
signal, ~15 on k60). Fix: fallback anchor = other positioned parts on the same supply; > 30-part
signal nets count as supplies; spread over ICs by pads on the supply. k60 decaps within 20 mm of
U201: 18 -> 13 -> (human 1). Human IC poses + tool after the fix: clean 312 / 308 / 311, vias 524 /
532 / 490, overflow round 1 769 / 795 / 732 (1/5 phases converged once).

Regression (`experiments/start-regression.mjs`; old start + Cypress = webgpu-vs-cypress tool layouts,
new start + Cypress, same seeds 1000 / 8919 / 16838, both scored with the current evaluateRobust):

| Board | Old start + Cypress: clean nets (count, mean of 3) | New start + Cypress: clean nets (count, mean) | Old: vias (count, mean) | New: vias (count, mean) | Old: HPWL (mm) | New: HPWL (mm) |
|---|---|---|---|---|---|---|
| acc | 617.0 | 617.0 | 3286 | 3169 | 19400 | 19538 |
| edk | 124.0 | 124.0 | 111 | 111 | 2916 | 2910 |
| edu-fpga | 106.3 | 106.0 | 213 | 217 | 2569 | 2503 |
| edu-k60 | 150.3 | 154.3 | 423 | 392 | 5729 | 5721 |
| edu-nxp | 163.0 | 163.0 | 341 | 336 | 5555 | 5619 |
| fsl-mini | 162.0 | 162.0 | 316 | 314 | 6097 | 6123 |
| k60 | 301.3 | 309.7 | 672 | 608 | 6482 | 6560 |
| nxp | 370.0 | 370.0 | 782 | 787 | 8661 | 8888 |
| pic | 217.7 | 253.3 | 900 | 757 | 6005 | 6151 |
| pico | 86.0 | 86.0 | 76 | 76 | 971 | 972 |
| rx | 400.0 | 400.0 | 801 | 809 | 8823 | 8856 |
| safety | 186.0 | 185.3 | 379 | 410 | 5268 | 5372 |
| z3r0 | 46.0 | 46.0 | 26 | 24 | 663 | 663 |

Sum of clean nets 2929.7 -> 2976.7; vias x0.972, HPWL x1.006 (geometric means). Only safety loses
(vias +8 %).

`lib/relieve.mjs` (agent command `relieve`): local search over the small parts in the N most
congested areas, moves rotate / swap / nudge toward partners / evict past the area edge, each
legalized, objective = overflowing cells after 5 rounds at 2 grid phases, 10 worker threads,
~7 evaluations/s on k60. `experiments/relieve-check.mjs`, 90-100 s, robust scoring before / after:

| Layout | Small parts searched (count) | Clean nets before -> after (count, median of 5 phases) | Vias before -> after (count) | Overflow after round 5 before -> after (count) |
|---|---|---|---|---|
| k60, human IC poses + old start (seed 1) | 38 | 297 -> 304 | 553 -> 551 | 258 -> 244 |
| k60, human IC poses + new start (seed 1) | 36 | 309 -> 310 | 517 -> 527 | 212 -> 211 |
| pic, new start + Cypress (seed 1000) | 25 | 240 -> 273 | 734 -> 740 | 445 -> 381 |

Relief helps where congestion sits in a few areas (pic), not where it is spread (k60 after the fix);
on k60 the 2-phase objective improves (211 -> 186) without a robust change (phase overfitting).

### Prompt v9 (margin feedback + relieve + budget field) vs v7 on pic (new start layout, 3 dsh each)

Both with the decap-fixed start layout; v7 with the margin output hidden (no relieve). 20 min, 12
place calls (relieve counts as one). Submitted layouts re-routed at 8 independent grid offsets:

| Configuration, session | Clean nets (count of 310, median (min-max)) | Vias, layer steps (count, median) | Overflow cells after round 1 (count, median) | Offsets converged (count of 8) | HPWL (mm) | Minutes used (of 20) | relieve calls (count) |
|---|---|---|---|---|---|---|---|
| v7, rep1 | 304 (298-308) | 552 | 849 | 0 | 5698 | 12.4 | - |
| v7, rep2 | 308 (306-310) | 529 | 806 | 2 | 5666 | 9.7 | - |
| v7, rep3 | 310 (310-310) | 430 | 657 | 8 | 5402 | 11.8 | - |
| v9, rep1 | 308 (306-310) | 528 | 752 | 4 | 5688 | 16.2 | 4 |
| v9, rep2 | 308 (306-310) | 533 | 837 | 4 | 5854 | 14.9 | 3 |
| v9, rep3 | 308 (308-310) | 527 | 809 | 3 | 6068 | 18.2 | 4 |
| Human | 310 | 342 | 475 | 8 | 5955 | - | - |

v9 is more uniform (every session 308, 3-4 of 8 offsets converged) but not better on average
(vias 529 vs 504); relieve calls gained a few nets / vias each. The best session (v7 rep3, 430 vias,
converged at every offset) found that the 24 V input parts (C16, ZA1, TH1) sat in the board centre
and moved them to J2 (502 -> 465 vias). Cause: chains of free parts linked only to each other
(and ground bridges GND-GNDA / GNDPWR) never got a positioned neighbour or a supply anchor, so the
start layout left them at the centre (1-6 parts per board, ppc 70-102). Fixed in lib/start-layout.mjs
(repeat neighbour sweep + supply anchoring for unplaced parts; minor ground nets count as supplies);
left at the centre now: 0 on 12 boards, 1 on rx, 13-15 net-less '#' parts on ppc.

Regression of the second start-layout fix (variant new2 = repeat sweeps + ground-bridge anchors, same
protocol as above): sum of clean nets old 2929.7 / first fix 2976.7 / new2 2993.3; vias x1 / x0.972 /
x0.968; HPWL x1 / x1.006 / x1.002. pic clean 217.7 / 253.3 / 271.3, vias 900 / 757 / 727; k60 301.3 /
309.7 / 310.7; edu-fpga 106.3 / 106.0 / 104.3 (only loss); others within ±1 net.

relieve with 3 grid phases in the objective (0, 1/3, 2/3 cell), new2 start + Cypress (seed 1000), 110 s:

| Board | Small parts searched (count) | Clean nets before -> after (count, median of 5 phases) | Vias before -> after (count) | Overflow after round 5 before -> after (count, robust) | Objective before -> after (count, mean of 3 search phases) |
|---|---|---|---|---|---|
| pic | 29 | 266 -> 284 | 726 -> 673 | 393 -> 331 | 373 -> 311 |
| k60 | 27 | 316 -> 314 | 611 -> 585 | 257 -> 243 | 269 -> 221 |

### End to end after all fixes: prompt v9 + new2 start + 3-phase relieve (3 dsh per board, 2026-10-09)

Submitted layouts re-routed at 8 independent grid offsets (exact native router). Earlier rows are
the runs above (different start layout versions, so this is the end-to-end change, not v9 alone).

| Board | Configuration | Clean nets (count, median per session) | Clean nets (mean of 3 sessions) | Vias, layer steps (count, median per session) | Vias (mean of 3) | Offsets converged (count of 8, per session) |
|---|---|---|---|---|---|---|
| k60 (318 nets) | v7, old start, no margin output | 307 / 291 / 299 | 299.0 | 573 / 692 / 611 | 625 | 0 / 0 / 0 |
| k60 | v8 + margin output, old start | 284 / 310 / 294 | 296.0 | 636 / 491 / 621 | 583 | 0 / 2 / 0 |
| k60 | v9 + relieve, new2 start | 316 / 316 / 309 | 313.7 | 540 / 552 / 545 | 546 | 3 / 4 / 0 |
| k60 | human | 318 | 318 | 310 | 310 | 8 |
| pic (310 nets) | v7, first-fix start, no margin output | 304 / 308 / 310 | 307.3 | 552 / 529 / 430 | 504 | 0 / 2 / 8 |
| pic | v9 + relieve (2 phases), first-fix start | 308 / 308 / 308 | 308.0 | 528 / 533 / 527 | 529 | 4 / 4 / 3 |
| pic | v9 + relieve (3 phases), new2 start | 306 / 310 / 310 | 308.7 | 517 / 425 / 499 | 480 | 1 / 8 / 8 |
| pic | human | 310 | 310 | 342 | 342 | 8 |

Sessions now use 12-19 of 20 minutes and 3-5 relieve calls. k60: +15 clean nets and -79 vias
against the v7 runs; pic: best vias 425 (human 342), 2 of 3 sessions converge at every offset.

## v9 sweep over 14 boards (2026-10-09): agent vs no agent vs human

Prompt v9 + routing-margin output + relieve, new2 start layout; 3 dsh sessions per board, 20 min,
12 place calls (k60 / pic: the v9b runs above; others: harness/results/v9s-<board>, 2 boards at a time,
RELIEVE_WORKERS=5). No agent = new2 start + Cypress, seeds 1000 / 8919 / 16838 (start-regression).
Scoring (`experiments/sweep-eval.mjs`): exact native router at 8 independent grid offsets, median per
layout; ppc-n3 with the tool routing (layer heuristic + incremental) at 3 phases. Rows in
harness/results/sweep-eval/rows.jsonl.

| Board | Signal nets (count) | Human: clean nets / vias (count) | No agent (start + Cypress): clean nets, mean of 3 seeds (count) | No agent: vias, mean (count) | Agent v9: clean nets per session (count) | Agent v9: clean nets, mean (count) | Agent v9: vias per session (count) | Agent v9: vias, mean (count) | Agent v9: vias / human (x) | Agent v9: sessions converged at every phase (count of 3) |
|---|---|---|---|---|---|---|---|---|---|---|
| z3r0 | 46 | 46 / 32 | 46.0 | 22 | 46 / 46 / 46 | 46.0 | 21 / 19 / 22 | 21 | 0.65 | 3 |
| pico | 86 | 86 / 57 | 86.0 | 75 | 86 / 86 / 86 | 86.0 | 55 / 57 / 66 | 59 | 1.04 | 0 |
| edk | 124 | 124 / 66 | 124.0 | 107 | 124 / 124 / 124 | 124.0 | 75 / 84 / 83 | 81 | 1.22 | 3 |
| edu-fpga | 108 | 108 / 77 | 103.0 | 216 | 108 / 108 / 108 | 108.0 | 96 / 93 / 96 | 95 | 1.23 | 3 |
| fsl-mini | 162 | 162 / 191 | 162.0 | 312 | 162 / 162 / 162 | 162.0 | 280 / 287 / 289 | 285 | 1.49 | 3 |
| edu-k60 | 157 | 157 / 188 | 153.7 | 401 | 157 / 157 / 157 | 157.0 | 277 / 281 / 279 | 279 | 1.48 | 1 |
| edu-nxp | 163 | 163 / 203 | 163.0 | 339 | 163 / 163 / 163 | 163.0 | 270 / 270 / 213 | 251 | 1.24 | 3 |
| safety | 186 | 186 / 227 | 186.0 | 386 | 186 / 186 / 186 | 186.0 | 258 / 364 / 349 | 324 | 1.43 | 1 |
| pic | 310 | 310 / 347 | 267.7 | 715 | 306 / 310 / 310 | 308.7 | 517 / 425 / 499 | 480 | 1.38 | 2 |
| nxp | 370 | 369 / 587 | 370.0 | 780 | 370 / 370 / 370 | 370.0 | 824 / 740 / 710 | 758 | 1.29 | 3 |
| rx | 400 | 399 / 625 | 400.0 | 804 | 400 / 400 / 400 | 400.0 | 838 / 809 / 791 | 813 | 1.30 | 3 |
| k60 | 318 | 318 / 301 | 310.3 | 602 | 316 / 316 / 309 | 313.7 | 540 / 552 / 545 | 546 | 1.81 | 0 |
| acc | 617 | 617 / 2576 | 617.0 | 3175 | 617 / 617 / 617 | 617.0 | 2769 / 2887 / 2844 | 2833 | 1.10 | 3 |
| ppc-n3 | 1607 | 1607 / 8768 | - | - | 1607 / 1607 / 1607 | 1607.0 | 9620 / 9774 / 9429 | 9608 | 1.10 | 3 |

Clean nets: the agent matches or beats the human count on 12 of 14 boards (nxp / rx: 370 / 400, the
human layout routes 369 / 399); k60 309-316 of 318, pic 306-310 of 310. Agent vs no agent: clean nets
equal or higher on every board, vias lower on every board (edu-fpga 216 -> 95, fsl-mini 312 -> 285,
pic 715 -> 480). Vias vs human: geometric mean x1.24 (0.65 z3r0 ... 1.81 k60); remaining gap mostly on
k60 / fsl-mini / edu-k60 / safety / pic (x1.4-1.8). ppc-n3: 1607 / 1607 in every session (v7: 1604-1606),
vias 9429-9774 vs human 8768 (tool routing).

relieve inside the sessions (158 calls): result better than its input 64 times, worse 57, mean change
0 clean nets / -0.2 % vias, i.e. about measurement noise on agent candidates (the offline gains, pic
+18 clean, were on congested no-agent layouts). On ppc-n3 it evaluates ~20 candidates per call. The
end-to-end gains of this round come mainly from the start-layout fixes.

relieve removed (2026-10-09): about noise on agent candidates (above) while costing a place call;
lib/relieve.mjs, its worker, the `relieve` command and experiments/relieve-check.mjs are deleted.
Prompt v10 = v9 without the relieve parts (v9 kept as the record of the runs above).

## Attachment tree / pruned graph (2026-10-09, key information, no agent)

Hypothesis: humans place outward from the main chip one part at a time, so the placement follows a
tree (or a pruned graph) of the netlist. Analysis of the 15 human layouts
(`experiments/tree-structure.mjs`, `tree-clusters.mjs`, `tree-anchors.mjs`; part graph = signal
nets with 2-30 parts, edge length = shortest human pin-to-pin distance):

- The netlist is not a tree: cycle rank 0.8-1.4 x parts (k60: 382 parts, 893 links, 512); in BFS
  order from the main chip only 33-55 % of the parts have exactly one earlier neighbour.
- Humans keep a spanning tree short and the cycle-closing links long: MST edges median 1.8-5.2 mm,
  the other links 7.6-24 mm; links <= 3 mm only: k60 cycle rank 512 -> 55, ppc-n3 2213 -> 340.
- It is not one tree from the main chip: hop depth vs distance from it Spearman 0.03-0.66; the BFS
  parent is the nearest linked part for 25-42 % of small parts; the nearest linked part of a
  small part is an IC for 15-49 % (chains of passives); 51-85 % of small parts hang on 0-1 parts
  within 3 mm, 5-44 % on >= 2.
- The current init's strongest partner (pins-small weight) is the human parent (nearest linked
  part) for 50-79 % of small parts.

Key-information test (`experiments/tree.mjs`, human IC poses for all levels, 3 seeds, robust
scoring; init option `linkScale` in lib/start-layout.mjs):

| Board, configuration | Clean nets (count, seeds 1/2/3) | Vias (count) | HPWL (mm) | Non-IC parts, start to human pose, median (mm) |
|---|---|---|---|---|
| k60, ics (tool init) + Cypress | 316 / 316 / 308 | 509 / 496 / 532 | 5593 / 5569 / 5671 | 4.7-4.9 |
| k60, human parent x10 in the init + Cypress | 293 / 284 / 296 | 639 / 665 / 640 | 5912 / 5820 / 5828 | 4.7 |
| k60, same + Cypress weight 3 on the parent nets | 277 / 276 / 289 | 666 / 669 / 614 | 5888 / 5837 / 5838 | 4.7 |
| k60, human MST links only (others x0.2) + Cypress | 318 / 316 / 312 | 507 / 493 / 523 | 5647 / 5715 / 5690 | 4.5 |
| k60, ics, start only | 318 / 314 / 304 | 499 / 509 / 551 | 5627 / 5568 / 5722 | 4.7-4.9 |
| k60, human parent x3, start only | 297 / 289 / 292 | 605 / 593 / 589 | 5749 / 5702 / 5775 | 4.6-4.8 |
| k60, human MST links x0.2, start only | 312 / 316 / 313 | 518 / 518 / 486 | 5672 / 5751 / 5685 | 4.5 |
| k60, human MST links only (others x0), start only | 316 / 318 / 318 | 499 / 493 / 481 | 5907 / 5884 / 5865 | 4.3-4.5 |
| pic, ics, start only | 310 / 310 / 308 | 526 / 501 / 512 | 5532 / 5449 / 5453 | 9.7-9.9 |
| pic, human parent x3, start only | 304 / 304 / 306 | 565 / 567 / 495 | 5471 / 5553 / 5458 | 10.4-10.7 |
| pic, human MST links only, start only | 308 / 306 / 310 | 537 / 537 / 520 | 5811 / 5733 / 5678 | 8.5 |
| acc, ics, start only | 617 / 617 / 617 | 2854 / 2833 / 2851 | 17104 / 17097 / 17181 | 5.2-5.5 |
| acc, human parent x3, start only | 617 / 617 / 617 | 2909 / 2857 / 2921 | 17046 / 17069 / 17080 | 5.2-5.3 |
| acc, human MST links only, start only | 617 / 617 / 617 | 2812 / 2857 / 2874 | 17102 / 17136 / 17115 | 3.8-4.0 |

(Human legal references: k60 318 / 323 / 5814, acc 617 / 2620 / 17295.) The human tree is not key
information for the init: pulling a part to its human parent is worse on all three boards (k60 -20
clean, +130 vias); keeping only the human tree links brings parts closer to their human pose (acc
5.4 -> 3.9 mm) but leaves the metrics within noise (k60 vias -20, pic +20, acc 0) at +3-5 % HPWL.
Which part sits next to which is not what the tool misses; the remaining gap is in exact poses
(hotspot-inject: human poses of the 66-76 small parts in the congested areas give 463-473 vias).
Not passed to the agent.

## What in the human small-part poses matters (k60, 2026-10-09)

Start: the tool layouts of the section above (human IC poses + init + Cypress, seeds 1-3); small
parts (movable, < 8 pins, 396) get parts of their human pose, legalized, 5 grid phases
(`experiments/pose-ablation.mjs`).

| Small parts given... | Parts (count) | Vias (count, seeds 1/2/3) | Clean nets (count of 318) |
|---|---|---|---|
| nothing (tool) | 0 | 504 / 509 / 541 | 315 / 313 / 312 |
| human x, y, rotation | 396 | 336 / 337 / 337 | 318 |
| human x, y, tool rotation | 396 | 394 / 390 / 390 | 318 |
| tool x, y, human rotation | 396 | 532 / 525 / 551 | 316-318 |
| human pose + uniform noise +-1 mm / +-2 mm | 396 | 345 / 362 / 361 ; 405 / 395 / 394 | 318 |
| only parts with a signal net / only decaps | 369 / 27 | 357 / 340 / 356 ; 490 / 508 / 520 | 318 ; 314-318 |
| only parts > 5 mm / <= 5 mm from the human position | ~218 / ~178 | 380 / 388 / 393 ; 475 / 501 / 469 | 318 ; 312-316 |
| only parts with another rotation (mod 180) | 239 | 435 / 422 / 438 | 316-318 |
| only the repeated bottom channels (x 55-120, y > 52) | 51 | 474 / 460 / 455 | 318 |
| only the top-right quarter (x > 90, y < 45) | 101 | 464 / 466 / 510 | 314-316 |

Position to ~1-2 mm plus rotation is the information; the parts the tool puts > 5 mm off (median
10.8 mm; 2-pin parts between partners ~25 mm apart, 52 without a signal net) carry ~70 % of the
gap; no board region dominates. In the plot (human vs tool) humans lay out repeated sub-circuits as
identical copies aligned with their connector / IC pins and use the whole board; the tool piles
them into a few clusters.

Net crossings (`experiments/crossings.mjs`, straight MST segments of every signal net): human legal
885, tool 1023-1069, human +-1 mm 900-949, +-2 mm 942-961; the tool's spanning-tree length is
shorter (4557-4636 mm vs 4788). Crowding of the 0-1 mm ring around the ICs (`ic-bands.mjs`: area
covered 0.34-0.36 vs human 0.22, pins/cm2 17-19 vs 9) is not causal: legalizing with the ICs
inflated by 1 mm (`ic-ring.mjs`) gave 517 vias (from 504).

Crossing removal is causal for part of the gap (`experiments/uncross.mjs`: greedy 180 deg turns
of 2-pin parts and swaps of same-size parts on one side within 10 mm, cost = crossings + 0.2 x
spanning-tree mm; legal by construction, k60 2 s, acc 10 s incl. evaluation):

| Board, tool layout | Crossings (count, before -> after) | Vias before (count, seeds 1/2/3) | Vias after (count) | Clean before / after (count) | HPWL after (mm) |
|---|---|---|---|---|---|
| k60, start + Cypress | 1060->809 / 1023->855 / 1069->873 | 504 / 509 / 541 | 464 / 473 / 480 | 315,313,312 / 318,316,316 | 5518 / 5560 / 5623 |
| k60, start only | 1045->821 / 1039->865 / 1147->867 | 499 / 509 / 551 | 455 / 469 / 492 | 318,314,304 / 316,316,311 | 5587 / 5573 / 5607 |
| pic, start only | 947->756 / 842->674 / 860->707 | 526 / 501 / 512 | 489 / 480 / 470 | 310,310,308 / 308,310,310 | 5546 / 5465 / 5461 |
| acc, start only | 13858->13473 / 13824->13419 / 14036->13571 | 2854 / 2833 / 2851 | 2797 / 2804 / 2867 | 617 / 617 | 17092 / 17103 / 17154 |
| k60, human legal | 885->794 | 336 | 344 | 318 / 318 | 5841 |

-25 to -45 vias without human information (lambda 0.05 / 1 and radius 25 are no better). After
it the tool has fewer straight crossings than the human (~840 vs 885) but still ~470 vias, so
the rest of the gap is not straight-line crossings.

## Coarse vs fine placement, proxies for vias (k60, 2026-10-09)

`experiments/coarse.mjs`: human IC poses; small parts planned at their human position + uniform
noise (human rotation), then the harness Cypress pass, legalizer, 5 grid phases.

| Small-part start | Vias (count, seeds 1/2/3) | Clean (count of 318) | Small parts to human after Cypress, median (mm) |
|---|---|---|---|
| human +-0 mm | 343 / 340 / 342 | 318 | 0.2-0.6 |
| human +-2 mm | 371 / 407 / 373 | 318 | 1.4-1.6 |
| human +-5 mm | 497 / 518 / 487 | 318 | 3.6-3.9 |
| human +-10 mm | 711 / 769 / 650 | 313-318 | 7.3-7.7 |
| human +-5 mm, init rotation | 509 / 535 / 501 | 318 | 3.9 |
| tool init (no small-part info) | 504 / 509 / 541 | 308-316 | 4.7 |
| tool init, Cypress target_density 0.5 / 0.4 (default 0.65) | 500 / 519 / 545 ; 493 / 514 / 525 | 306-316 | 5.6-6.0 |

The tool is as good as "human +-5 mm": its coarse placement is right, the gap is the arrangement
below ~2 mm, and the Cypress pass does not repair it (noise in = noise out). Rigid shifts of whole
human clusters (small parts linked by pins <= 3 mm apart; `pose-ablation.mjs gjit<S>`): +-2 mm
382 / 395 / 377, +-5 mm 433 / 499 / 439 (independent +-5 mm 514 / 540 / 484), so the arrangement
relative to the surroundings matters, not only inside clusters. Not the cause (`alignment.mjs`):
rows/columns (human 0.69-0.80 of small parts share x or y with a neighbour, tool 0.46) and gaps
(nearest-neighbour p50 human 0.28 mm, tool 0.12): the human layout after Cypress has 0.49 / 0.13 mm
and still 340 vias.

Round-1 overflow (cells claimed by > 1 net after one routing pass) vs vias over 126 k60 layouts of
these experiments: Pearson 0.981 (HPWL 0.42). But optimizing it directly does not transfer
(`ovf-search.mjs`, greedy shifts / turns / swaps of small parts near overflow cells, legal moves,
cost = mean round-1 overflow over 4 grid phases disjoint from the evaluation's, 0.4 s per eval):
tool seed 1, 400 evals: search overflow 788 -> 688, evaluation round-1 overflow 769 -> 717, vias
504 -> 526. Full routing as the objective costs 1.9 s per phase and one phase is noisy (same
layout 468 / 506 / 515 vias on three phases), i.e. ~6 s per move.

## Placement templates learned from the other human boards (2026-10-09, leave one board out)

`experiments/templates.mjs`: Prim tree on the human layout grown from the fixed parts and ICs (each
step attaches the small part with the shortest human pin link to a placed part). Per small part,
in the frame of its parent's pin (outward normal, tangent): d1 = parent pin -> own linked pin,
d2 = own linked pin -> own centre. Class = prefix | signal pins | pads | size | GND pad | supply
pad | parent IC or small | net size; prediction = class median on the other boards (backoff to
coarser classes). Human IC poses, parts placed in tree order, rest = tool init, legalized.

Gate on k60 (seed 1): oracle d1/d2 rebuilds the human poses (89 % of small parts within 2 mm,
357 vias); learned d1/d2: median 5.6 mm from human, 13 % within 2 mm, 525 vias (tool 499).
Offset predictability (`templates-error.mjs`, no error accumulation):

| Board | Parent kind | Parts (count) | Human d1 length, median (mm) | d1 error, learned, p50 / p90 (mm) | d2 error, learned, p50 / p90 (mm) |
|---|---|---|---|---|---|
| k60 | IC | 85 | 2.6 | 2.9 / 9.2 | 1.2 / 1.7 |
| k60 | small part | 254 | 2.4 | 3.0 / 6.7 | 1.2 / 2.4 |
| pic | IC | 82 | 4.5 | 4.3 / 11.8 | 0.8 / 2.1 |
| pic | small part | 243 | 3.2 | 3.5 / 10.4 | 0.8 / 2.4 |
| acc | IC | 168 | 1.6 | 1.6 / 9.2 | 0.5 / 1.4 |
| ppc-n3 | small part | 731 | 1.5 | 1.5 / 3.9 | 0.5 / 1.4 |

d2 (orientation around the own pin) is predictable, d1 (where the part sits relative to the
parent pin) is not: the learned error equals d1 itself. Context (`link-direction.mjs`): 48-64 % of
the parts have no other signal link (pull-ups, filter caps, ESD: their place is set by space);
for the others, direction to the other links has cosine p50 0.42-0.92 with d1, error with the
true length 1.4-2.4 mm.

"Own pin on the parent pin + learned d2" (seed 1, vias, tool -> templates): + Cypress k60 509 ->
476, pic 497 -> 527, acc 2839 -> 2799, nxp 721 -> 756, rx 800 -> 787, edu-k60 290 -> 292; start
only k60 499 -> 467, pic 526 -> 543, acc 2863 -> 2811, nxp 735 -> 762, rx 795 -> 778, edu-k60 304
-> 287; HPWL +2-8 %. No reliable gain: templates are not the missing information.

The KiCad files hold the human routing (segments / vias: k60 4461 / 456, pic 5588 / 506, acc
59024 / 1875, ppc-n3 54302 / 4629), unused so far.

## Human routing as key information (2026-10-10)

`lib/tracks.mjs` reads the human tracks per problem net (segments, track arcs as chords; net table
from the first `(net N name)` of each number) and builds a per-net graph (T-junctions split, pads
attached). Signal nets whose pads are all joined by the tracks: pico 85/86, edk 124/124, fsl-mini
161/161, safety 185/186, pic 303/309, nxp 358/369, rx 388/399, k60 305/315, acc 601/612, ppc-n3
1566/1603 (z3r0 6/45, edu-k60 70/156, edu-nxp 77/162 not usable).

Do small parts sit on the routes of their nets? (`experiments/track-trunk.mjs`; trunk = human track
paths joining the net's other pads; on trunk = track stub < 0.5 x distance to the nearest other
pad; straight-line version = distance to the straight spanning tree of the other pads.)

| Board | Single-net small parts (count) | On the track trunk, human (share) | Straight-line version: human (share) | Straight-line version: tool (share) | Series parts (count) | Detour P->part->D, straight, p90: human / tool (ratio) |
|---|---|---|---|---|---|---|
| k60 | 317 | 0.42 | 0.21 | 0.16 | 28 | 0.99 / 1.62 |
| pic | 327 | 0.44 | 0.20 | 0.16 | 21 | 0.97 / 2.92 |
| acc | 233 | 0.33 | 0.19 | 0.28 | 30 | 1.34 / 3.00 |
| nxp / rx / safety | 296 / 303 / 174 | 0.45 / 0.44 / 0.39 | 0.18 / 0.20 / 0.17 | - | 24 / 36 / 13 | - |

Humans do not put single-net parts on the straight trunk more than the tool; a few tool series
parts are far off their path (p90), but there are only 20-36 series parts per board.

Corridors (`experiments/corridor-keepout.mjs`): the human tracks of the backbone nets (no small
part; k60 28 nets, 1169 of 6194 mm of signal track) as same-side blockers while legalizing the
tool layout (ICs held): 56 parts moved 0.25 mm on average, 504 -> 524 vias (with the ICs not held
the legalizer pushed the ICs: 993 vias).

## Starting from the human layout: where do the tool's algorithms move it? (k60, 2026-10-10)

`experiments/from-human.mjs`, seed 1, 5 grid phases. loo = every small part (movable, < 8 pins)
re-placed by the tool's start-layout rule while all other parts stay at their human pose (one
call per part), the answers combined; slot = then the nearest spot where the part fits among the
legalized human poses (0.1 mm spiral).

| Start: human layout, then... | Small-part drift from human, median / p90 (mm) | Within 1 mm (share) | Rotations changed (count of 396) | Vias (count) | HPWL (mm) |
|---|---|---|---|---|---|
| legalizer only | 0.07 / 0.99 | 0.90 | 0 | 346 | 5817 |
| harness Cypress + legalizer | 0.55 / 1.67 | 0.80 | 0 | 343 | 5683 |
| benchmark Cypress (1000 iterations, lr 0.01) + legalizer | 2.16 / 5.17 | 0.18 | 0 | 363 | 5582 |
| legalizer + crossing pass (uncross.mjs) | flips / swaps | - | 38 flips | 344 | 5841 |
| loo (rule position + rule rotation) | 4.28 / 31.0 | 0.11 | 266 | 437 | 5876 |
| loo, human rotation | 4.00 / 30.8 | 0.11 | 0 | 447 | 5920 |
| loo + slot | 3.70 / 31.0 | 0.22 | 266 | 472 | 6159 |
| loo + slot, human rotation | 2.54 / 35.6 | 0.37 | 0 | 411 | 5891 |

Cypress, legalizer and crossing pass keep the human quality (Cypress pulls towards shorter wires,
+0-20 vias). The loss is in the start-layout rule even with perfect context: its position is
4.3 mm off and its rotation rule is a coin flip on the axis (`rot-rule.mjs`, k60 at the human
position: 2-pad 2-signal parts 87 same / 4 flipped / 58 other axis, 2-pad 1-signal 59 / 3 / 63).
Axis rules with perfect context (`axis-rules.mjs`, agreement with the human axis of 2-pad parts):

| Board | 2-pad parts (count) | Pins rule (current) | Fit (axis that overlaps least) | Rows (majority of 2-pad neighbours < 3 mm) | Radial to the nearest IC edge (< 5 mm) | Fit, then pins |
|---|---|---|---|---|---|---|
| k60 | 328 | 0.49 | 0.78 | 0.82 | 0.52 | 0.86 |
| pic | 339 | 0.53 | 0.55 | 0.87 | 0.47 | 0.73 |
| acc | 465 | 0.49 | 0.62 | 0.72 | 0.45 | 0.67 |
| nxp | 333 | 0.46 | 0.64 | 0.79 | 0.34 | 0.80 |
| rx | 343 | 0.50 | 0.67 | 0.72 | 0.33 | 0.83 |
| safety | 202 | 0.39 | 0.80 | 0.84 | 0.84 | 0.90 |

The axis pass on tool layouts (`axis-pass.mjs`: after legalizing, re-pick each 2-pad part's axis
by fit -> rows -> pins, legalize again): k60 vias 504 / 509 / 541 -> 499 / 475 / 516 (rows first:
501 / 496 / 515); it cannot help while the positions are 4-5 mm off.

Agent: `agent/run-agent.mjs --agent claude [--model claude-haiku-5-5]` runs Claude Code (`claude -p`,
restricted mode: file tools confined to the workspace, no user/project settings, shell limited
to ./pcb, node, python, ls, cat; same gateway, prompt, budgets and audit as dsh).

## Claude Code (Haiku 5.5) vs dsh (DeepSeek Flash) as the agent (k60, 2026-10-10)

Same tool, gateway, prompt v10 and budget (20 min, 12 place calls), 3 sessions each, run one batch
after the other (harness/results/v10-claude-k60, v10-dsh-k60); final layouts scored by the runner
(5 grid phases, native exact). Human legal reference 318 / 323 vias / 5814 mm.

| Agent | Clean nets (count of 318, sessions 1/2/3) | Vias (count) | HPWL (mm) | Minutes used (of 20) | Place calls used (of 12) | Cost per session (USD) |
|---|---|---|---|---|---|---|
| Claude Code, claude-haiku-5-5 | 314 / 314 / 292 | 506 / 531 / 638 | 5701 / 5634 / 5982 | 7.3 / 7.3 / 8.3 | 11 / 9 / 9 | 1.03 / 1.08 / 1.37 |
| dsh, deepseek-flash | 318 / 314 / 310 | 563 / 571 / 570 | 6403 / 5691 / 5626 | 13.5 / 12.9 / 13.2 | 12 / 12 / 12 | - |

Candidate sequences: Claude restarts from the centroid with a new floorplan on most calls (big
jumps, e.g. rep2 c001 314 / 531 then c002 214 / 1014) and submitted its best candidate every time;
rep3 started from a weak floorplan (276 / 645), refined it for 5 calls and stopped at 8 min with 3
calls left. dsh refines one floorplan step by step (from = previous candidate) and uses the whole
budget. Claude reaches the two best layouts of the six sessions, but is less consistent and stops
early.

Codex (`--agent codex`: `codex exec --json -m gpt-6-luna`, workspace-write sandbox with
windows.sandbox="unelevated", network on for the local gateway, approval_policy never, user config
and rules ignored), same tool / prompt v10 / budget, harness/results/v10-codex-k60:

| Agent | Clean nets (count of 318, sessions 1/2/3) | Vias (count) | HPWL (mm) | Minutes used (of 20) | Place calls used (of 12) | Tokens per session: input (cached) / output |
|---|---|---|---|---|---|---|
| Codex, gpt-6-luna | 297 / 293 / 318 | 701 / 715 / 540 | 6544 / 6282 / 5621 | 8.4 / 7.7 / 6.9 | 12 / 12 / 12 | 2.6M (2.5M) / 15k; 2.3M (2.2M) / 14k; 1.8M (1.8M) / 14k |
| Claude Code, claude-haiku-5-5 | 314 / 314 / 292 | 506 / 531 / 638 | 5701 / 5634 / 5982 | 7.3 / 7.3 / 8.3 | 11 / 9 / 9 | - |
| dsh, deepseek-flash | 318 / 314 / 310 | 563 / 571 / 570 | 6403 / 5691 / 5626 | 13.5 / 12.9 / 13.2 | 12 / 12 / 12 | - |

Codex uses all 12 calls in 7-8 min (fast calls, little thinking between them) and refines from its
best candidate like dsh; sessions 1 and 2 started from weak floorplans (198 / 1090 and 272 / 729)
and never recovered (best 304 / 734 and 293 / 715), session 3 started well (304 / 535) and ended
318 / 540, the best clean + vias of the dsh / Codex sessions. Sessions 1 and 2 submitted a
candidate with fewer vias over one with more clean nets (c007 297 / 701 vs c009 304 / 734).
Across the three agents the start floorplan decides the session: no agent recovers from a weak
first IC placement within 12 calls.
