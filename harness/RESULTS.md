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

## Crossing removal in the tool pipeline (lib/uncross.mjs, 2026-10-09)

`place` is now start layout -> Cypress -> legalize -> **uncross** -> route. uncross = the greedy pass
of experiments/uncross.mjs (180 deg turns of movable 2-pin parts, swaps of same-size parts on one
side within 10 mm; cost = straight crossings of signal-net spanning trees + 0.2 x tree mm), with
segments in a 5 mm grid, the agent's planned parts kept, a 10 s deadline, and no re-legalizing when
the result passes legalOk (it always did; the legalizer is not idempotent: re-legalizing an already
legal layout moves ~230 parts on ppc-n3, 5 on k60, 27 on pic). PCB_UNCROSS=0 switches it off. The
editor's auto layout runs it too (swaps only inside a module, 5 s deadline).

| Board | Parts (count) | uncross time, 4 passes (s) | Crossings before -> after (count) | `place` call end to end (s) |
|---|---|---|---|---|
| k60 (start + legalize) | 467 | 0.2 | 1060 -> 814 | 20 |
| pic (start + legalize) | 435 | 0.1 | 1265 -> 1013 | - |
| ppc-n3 (start + legalize) | 2207 | 21.7 (1 pass: 5.5) | 54453 -> 42507 | - |
| ppc-n3 in `place` (10 s deadline, ~2 passes) | 2207 | 10.1 | 53469 -> 43087 | 131 (Cypress 16, routing to its 125 s deadline) |

Editor auto layout, k60 (editor router, 0.457 mm grid, deterministic): without uncross 309 clean nets / 797 vias,
with it 313 / 695.

End to end, prompt v10, 3 dsh sessions per arm, 20 min, 12 place calls (all sessions used 12),
one board per batch (results/v10-<board> = PCB_UNCROSS=0, v10u-<board> = with uncross). Submitted
layouts scored with the exact native router at 8 grid offsets (`sweep-eval.mjs --prefixes v10,v10u`,
rows in results/uncross-eval.jsonl), median per layout:

| Board | Configuration | Clean nets (count, per session) | Clean nets (mean of 3) | Vias (count, per session) | Vias (mean of 3) | HPWL (mm, per session) | Offsets converged (count of 8, per session) |
|---|---|---|---|---|---|---|---|
| k60 (318 nets) | v10, no uncross | 304 / 316 / 318 | 312.7 | 595 / 467 / 552 | 538 | 5722 / 5544 / 6518 | 0 / 4 / 8 |
| k60 | v10 + uncross | 308 / 314 / 314 | 312.0 | 576 / 559 / 558 | 564 | 5512 / 5884 / 5798 | 0 / 0 / 0 |
| k60 | human | 318 | 318 | 301 | 301 | 5799 | 8 |
| pic (310 nets) | v10, no uncross | 310 / 310 / 310 | 310.0 | 496 / 481 / 491 | 489 | 5443 / 5384 / 5311 | 6 / 6 / 6 |
| pic | v10 + uncross | 310 / 308 / 310 | 309.3 | 435 / 454 / 402 | 430 | 5626 / 5744 / 5145 | 7 / 3 / 8 |
| pic | human | 310 | 310 | 347 | 347 | 5955 | 8 |

All candidates of the sessions (36 per arm, in-session scoring: tool routing, 5 phases):

| Board | Configuration | Clean nets (count, mean over 36 candidates) | Vias (count, median over 36 candidates) | HPWL (mm, median) |
|---|---|---|---|---|
| k60 | v10, no uncross | 298.4 | 576 | 5744 |
| k60 | v10 + uncross | 287.3 | 591 | 5797 |
| pic | v10, no uncross | 303.8 | 522 | 5448 |
| pic | v10 + uncross | 307.8 | 439 | 5624 |

The k60 arms differ by session trajectory, not by the pass: applied offline to the same 36
no-uncross candidates (`experiments/uncross-paired.mjs`, tool routing, paired):

| Board | Candidates (count) | Clean nets without -> with uncross (count, mean) | Candidates with more / fewer / equal clean nets (count) | Vias without -> with (count, mean) | Candidates with fewer vias (count of 36) | Median via change (count) | HPWL without -> with (mm, mean) | Crossings without -> with (count, mean) |
|---|---|---|---|---|---|---|---|---|
| k60 | 36 | 298.4 -> 303.2 | 28 / 2 / 6 | 614 -> 579 | 36 | -32 | 5991 -> 5933 | 1327 -> 1056 |
| pic | 36 | 303.8 -> 305.2 | 18 / 2 / 16 | 544 -> 524 | 35 | -19 | 5519 -> 5497 | 993 -> 829 |

uncross helps every candidate (k60 -6 % vias, +4.8 clean nets; pic -4 % vias), legal in all 72
cases. End to end it shows on pic (vias 489 -> 430 mean, best session 402 vs human 347) but not on
k60 (538 -> 564), where the no-uncross arm had one lucky session (467) and the with-uncross
sessions all stalled at ~558-576 without a converged offset; 3 sessions per arm are not enough to
see a ~30-via effect against the session spread (k60 467-595). Kept on.

