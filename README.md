# webgpu-pin-layout

Topology-first automatic layout for a 2D canvas containing **components**, ordered boundary **pins**, and multi-terminal **nets**. It uses a CPU planar-topology stage and real **WebGPU/WGSL compute kernels** for large-batch placement scoring and weighted grid routing.

The package is intended for PCB-like diagrams, hardware block canvases, schematic-like editors, panel routing, and other problems where components can move/rotate and different nets must not cross.

## What is implemented

This is not a mock WebGPU wrapper. The current implementation contains four GPU stages:

1. **Batch HPWL kernel** — one workgroup per candidate layout, 256 lanes reducing net HPWL.
2. **Batch overlap/bounds kernel** — component-pair overlap area and canvas violation, reduced on GPU.
3. **Batch coarse-congestion kernel** — a coarse rectilinear demand grid evaluated entirely in WGSL and included in placement optimization.
4. **Weighted wavefront router** — ping-pong WebGPU distance-field relaxation over a grid, used by a negotiated-congestion multi-net router.

On the CPU side it performs:

- pin-order-aware augmented graph construction;
- planarity testing / embedding through TopoLoom;
- embedding-derived placement seed;
- parallel-proposal LNS / simulated annealing controller;
- Pathfinder-style negotiated congestion, multi-terminal tree construction, clearance accounting, and route extraction.

## Feasibility semantics

`solveAutoLayout()` intentionally distinguishes three outcomes:

- `topologically-impossible`: the pin-order-aware augmented graph is non-planar. Do not waste time on geometric optimization.
- `routed`: a concrete grid placement/routing witness was found with zero inter-net conflict/clearance violations at the configured grid resolution.
- `geometrically-unresolved`: topology is planar, but the heuristic did not construct a legal geometric routing under the current grid, clearance, iteration and placement settings. **This is not a proof of impossibility.** Increase grid resolution / routing rounds / placement restarts or use an exact CP-SAT fallback for a final proof.

The topology stage ignores finite component sizes and fixed-coordinate geometry, so `planar === true` is a strong screen, not by itself a guarantee that a finite canvas can contain the drawing.

## Install

```bash
npm install
```

For a published copy this becomes:

```bash
npm install webgpu-pin-layout
```

Node uses Dawn through the optional `webgpu` package. Browsers use native `navigator.gpu`.

## Node example

```js
import { createNodeWebGpuDevice } from 'webgpu-pin-layout/node';
import { solveAutoLayout } from 'webgpu-pin-layout';

const device = await createNodeWebGpuDevice();

const problem = {
  canvas: { width: 120, height: 80 },
  components: [
    {
      id: 'A', width: 20, height: 16,
      pins: [
        { id: 'p1', x: 10, y: -4, side: 'right' },
        { id: 'p2', x: 10, y:  4, side: 'right' },
      ]
    },
    {
      id: 'B', width: 20, height: 16,
      pins: [
        { id: 'p1', x: -10, y: -4, side: 'left' },
        { id: 'p2', x: -10, y:  4, side: 'left' },
      ]
    },
    {
      id: 'C', width: 16, height: 12,
      pins: [{ id: 'p1', x: 0, y: -6, side: 'top' }]
    }
  ],
  nets: [
    {
      id: 'N1',
      pins: [
        { componentId: 'A', pinId: 'p1' },
        { componentId: 'B', pinId: 'p1' },
        { componentId: 'C', pinId: 'p1' },
      ]
    },
    {
      id: 'N2',
      pins: [
        { componentId: 'A', pinId: 'p2' },
        { componentId: 'B', pinId: 'p2' },
      ]
    }
  ]
};

const result = await solveAutoLayout(problem, device, {
  weights: {
    hpwl: 1,
    overlap: 1000,
    bounds: 1000,
    congestion: 2,
  },
  optimizer: {
    iterations: 60,
    population: 2048,
    movesPerCandidate: 3,
  },
  router: {
    gridWidth: 160,
    gridHeight: 112,
    wireClearanceCells: 1,
    maxRounds: 20,
  },
  restarts: 3,
});

console.log(result.status);
console.dir(result.routing?.routes, { depth: 6 });

device.destroy();
```

