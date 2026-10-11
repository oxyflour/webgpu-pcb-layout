// Board IR types (docs/board-ir.md). Units: mm, degrees (counter-clockwise seen from the top).

export type Point = [number, number];
export type Side = 'top' | 'bottom';
export type Extensions = Record<string, unknown>;

export type Shape =
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'circle'; center: Point; radius: number }
  | { type: 'polygon'; points: Point[]; holes?: Point[][] };

export interface BoardIR {
  format: 'webgpu-pin-layout/board@1';
  /** Direction of +y in every coordinate of the file. Default "down". */
  yAxis?: 'down' | 'up';
  name?: string;
  source?: Record<string, unknown>;
  board: Board;
  nets: Net[];
  footprints: Footprint[];
  regions?: Region[];
  keepouts?: Keepout[];
  modules?: Module[];
  rules?: Rules;
  extensions?: Extensions;
}

export interface Board {
  /** One or more board pieces; arcs must be flattened to polylines. */
  outline: Array<{ outer: Point[]; /** reserved: not used by the engine yet */ holes?: Point[][] }>;
  thickness?: number;
  /** Sides that may carry footprints. Default ["top", "bottom"]. */
  sides?: Side[];
  /** Top to bottom. Informational for now. */
  copperLayers?: Array<{ name: string; side?: Side; type?: 'signal' | 'plane' | 'mixed'; net?: string }>;
  extensions?: Extensions;
}

export interface Net {
  name: string;
  /** signal: HPWL, congestion, modules, routing. power/ground: plane nets (decoupling pull only). */
  class?: 'signal' | 'power' | 'ground';
  /** 0..100, default 50. Net weight = 0.2 + priority / 55. */
  priority?: number;
  ignore?: boolean;
  extensions?: Extensions;
}

export interface Pad {
  id: string;
  /** Pad centre in footprint-local coordinates, top view, footprint at rotation 0. */
  at: Point;
  shape?: 'rect' | 'roundrect' | 'oval' | 'circle' | 'polygon';
  /** Width/height before `rotation`; the engine uses the rotated bounding box. */
  size: [number, number];
  /** polygon pads: points relative to the pad centre. */
  points?: Point[];
  cornerRadius?: number;
  /** Relative to the footprint. */
  rotation?: number;
  /** smd: footprint side only; through: both copper layers (footprint occupies both sides); npth: mechanical hole. */
  type?: 'smd' | 'through' | 'npth';
  drill?: number;
  net?: string | null;
  extensions?: Extensions;
}

export interface Placement {
  /** Board position of the footprint anchor (local origin). */
  x: number;
  y: number;
  rotation?: number;
  side?: Side;
}

export interface Footprint {
  id: string;
  value?: string;
  library?: string;
  pads?: Pad[];
  /** Local coordinates; default: pad bounding box + 0.25 mm. */
  courtyard?: Shape;
  /** reserved */
  height?: number;
  /** Current or initial placement; required when fixed. */
  placement?: Placement;
  fixed?: boolean;
  /** Default [placement.side ?? "top"]. */
  allowedSides?: Side[];
  /** Multiples of 90 only; a single angle disables rotation. Default all four. */
  allowedRotations?: number[];
  /** Enclosure-driven part (connector, mounting hole); inferred when absent. */
  mechanical?: boolean;
  /** reserved: region id */
  region?: string | null;
  extensions?: Extensions;
}

export interface Region { id: string; shape: Shape; sides?: Side[]; extensions?: Extensions }

/** reserved: not used by the engine yet */
export interface Keepout {
  id?: string;
  shape: Shape;
  sides?: Side[];
  rules?: { placement?: boolean; routing?: boolean; vias?: boolean };
  maxHeight?: number | null;
  extensions?: Extensions;
}

export interface Module {
  id: string;
  name?: string;
  footprints: string[];
  side?: 'auto' | 'top' | 'bottom';
  /** Region id (rect regions): the module is pinned to its centre. */
  region?: string | null;
  cohesion?: number;
  extensions?: Extensions;
}

export interface Rules {
  componentClearance?: number;
  /** Cost of a bottom-side part in HPWL-mm per mm² of its area (0: sides equal; ~20: single-sided). */
  backsideCost?: number;
  /** reserved */ edgeClearance?: number;
  /** reserved */ track?: { width?: number; clearance?: number };
  /** reserved */ via?: { diameter?: number; drill?: number };
}

export interface PlacementResult {
  format: 'webgpu-pin-layout/placement@1';
  board: string | null;
  yAxis: 'down' | 'up';
  placements: Array<{ footprint: string; x: number; y: number; rotation: number; side: Side }>;
  modules?: Module[];
  metrics?: { hpwl_mm?: number; overlappingPairs?: number; cleanNets?: number; routedNetsTotal?: number; runtime_s?: number };
}

export function validateBoardIR(ir: unknown): { errors: string[]; warnings: string[] };
export function assertValidBoardIR(ir: unknown): string[];
