/// <reference types="@webgpu/types" />
export interface Pin { id:string; x:number; y:number; normal?:[number,number]; side?:'left'|'right'|'top'|'bottom' }
export interface Component { id:string; width:number; height:number; pins:Pin[]; rotatable?:boolean; fixed?:Placement }
export interface PinRef { componentId:string; pinId:string }
export interface Net { id:string; pins:PinRef[] }
export interface LayoutProblem { canvas:{width:number;height:number}; components:Component[]; nets:Net[] }
export interface Placement { x:number; y:number; rotation:number }
export interface Score { total:number; hpwl:number; overlap:number; bounds:number; congestion:number }
export interface RouteBranch { cells:number[]; polyline:[number,number][] }
export interface NetRoute { netId:string; ok:boolean; branches:RouteBranch[] }
export interface RoutingResult { status:'routed'|'unrouted'; grid:{width:number;height:number;cellW:number;cellH:number}; rounds:number; routes:NetRoute[]; conflicts:number; failedNets?:number }
export type NormalizedProblem = any;

export function normalizeProblem(problem:LayoutProblem):NormalizedProblem;
export function coarseCongestionCpu(problem:NormalizedProblem,layout:Placement[],options?:any):number;
export function scoreLayoutCpu(problem:NormalizedProblem,layout:Placement[],weights?:Partial<{hpwl:number;overlap:number;bounds:number;congestion:number}>,coarse?:any):Score;
export function requestWebGpuDevice(options?:any):Promise<GPUDevice>;
export function buildAugmentedGraph(problem:NormalizedProblem):any;
export function analyzeTopology(problem:NormalizedProblem):Promise<any>;
export function initialLayoutFromEmbedding(problem:NormalizedProblem,topology:any,margin?:number):Placement[];

export class GpuBatchScorer {
  constructor(device:GPUDevice,problem:NormalizedProblem,options?:any);
  scoreLayouts(layouts:Placement[][]):Promise<Score[]>;
  destroy():void;
}
export class GpuGridRouter {
  constructor(device:GPUDevice);
  distanceField(args:any):Promise<{distances:Float32Array;iterations:number;infCost:number}>;
  backtrack(args:any):number[]|null;
  shortestPath(args:any):Promise<any>;
}
export class GpuNegotiatedRouter {
  constructor(device:GPUDevice,problem:NormalizedProblem,options?:any);
  route(layout:Placement[]):Promise<RoutingResult>;
}
export class GpuLnsOptimizer {
  constructor(problem:NormalizedProblem,scorer:GpuBatchScorer,options?:any);
  optimize(initial:Placement[],onIteration?:(row:any)=>void|Promise<void>):Promise<{layout:Placement[];score:Score;trace:any[]}>;
}
export function solveAutoLayout(problem:LayoutProblem|NormalizedProblem,device:GPUDevice,options?:any):Promise<any>;

export class PriorityCpuBatchScorer {
  constructor(problem:NormalizedProblem,options?:any);
  scoreLayouts(layouts:Placement[][]):Promise<Score[]>;
  scoreLayout(layout:Placement[]):Score;
  destroy():void;
}
export class CompiledPlacementModel {
  constructor(problem:NormalizedProblem,options?:any);
  layoutToFlat(layout:Placement[]):{x:Float64Array;y:Float64Array;r:Uint8Array};
  flatToLayout(x:Float64Array,y:Float64Array,r:Uint8Array,offset?:number):Placement[];
  scoreFlat(x:Float64Array,y:Float64Array,r:Uint8Array,offset?:number):Score & {weightedHpwl:number};
}
export class FastDeltaLnsOptimizer {
  constructor(problem:NormalizedProblem,exactScorer:{scoreLayouts(layouts:Placement[][]):Promise<Score[]>},options?:any);
  optimize(initial:Placement[],onIteration?:(row:any)=>void|Promise<void>):Promise<{layout:Placement[];score:Score;trace:any[]}>;
}
export class MultiStartGlobalPlacer {
  constructor(problem:NormalizedProblem,exactScorer:{scoreLayouts(layouts:Placement[][]):Promise<Score[]>},options?:any);
  optimize(initial?:Placement[]|null):Promise<any>;
}
export class HighPerformancePlacementOptimizer {
  constructor(problem:NormalizedProblem,exactScorer:{scoreLayouts(layouts:Placement[][]):Promise<Score[]>},options?:any);
  optimize(initial:Placement[]):Promise<{layout:Placement[];score:Score;timing:{globalMs:number;fastLnsMs:number;polishMs:number;totalMs:number};global:any;fast:any;polish:any}>;
}