`examples/basic.mjs` is a runnable version.

## Browser example

```js
import {
  requestWebGpuDevice,
  normalizeProblem,
  GpuBatchScorer,
} from 'webgpu-pin-layout';

const device = await requestWebGpuDevice();
const p = normalizeProblem(problem);
const scorer = new GpuBatchScorer(device, p);

const scores = await scorer.scoreLayouts(candidateLayouts);
scorer.destroy();
```

No Node/Dawn import is used in the browser entry point.

## Problem model

Pin coordinates are local to the **component center**. Component rotation is a quarter-turn integer:

- `0`: 0°
- `1`: 90°
- `2`: 180°
- `3`: 270°

A component's `pins` array is also its declared cyclic boundary order for the topology gadget. For best topology results, list boundary pins in clockwise or counter-clockwise order.

```ts
interface LayoutProblem {
  canvas: { width: number; height: number };
  components: Array<{
    id: string;
    width: number;
    height: number;
    rotatable?: boolean;
    fixed?: { x: number; y: number; rotation: number };
    pins: Array<{
      id: string;
      x: number;
      y: number;
      side?: 'left' | 'right' | 'top' | 'bottom';
      normal?: [number, number];
    }>;
  }>;
  nets: Array<{
    id: string;
    pins: Array<{ componentId: string; pinId: string }>;
  }>;
}
```

One physical pin may belong to at most one net.

## Topology model

Each component is expanded to a wheel-like gadget:

```text
          p0 ----- p1
           \       /
            \ hub /
            /     \
          p3 ----- p2
```

The rim encodes the component's cyclic pin order. Every net becomes a separate graph vertex connected to its participating pin vertices. The expanded graph is sent to a planar test before geometric search.

For geometry, the component remains a finite rectangle and the router treats it as an obstacle. Therefore the final routing stage is still required even after a planar topology result.

## GPU placement score

For candidate layout `X`, the GPU objective is

```text
J(X) = w_h * HPWL
     + w_o * overlapArea
     + w_b * boundsPenalty
     + w_c * coarseCongestion
```

The congestion term is computed on a configurable coarse grid. Each net gets a deterministic rectilinear L-star demand approximation and each coarse cell receives

```text
(max(0, demand - capacity))^2
```

This is deliberately a **cheap placement surrogate**. Exact non-crossing routing happens only after the placement search has narrowed the space.

The scorer accepts up to 65,535 candidates per call; for larger populations, chunk them.

## Exact routing heuristic

The final router is a negotiated-congestion router rather than fixed-order A*:

1. Rasterize component rectangles as hard obstacles.
2. Carve only the current net's pin escape stubs through its owning components.
3. Build a weighted grid cost:

```text
cost(cell) = 1
           + presentFactor * currentUsage(cell)
           + historyFactor * history(cell)
```

4. WebGPU computes a multi-source weighted distance field.
5. A multi-pin net grows a tree by repeatedly connecting the cheapest remaining terminal to the current tree.
6. The net reserves both route cells and Manhattan-dilated clearance cells.
7. Shared guard cells become conflicts; conflicted cells accumulate history cost.
8. Nets are rerouted in subsequent rounds until conflict count reaches zero or `maxRounds` is hit.

This is analogous to Pathfinder-style negotiated routing: temporary conflicts are allowed during search, but **never** in a successful final result.

## Important router options

```js
{
  gridWidth: 160,
  gridHeight: 112,
  componentClearance: 0,
  wireClearanceCells: 1,
  escapeCells: 16,
  maxRounds: 20,
  presentFactor: 4,
  historyFactor: 8,
  maxWaveIterations: 8 * (gridWidth + gridHeight),
  seed: 1,
}
```

`maxWaveIterations` bounds GPU relaxation work. If you have long labyrinthine corridors, increase it; the worst-case exact Bellman-Ford bound is roughly `gridWidth * gridHeight - 1`.

