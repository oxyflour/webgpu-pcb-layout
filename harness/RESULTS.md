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
