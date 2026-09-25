export async function createNodeWebGpuDevice(options = {}) {
  const mod = await import('webgpu');
  Object.assign(globalThis, mod.globals);
  const gpu = mod.create(options.dawnOptions ?? []);
  const adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' });
  if (!adapter) throw new Error('Dawn could not create a WebGPU adapter');
  return await adapter.requestDevice();
}

export { PriorityCpuBatchScorer } from './cpu/priority-batch-scorer.js';