## Tests

```bash
npm test
```

The suite contains:

- data validation and CPU reference scoring;
- augmented graph checks;
- planar and K3,3-subdivision topology cases;
- WebGPU-vs-CPU score comparison;
- a real WGSL wavefront test that must route through the only opening in an obstacle wall;
- a negotiated multi-net routing test requiring zero conflicts.

If the source tree is tested before dependencies/WebGPU are available, integration tests are explicitly marked `SKIP`. To require an actual GPU/Dawn backend and fail otherwise:

```bash
npm run test:gpu
```

## Benchmark

```bash
npm run bench
```

The included benchmark scores 4,096 candidate layouts containing 100 components using the GPU batch scorer.

## Architecture

```text
Problem
  |
  +--> pin-order augmented graph
  |       |
  |       +--> planarity / embedding (CPU)
  |                 |
  |                 +--> initial placement
  |
  +--> parallel LNS proposals (CPU controller)
          |
          +--> HPWL WGSL -------------------+
          +--> overlap/bounds WGSL ----------+--> GPU score --> select proposal
          +--> coarse congestion WGSL -------+
                                               |
                                               v
                                    negotiated router
                                               |
                                      weighted grid WGSL
                                               |
                                  conflict/history update
                                               |
                                        final routes
```

## Deliberate non-goals in v0.1

- Arbitrary-angle component rotation. Current geometry is 0/90/180/270° so rectangles remain axis-aligned.
- Multi-layer vias / overpasses. The current success criterion is a single 2D routing layer with no inter-net crossing.
- Exact proof that a planar topology cannot fit a finite canvas. Use a CP-SAT/MILP grid fallback if `geometrically-unresolved` must be converted into a formal infeasibility result.
- Turn-aware shortest paths. The final weighted field optimizes length/congestion; bend minimization can be added by expanding the routing state with arrival direction.

## Files worth reading first

- `src/gpu/batch-scorer.js` — WGSL placement kernels.
- `src/gpu/grid-router.js` — weighted wavefront compute shader.
- `src/router/negotiated-router.js` — multi-net Pathfinder-style controller.
- `src/topology/planarity.js` — pin-order-aware graph expansion.
- `src/optimizer/lns.js` — parallel-proposal LNS/SA.
- `src/solver.js` — end-to-end pipeline.

## Placement performance path (v0.2)

The random-start placement path now uses three tiers:

1. `MultiStartGlobalPlacer`: several cheap global starts, exact-score selection, then fine global refinement.
2. `FastDeltaLnsOptimizer`: typed-array candidate slabs + compiled approximate scoring; only the top-K candidates are sent to the exact scorer.
3. A short exact LNS polish to recover the last fraction of quality.

`GpuBatchScorer` also keeps dynamic GPU buffers persistent across calls. Candidate buffers and readback staging buffers are grown geometrically and reused; `scoreLayouts()` updates them with `queue.writeBuffer()` rather than allocating GPU buffers every iteration.

Run the CPU-reference benchmark with:

```bash
npm run bench:placement
```

Reference container (Node 22.16, 5 vCPU AMD EPYC 9V74), BGA random-placement case with 17 components / 52 nets / 160 pins, five warmed repetitions:

| Pipeline | Placement time | Objective | HPWL | Overlap |
| --- | ---: | ---: | ---: | ---: |
| v0.1 global + full exact LNS | 2799.7 ms | 1524.77 | 1091.67 | 8.9e-4 |
| v0.2 multi-start + fast LNS + exact polish | 236.2 ms | 1534.79 | 1067.99 | 0 |

That is an **11.85x CPU-reference placement speedup** at +0.66% total objective, while raw HPWL is 2.17% lower and overlap is exactly zero. Routing validation is intentionally timed separately because routing is not part of placement optimization.

The current CI/container does not expose a real WebGPU runtime, so no GPU wall-clock number is claimed for this reference result. Use `npm run test:gpu` on a WebGPU-capable machine to force the WGSL path; it fails rather than silently skipping when `WEBGPU_REQUIRED=1`.
