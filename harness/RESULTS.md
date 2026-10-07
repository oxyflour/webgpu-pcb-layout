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