Superseded on 2026-10-11: `place` no longer runs uncross. After the detail pass (lib/detail.mjs,
section "Attraction test") the crossing pass is not additive (k60 417 / 407 / 423 -> 443 / 409 / 460
vias), and Cypress was removed. lib/uncross.mjs stays in the editor's auto layout.

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

## Attraction test: which objective makes the human layout a local optimum? (2026-10-11)

`experiments/attract.mjs`: one greedy local search on small parts (movable, < 8 pins) with
interchangeable objectives. Moves: shift 0.4-2 mm, quarter / half turn, swap with a same-size part
within 6 mm; legal moves only (0.1 mm body clearance on a shared side); a move is kept when the
objective strictly drops. Router objectives use grid phases off the evaluation diagonal and pick
parts near round-1 overflow cells; geometric objectives pick parts uniformly (30000 tries,
converged). Test A: start = legalized human layout (must not get worse). Test B: start = human
small-part positions + uniform noise in [-2, 2] or [-5, 5] mm (human rotation), legalized (vias
should fall back toward the human value, parts should move back toward the human pose). Every row
is evaluated with evaluateRobust (5 grid phases, native exact router). Channel deficit = sum over
facing pad pairs (different parts and nets, shared layer, overlapping in the other axis) of
max(0, 0.8 mm - gap): a 0.4-0.8 mm gap passes 0 or 1 track on the 0.4 mm routing grid depending on
the grid phase (below). `experiments/attract-table.mjs` prints the tables.

k60 (human legal: 318 clean, 346 vias, 5817 mm):

| Search objective | Human legal start: vias after search (count, seeds 1/2/3) | Human +-2 mm start (vias 388 / 404 / 373): vias after | Human +-5 mm start (vias 516 / 546 / 505): vias after | Small-part drift from human after search, median (mm): human / +-2 / +-5 start, seed 1 | Router objectives, human start, seed 1: objective on its search phases, start -> end, vs the same quantity on the 5 evaluation phases (count) |
|---|---|---|---|---|---|
| HPWL | 348 / 350 / 350 | 365 / 356 / 366 | 406 / 421 / 400 | 0.39 / 1.66 / 3.31 | - |
| HPWL + 5 mm per net crossing | 346 / 335 / 342 | 368 / 355 / 376 | 439 / 422 / 423 | 0.46 / 1.85 / 3.43 | - |
| round-1 overflow (2 search phases) | 346 / 345 / 314 | 388 / 404 / 360 | 516 / 509 / 493 | 0.08 / 1.64 / 3.94 | 496.5 -> 390 vs 497 -> 446 |
| vias (3 search phases) | 343 / 339 / 342 | 385 / 396 / 378 | 527 / 538 / 497 | 0.07 / 1.57 / 3.96 | 345 -> 319.3 vs 346 -> 343 |
| HPWL + 2 x channel deficit | 343 / 342 / 322 | 314 / 339 / 363 | 405 / 394 / 386 | 0.49 / 1.69 / 2.96 | - |
| HPWL + 5 x channel deficit | 339 / 327 / 336 | 336 / 346 / 372 | 427 / 416 / 400 | 0.48 / 1.67 / 3.18 | - |
| HPWL + 10 x channel deficit | 333 / 338 / 331 | 345 / 343 / 369 | 429 / 411 / 396 | 0.48 / 1.78 / 3.24 | - |
| HPWL + 2 x channel deficit, + relocate | - | - | 402 / 431 / 383 | - / - / 3.46 | - |
| HPWL + 2 x channel deficit, annealed, + relocate | - | - | 419 / 420 / 424 | - / - / 4.54 | - |

pic (human legal: 310 clean, 354 vias) and acc (6 layers; human legal: 617 clean, 2672 vias):

| Board, search objective | Human legal start: vias after search (count, seeds 1/2/3) | Human +-2 mm start: vias before -> after (count) | Human +-5 mm start: vias before -> after (count) | Small-part drift from human after search, median (mm): human / +-2 / +-5 start, seed 1 |
|---|---|---|---|---|
| pic, HPWL | 332 / 335 / 335 | 395 / 377 / 385 -> 360 / 366 / 356 | 475 / 487 / 487 -> 387 / 401 / 394 | 0.71 / 1.83 / 3.66 |
| pic, HPWL + 2 x channel deficit | 344 / 352 / 333 | 395 / 377 / 385 -> 345 / 355 / 351 | 475 / 487 / 487 -> 373 / 391 / 394 | 1.08 / 1.87 / 3.73 |
| acc, HPWL | 2669 / 2660 / 2657 | 2726 / 2697 / 2702 -> 2694 / 2668 / 2652 | 2801 / 2782 / 2774 -> 2677 / 2703 / 2677 | 0.90 / 1.90 / 3.64 |
| acc, HPWL + 2 x channel deficit | 2645 / 2650 / 2664 | 2726 / 2697 / 2702 -> 2676 / 2646 / 2629 | 2801 / 2782 / 2774 -> 2701 / 2720 / 2618 | 1.40 / 2.13 / 3.80 |

