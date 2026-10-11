# Test fixtures

`z3r0.ir.json`, `pico.ir.json`: the CIAA boards Z3R0 and pico (open hardware, ciaa-Hardware) as board IR
(core `kicadToIR` output + footprints[].sheet / nets[].netclass), written by
`node harness/experiments/export-ir.mjs --board <name> --out test/fixtures/<name>.ir.json`. The
placements are the human layouts. Used by test/harness.test.mjs, which needs no other checkout.