Findings:
- Every objective passes test A: small discrete moves do not damage the human layout (even HPWL
  alone, which Cypress's continuous pass does: +17 vias, from-human.mjs).
- No objective pulls parts back to the human pose (the median drift never falls at +-2 mm and
  falls only 4 -> 3-3.5 mm at +-5 mm): the human layout is one of many equally good optima, not an
  attractor. Judged by vias, HPWL + 2 x channel deficit is the best: from +-2 mm it returns to the
  human level on all three boards (k60 314-363 vs 346, pic 345-355 vs 354, acc 2629-2676 vs 2672).
- The router objectives fail test B. They are grid-exploitable: on the search phases round-1
  overflow falls 497 -> 390 and vias 345 -> 319, on the evaluation phases 497 -> 446 and 346 ->
  343; from +-2 mm they barely move vias. Round-1 overflow ranks layouts best (Pearson 0.97 with
  vias over 34 k60 layouts, HPWL 0.77, RUDY overflow 0.88) but is not causal under local search.
- Removing the grid exploit does not rescue the router objective. `--crn`: every try draws 4 fresh
  random grid phases and routes the old and the new layout on the same phases (common random
  numbers), kept when the mean round-1 overflow is lower (900 s, ~3400 tries): from +-2 mm the
  overflow on the evaluation phases really falls (629 / 600 / 559 -> 607 / 560 / 502) but vias
  rise (388 / 404 / 373 -> 423 / 420 / 419); from the annealed tool layouts both get worse (vias 419 /
  406 / 422 -> 482 / 507 / 527, HPWL +500-650 mm): ~40 % of tries pass on noise and the layout
  random-walks. Round-1 overflow is a symptom that ranks layouts, not a lever for local moves.
- RUDY (bbox wire density in 1 mm bins) is not the missing term either: annealed tool layouts
  have less RUDY overflow than the human layout (cap 1 mm/mm2: 1323-1413 vs 1516) and 60-120 more vias.
- Annealing and the relocate move (jump next to the partners' mean) lower HPWL further but, from
  +-5 mm, move parts away from the human pose (4.5 mm) without fewer vias (419-424 vs greedy
  383-431): beyond ~2 mm the objective no longer ranks the human layout first.
- Adding net crossings to the channel objective (HPWL + 2 x channel deficit + 1 or 3 mm per
  crossing of spanning-tree segments) does not help: +-2 mm start 351 / 341 / 351 and 354 / 345 /
  360 vias, +-5 mm 421 / 396 / 399 and 420 / 395 / 384 (without: 314 / 339 / 363, 405 / 394 / 386),
  although crossings fall 1168 -> 683.
- Where the human layout spends its extra wire (k60, human legal 5817 mm vs annealed tool layout
  5071 mm, 346 vs 407 vias): IC + small-part nets with 3+ parts 1216 vs 877 mm (42 nets), with 2
  parts 890 vs 711 mm (65 nets); IC-IC and fixed-part nets are equal. Human small parts sit farther
  from their IC pins than the HPWL optimum, but a forced 1 mm ring around the ICs did not help
  (ic-ring.mjs, 2026-10-09), so it is not plain distance from the IC.
- Human rotations are not the missing information at tool level: tool layouts with every small
  part's rotation set to the human one, then the same search: 434 / 459 / 442 vias (without: 446 /
  440 / 435); the search turns 130 of 396 parts away from the human rotation.

### Why the router is so sensitive to the grid phase (k60)

Pads take every 0.4 mm cell they overlap, so a pad's blocked width is its width plus 0-0.4 mm
depending on the phase, and a gap between two pads passes a track only if a whole cell fits in
it: 0.4-0.8 mm gaps pass 0 or 1 track, 0.8-1.2 mm gaps 1 or 2. Facing pad pairs (different parts
and nets, shared layer) by gap:

| Layout | Gap 0.4-0.8 mm: 0 or 1 track by phase (pairs) | Gap 0.8-1.2 mm: 1 or 2 tracks (pairs) | Small parts: gap to nearest body, median / p90 (mm) | Small parts within 0.2 mm of a neighbour (share) |
|---|---|---|---|---|
| Human, legalized | 161 | 324 | 0.23 / 0.67 | 0.37 |
| Tool (human IC poses + start layout + Cypress + legalizer), seed 1 | 598 | 77 | 0.11 / 0.14 | 0.95 |
| Tool seed 1 + HPWL local search | 533 | 96 | - | - |

The tool packs small parts at the legalizer's 0.1 mm and sits on the grid's resolution limit;
the human layout leaves channels. A finer grid (0.2 mm cells, tracks and vias 2 x 2 cells,
JS router `footprint: 2`) at 8 phases (offsets 0.025-0.375 mm):

| Layout | 0.4 mm grid: vias, median (min-max) (count) | 0.4 mm grid: vias SD over phases (count) | 0.2 mm grid: vias, median (min-max) (count) | 0.2 mm grid: vias SD (count) | 0.2 mm grid: time per routing (s) |
|---|---|---|---|---|---|
| Human, legalized | 340 (325-357) | 10.0 | 330 (322-337) | 4.2 | 19 |
| Tool seed 1 | 506 (486-537) | 18.6 | 457 (438-483) | 16.3 | 44 |
| Tool seed 2 | 495 (468-516) | 15.4 | 456 (418-498) | 24.9 | 40 |
| Tool seed 1 + annealed detail pass | 438 (407-446) | 15.8 | 402 (368-430) | 19.3 | 19 |

The finer grid halves the noise of the human layout only; congested layouts stay as noisy
(negotiation in congestion, not quantization) and the ranking is unchanged, at 7-20x the time.
Net order is not the issue (it is a priority). So the evaluation stays at 0.4 mm with phase
medians, and the optimizer must not use the router as its objective.

### Detail pass in the tool (lib/detail.mjs)

After the legalizer: the same search, objective HPWL + 2 x channel deficit, simulated annealing
(T 3 -> 0.003 mm over the time budget) and a relocate move (15 % of tries); 30 s per place call
(`PCB_DETAIL=0` off). `experiments/detail-check.mjs` on tool layouts (human IC poses + start
layout + Cypress + legalizer, seeds 1/2/3) and on the v10 agent final layouts:

| Board, layouts | Before: clean nets (count, 1/2/3) | Before: vias (count) | After 30 s detail pass: clean nets (count) | After: vias (count) | After: HPWL (mm) | Human legal: clean / vias (count) |
|---|---|---|---|---|---|---|
| k60, tool | 315 / 313 / 311 | 504 / 509 / 547 | 318 / 318 / 318 | 421 / 407 / 441 | 5090 / 5090 / 5020 | 318 / 346 |
| k60, v10 dsh finals | 314 / 312 / 311 | 558 / 586 / 558 | 318 / 312 / 315 | 480 / 488 / 475 | 5382 / 5008 / 5119 | 318 / 346 |
| pic, tool | 310 / 308 / 308 | 492 / 480 / 497 | 310 / 310 / 310 | 422 / 405 / 418 | 4770 / 4700 / 4719 | 310 / 354 |
| acc, tool | 617 / 617 / 617 | 2853 / 2867 / 2840 | 617 / 617 / 617 | 2817 / 2808 / 2808 | 16540 / 16430 / 16562 | 617 / 2672 |

k60 budget 10 / 30 / 60 s: 406-444 / 407-441 / 415-437 vias (saturated at 10-30 s); greedy only
(30000 tries): 446 / 440 / 435. acc is budget-limited (90 s: 2779) but its gap to human is small.
A 4 mm bucket grid for the neighbour queries made the pass 3-4x faster (k60 ~13k tries/s, acc
~5.5k/s) without changing k60 (mean 423 vias). Settings on the three k60 tool layouts (30 s, mean
vias over 3-6 runs): nu 1 / 2 / 4 -> 426 / 423 / 430; channel threshold 0.8 / 1.0 / 1.2 mm -> 423 /
429 / 424; T0 1 / 3 / 6 -> 428 / 423 / 432; relocate 0 / 0.15 -> 413 / 423; nu 4 + 1.0 mm -> 413. All
within the run-to-run spread (about +-20 vias on one layout); defaults kept. The pass is saturated:
what is left is the objective beyond ~2 mm (see the +-5 mm rows), not the search.
The pass also removes clearance warnings (k60 tool: 48 -> 3 pairs below 0.1 mm).

Cypress before the pass no longer matters: start layout (human IC poses) + legalizer + 30 s pass,
no Cypress (tree/*-ics-noglobal): k60 316 / 318 / 318 clean, 425 / 410 / 423 vias; pic 310 / 310 / 308,
411 / 416 / 383; acc 617, 2818 / 2817 / 2768 (with Cypress: 421 / 407 / 441, 422 / 405 / 418, 2817 /
2808 / 2808). Dropping Cypress would save 15-70 s per place call, but Cypress is the project's only
placer by design, so it stays (open decision).

The crossing pass (uncross.mjs, lambda 0.2) is not additive: after the annealed detail pass it
lowers crossings 927 / 933 / 904 -> ~786 but vias go 417 / 407 / 423 -> 443 / 409 / 460 (clean 318 /
318 / 316). The detail pass alone beats uncross alone (464 / 473 / 480 on the same tool layouts);
use one of them, not both in sequence.

Regression on the 13 non-ppc boards (webgpu-vs-cypress tool layouts: start layout + Cypress, no
human information, seeds 1000 / 8919 / 16838; 30 s, native exact, 5 phases):

| Board | Before: clean nets (count, seeds 1000 / 8919 / 16838) | After 30 s detail pass: clean nets (count) | Before: vias (count) | After: vias (count) | Before: HPWL (mm) | After: HPWL (mm) |
|---|---|---|---|---|---|---|
| acc | 617 / 617 / 617 | 617 / 617 / 617 | 3315 / 3200 / 3344 | 3071 / 3012 / 3199 | 19715 / 18984 / 19501 | 18926 / 18393 / 18858 |
| edk | 124 / 124 / 124 | 124 / 124 / 124 | 108 / 110 / 114 | 101 / 111 / 113 | 3047 / 2860 / 2843 | 2956 / 2840 / 2829 |
| edu-fpga | 108 / 108 / 103 | 108 / 108 / 108 | 250 / 96 / 292 | 167 / 88 / 219 | 2970 / 1725 / 3011 | 2454 / 1578 / 2658 |
| edu-k60 | 150 / 151 / 150 | 157 / 157 / 157 | 457 / 420 / 392 | 224 / 242 / 231 | 5760 / 5806 / 5622 | 4908 / 4973 / 4869 |
| edu-nxp | 163 / 163 / 163 | 163 / 163 / 163 | 341 / 332 / 350 | 210 / 227 / 212 | 5529 / 5606 / 5530 | 4748 / 4764 / 4695 |
| fsl-mini | 162 / 162 / 162 | 162 / 162 / 162 | 295 / 318 / 336 | 268 / 271 / 290 | 6006 / 6004 / 6282 | 5668 / 5598 / 5867 |
| k60 | 305 / 297 / 302 | 318 / 316 / 314 | 672 / 668 / 676 | 513 / 511 / 546 | 6450 / 6495 / 6502 | 5375 / 5466 / 5548 |
| nxp | 370 / 370 / 370 | 370 / 370 / 370 | 799 / 771 / 775 | 730 / 716 / 702 | 8642 / 8645 / 8697 | 7569 / 7731 / 7725 |
| pic | 221 / 213 / 219 | 253 / 259 / 276 | 886 / 915 / 900 | 637 / 615 / 573 | 6011 / 5998 / 6004 | 5008 / 4914 / 4740 |
| pico | 86 / 86 / 86 | 86 / 86 / 86 | 73 / 80 / 74 | 59 / 58 / 67 | 947 / 991 / 974 | 848 / 867 / 876 |
| rx | 400 / 400 / 400 | 400 / 400 / 400 | 798 / 803 / 801 | 723 / 755 / 748 | 8793 / 8893 / 8784 | 7576 / 7560 / 7465 |
| safety | 186 / 186 / 186 | 186 / 186 / 186 | 386 / 365 / 387 | 304 / 288 / 302 | 5320 / 5216 / 5268 | 4628 / 4597 / 4546 |
| z3r0 | 46 / 46 / 46 | 46 / 46 / 46 | 24 / 30 / 24 | 23 / 25 / 24 | 656 / 674 / 660 | 649 / 646 / 650 |

Clean nets never fall (sum 8789 -> 8993; pic +32 to +57, k60 +13 to +19, edu-k60 +6 / +7, edu-fpga
+5 once); vias x0.802, HPWL x0.891 (geometric means over 39 layouts); the only via increase is edk
seed 16838 110 -> 111. ppc-n3 (10 layers, ~2000 parts; the tool gives it ~20 s), v9s agent finals,
20 s, ~110-190k tries: clean 1607 / 1607 / 1607 unchanged, vias 9643 / 9656 / 9430 -> 9587 / 9536 /
9380 (-0.5 to -1.2 %), HPWL -4 to -6 % (human 8729 vias): on many layers small-part placement is not
where the vias are.

### Agents with the detail pass (prompt v11, dsh deepseek-flash, 20 min, 12 place calls, 3 sessions)

Prompt v11 = v10 + one paragraph on the detail pass. Control: the same prompt with `PCB_DETAIL=0`.
Final layouts scored by the runner (5 grid phases, native exact).

| Board, configuration | Clean nets (count, sessions 1/2/3) | Vias (count) | HPWL (mm) | Phases converged (count of 5) | Minutes used (of 20) | Place calls used (of 12) |
|---|---|---|---|---|---|---|
| k60, v10 (before, 2026-10-10) | 318 / 314 / 310 | 563 / 571 / 570 | 6403 / 5691 / 5626 | 3 / 1 / 0 | 13.5 / 12.9 / 13.2 | 12 / 12 / 12 |
| k60, v11, detail pass off | 316 / 279 / 297 | 524 / 735 / 709 | 5732 / 6170 / 5988 | 2 / 0 / 0 | 12.5 / 13.3 / 12.4 | 12 / 11 / 12 |
| k60, v11, detail pass on | 312 / 318 / 318 | 539 / 464 / 471 | 5187 / 5001 / 5062 | 0 / 3 / 3 | 18.0 / 17.8 / 18.8 | 7 / 8 / 8 |
| pic, v11, detail pass off | 310 / 310 / 310 | 491 / 510 / 507 | 5275 / 5544 / 5611 | 5 / 5 / 4 | 11.2 / 11.2 / 10.9 | 12 / 12 / 12 |
| pic, v11, detail pass on | 310 / 310 / 310 | 386 / 378 / 400 | 4527 / 4594 / 4400 | 5 / 5 / 3 | 17.9 / 17.9 / 18.0 | 12 / 12 / 12 |

Human: k60 legal 318 / 346 vias (runner target 310), pic legal 310 / 354 (runner target 342).
With the pass, two of three k60 sessions route all nets with 464-471 vias, the best agent layouts
so far (previous best 318 / 540, Codex). The longest place call took 104-111 s on k60 (control
58-62 s, both while other experiments ran; v10 22-26 s) and 72-74 s on pic, all under 3 min; k60
sessions used 7-8 calls in 18 of 20 minutes, pic sessions all 12. On pic every session routes all
nets in both arms and the pass cuts vias 503 -> 388 (means, -23 %), 10-17 % above the runner's human
target (342) and 7-13 % above the human legal layout (354).


## v12 sweep over 14 boards without Cypress (2026-10-11): agent vs no agent vs human

Cypress removed from `place` (user decision after the detail-pass results above): every candidate is
start layout -> 0.1 mm legalizer -> detail pass (lib/detail.mjs, 30 s; 60 s on ppc-n3) -> router.
`knobs` / `netWeights` and the `knobs` command are gone; prompt v12 = v11 without Cypress. 3 dsh
sessions per board, 20 min, 12 place calls, 3 boards at a time (harness/results/sweep-v12.sh,
v12s-<board>). No agent = start layout (empty plan) + legalizer + detail pass, seeds 1000 / 8919 /
16838 (`experiments/noagent.mjs`). Scoring as for v9 (`experiments/sweep-eval.mjs --dir sweep-eval-v12
--agent v12s`): exact native router at 8 independent grid offsets, median per layout; ppc-n3 tool
routing at 3 phases; human rows reused from the v9 scoring. Place calls took 31 s (pico) to 78 s
(ppc-n3).

| Board | Human: clean nets / vias (count) | No agent, v9 (start + Cypress): clean nets / vias, mean of 3 seeds (count) | No agent, v12 (start + detail pass): clean nets / vias, mean (count) | Agent v9: clean nets / vias, mean of 3 sessions (count) | Agent v12: clean nets / vias, mean of 3 sessions (count) | Agent v9: vias / human (x) | Agent v12: vias / human (x) |
|---|---|---|---|---|---|---|---|
| z3r0 | 46 / 32 | 46.0 / 22 | 46.0 / 27 | 46.0 / 21 | 46.0 / 23 | 0.65 | 0.72 |
| pico | 86 / 57 | 86.0 / 75 | 86.0 / 60 | 86.0 / 59 | 86.0 / 54 | 1.04 | 0.95 |
| edk | 124 / 66 | 124.0 / 107 | 124.0 / 101 | 124.0 / 81 | 124.0 / 79 | 1.22 | 1.19 |
| edu-fpga | 108 / 77 | 103.0 / 216 | 108.0 / 180 | 108.0 / 95 | 108.0 / 80 | 1.23 | 1.03 |
| fsl-mini | 162 / 191 | 162.0 / 312 | 162.0 / 266 | 162.0 / 285 | 162.0 / 240 | 1.49 | 1.26 |
| edu-k60 | 157 / 188 | 153.7 / 401 | 157.0 / 245 | 157.0 / 279 | 157.0 / 185 | 1.48 | 0.99 |
| edu-nxp | 163 / 203 | 163.0 / 339 | 163.0 / 215 | 163.0 / 251 | 163.0 / 195 | 1.24 | 0.96 |
| safety | 186 / 227 | 186.0 / 386 | 186.0 / 286 | 186.0 / 324 | 186.0 / 251 | 1.43 | 1.10 |
| pic | 310 / 347 | 267.7 / 715 | 293.7 / 525 | 308.7 / 480 | 309.0 / 452 | 1.38 | 1.30 |
| nxp | 369 / 587 | 370.0 / 780 | 370.0 / 713 | 370.0 / 758 | 370.0 / 689 | 1.29 | 1.17 |
| rx | 399 / 625 | 400.0 / 804 | 400.0 / 758 | 400.0 / 813 | 400.0 / 732 | 1.30 | 1.17 |
| k60 | 318 / 301 | 310.3 / 602 | 318.0 / 471 | 313.7 / 546 | 315.3 / 447 | 1.81 | 1.49 |
| acc | 617 / 2576 | 617.0 / 3175 | 617.0 / 3096 | 617.0 / 2833 | 617.0 / 2737 | 1.10 | 1.06 |
| ppc-n3 | 1607 / 8768 | - | 1607.0 / 9997 | 1607.0 / 9608 | 1607.0 / 9407 | 1.10 | 1.07 |

Full v12 table: `node harness/experiments/sweep-eval.mjs --dir sweep-eval-v12 --agent v12s --name v12
--tool-label "start + detail" --summary` (per-session values and converged counts).

Agent vias / human, geometric mean over 14 boards: v9 1.239 -> v12 1.090; no agent over 13 boards:
1.570 -> 1.306. Agent clean nets equal or higher than v9 on every board (pic: one session 307 / 624 vias from a
weak floorplan, the other two 310 / 378 and 310 / 354). Agent vias lower than v9 on
13 of 14 boards (z3r0 21 -> 23, within noise); at or below the human count on z3r0, pico, edu-k60,
edu-nxp; biggest drops edu-k60 279 -> 185, safety 324 -> 251, k60 546 -> 447, edu-nxp 251 -> 195. Sessions
converged at every grid phase: 35 of 42 (pico 0, k60 0, pic 2 of 3). No agent now routes every net on 13 of 14
boards (k60 318 in all seeds; pic 293.7). fsl-mini: every agent layout keeps one overlap, U601 under
the fixed shield can SH701 as in the human layout (also in all v9 sessions), so the runner marks them
not legal.


## New metrics against the human layout: decoupling capacitors and critical nets (2026-10-11)

`lib/human-metrics.mjs`, `experiments/human-metrics.mjs` (rows in results/human-metrics-v12.jsonl):
the v12 sweep layouts (human = the KiCad layout as is; no agent = start + legalizer + detail pass,
3 seeds; agent = v12 submitted layouts, 3 sessions; values are means over the 3). Routed lengths
and vias from evaluateRobust (native exact, 5 phases; ppc-n3 tool routing, 3 phases), perNet of the
median-via phase.

Decoupling capacitor = ref C*, 2 pads, one on a ground net, the other on a supply (power-class net,
or a routed net that looks like one: +..., VDD, VCC, xVy, or > 30 parts); distance = its supply pad
to the nearest pad of an IC (>= 8 pads) on the same supply. Critical nets: crystal = nets on Y* / X*
parts with <= 4 pads; clock = CLK / OSC / XTAL in the name; reset = RST / RESET; differential pairs =
names that differ only in _P/_N, P/N, +/-, DP/DM.

| Board | Decoupling capacitors with an IC on their supply (count) | Distance to the nearest IC supply pin, median: human / no agent / agent (mm) | p90: human / no agent / agent (mm) | Within 3 mm: human / no agent / agent (share) | Same IC as human: no agent / agent (share) |
|---|---|---|---|---|---|
| z3r0 | 7 | 4.9 / 6.9 / 6.4 | 7.7 / 10.9 / 10.9 | 0.43 / 0.05 / 0.00 | 0.52 / 0.43 |
| pico | 9 | 1.6 / 6.7 / 8.2 | 8.5 / 22.8 / 17.9 | 0.78 / 0.18 / 0.11 | 0.48 / 0.59 |
| edk | 18 | 3.4 / 11.9 / 17.7 | 28.2 / 28.5 / 31.2 | 0.22 / 0.06 / 0.04 | 0.22 / 0.24 |
| edu-fpga | 45 | 5.8 / 12.5 / 14.2 | 14.7 / 29.9 / 32.3 | 0.09 / 0.03 / 0.03 | 0.42 / 0.43 |
| fsl-mini | 29 | 5.3 / 13.0 / 14.5 | 14.2 / 35.0 / 34.5 | 0.10 / 0.03 / 0.07 | 0.24 / 0.33 |
| edu-k60 | 32 | 5.7 / 16.2 / 18.7 | 16.9 / 36.7 / 47.9 | 0.28 / 0.00 / 0.01 | 0.49 / 0.54 |
| edu-nxp | 31 | 6.2 / 16.7 / 12.6 | 14.9 / 31.0 / 32.2 | 0.32 / 0.01 / 0.02 | 0.32 / 0.45 |
| safety | 62 | 5.1 / 20.0 / 16.8 | 10.1 / 35.7 / 37.3 | 0.08 / 0.02 / 0.03 | 0.62 / 0.53 |
| pic | 56 | 6.0 / 8.6 / 8.6 | 15.7 / 28.3 / 25.7 | 0.20 / 0.10 / 0.07 | 0.18 / 0.26 |
| nxp | 55 | 4.0 / 9.7 / 7.7 | 14.3 / 30.4 / 27.6 | 0.40 / 0.08 / 0.11 | 0.24 / 0.25 |
| rx | 47 | 3.0 / 7.2 / 7.2 | 9.6 / 19.8 / 20.5 | 0.49 / 0.08 / 0.12 | 0.31 / 0.19 |
| k60 | 55 | 3.3 / 15.3 / 13.0 | 24.9 / 32.8 / 34.3 | 0.45 / 0.00 / 0.04 | 0.29 / 0.26 |
| acc | 235 | 0.9 / 10.6 / 7.4 | 5.3 / 42.4 / 20.2 | 0.85 / 0.15 / 0.21 | 0.39 / 0.46 |
| ppc-n3 | 553 | 2.7 / 15.1 / 10.6 | 16.2 / 66.1 / 27.7 | 0.52 / 0.07 / 0.10 | 0.64 / 0.66 |

| Board | Crystal nets (count) | Crystal nets, routed length: human / no agent / agent (mm) | Clock nets (count) | Clock nets, routed length: human / no agent / agent (mm) | Reset nets (count) | Reset nets, routed length: human / no agent / agent (mm) | Differential pairs (count) | Pairs, routed length: human / no agent / agent (mm) | Pairs, length mismatch median: human / no agent / agent (mm) | Vias on all these nets: human / no agent / agent (count) |
|---|---|---|---|---|---|---|---|---|---|---|
| z3r0 | 0 | 0 / 0 / 0 | 1 | 24 / 21 / 23 | 1 | 43 / 45 / 44 | 2 | 36 / 18 / 19 | 2.0 / 2.5 / 3.3 | 5 / 7 / 6 |
| pico | 4 | 17 / 17 / 21 | 2 | 42 / 28 / 38 | 2 | 46 / 31 / 26 | 1 | 30 / 30 / 24 | 0.4 / 3.9 / 3.2 | 16 / 15 / 11 |
| edk | 0 | 0 / 0 / 0 | 11 | 265 / 286 / 267 | 2 | 93 / 69 / 69 | 1 | 88 / 81 / 83 | 1.2 / 3.6 / 2.8 | 10 / 15 / 13 |
| edu-fpga | 1 | 22 / 22 / 36 | 1 | 11 / 13 / 13 | 1 | 3 / 17 / 11 | 1 | 47 / 66 / 53 | 1.2 / 1.2 / 1.9 | 4 / 4 / 7 |
| fsl-mini | 2 | 25 / 39 / 46 | 4 | 91 / 124 / 109 | 2 | 104 / 121 / 123 | 7 | 434 / 429 / 416 | 1.6 / 2.4 / 3.3 | 25 / 34 / 33 |
| edu-k60 | 6 | 89 / 110 / 34 | 3 | 109 / 113 / 97 | 2 | 67 / 64 / 84 | 2 | 238 / 225 / 232 | 1.2 / 1.6 / 2.5 | 21 / 30 / 21 |
| edu-nxp | 6 | 89 / 95 / 122 | 2 | 54 / 49 / 31 | 6 | 182 / 119 / 133 | 2 | 213 / 195 / 225 | 3.6 / 2.8 / 2.1 | 28 / 37 / 23 |
| safety | 6 | 46 / 98 / 51 | 4 | 166 / 123 / 135 | 7 | 285 / 225 / 243 | 2 | 133 / 70 / 63 | 13.2 / 12.7 / 16.0 | 26 / 41 / 32 |
| pic | 2 | 12 / 14 / 25 | 6 | 114 / 78 / 59 | 5 | 142 / 169 / 86 | 5 | 264 / 202 / 252 | 3.2 / 1.9 / 1.7 | 29 / 43 / 41 |
| nxp | 6 | 46 / 122 / 112 | 5 | 155 / 128 / 138 | 6 | 78 / 149 / 119 | 3 | 198 / 223 / 251 | 1.2 / 1.3 / 1.3 | 40 / 61 / 54 |
| rx | 6 | 37 / 115 / 113 | 4 | 89 / 82 / 58 | 4 | 50 / 93 / 113 | 3 | 201 / 272 / 280 | 0.8 / 1.9 / 0.7 | 33 / 49 / 40 |
| k60 | 2 | 12 / 5 / 14 | 6 | 90 / 70 / 52 | 3 | 35 / 48 / 49 | 2 | 171 / 206 / 192 | 7.2 / 4.5 / 3.6 | 13 / 27 / 25 |
| acc | 4 | 6 / 7 / 8 | 26 | 1006 / 1070 / 1071 | 5 | 227 / 160 / 157 | 133 | 9229 / 11472 / 8711 | 1.2 / 1.6 / 1.5 | 1403 / 1563 / 1411 |
| ppc-n3 | 14 | 116 / 206 / 134 | 85 | 4383 / 2920 / 3035 | 23 | 2226 / 1350 / 1220 | 56 | 5524 / 3819 / 3369 | 1.2 / 3.5 / 2.9 | 1311 / 1428 / 1379 |

Decoupling is the clearest gap and nothing in the tool optimizes it: on every board the human puts
decaps closer to the IC supply pins (median 0.9-6.2 mm vs 6.4-20 mm, 1.3-12x; within 3 mm: k60 0.45 vs
0.00-0.04, acc 0.85 vs 0.15-0.21, ppc-n3 0.52 vs 0.07-0.10), and the tool assigns only 18-66 % of
them to the IC the human chose. The supply is routed only on boards where it is a signal-class net
(k60 +3.3V), so the router's clean / vias barely see it. Critical nets are mixed: the tool's clock,
reset and pair lengths are often shorter than the human's (the human routes them deliberately, the
tool packs), but crystal nets are 2.5-3x longer on nxp / rx (112-122 vs 37-46 mm) and the critical
nets carry more vias than in the human layout on 12 of 14 boards for no agent (agent: 11 of 14). Pair mismatch is within a
few mm everywhere (the router does not match lengths).
