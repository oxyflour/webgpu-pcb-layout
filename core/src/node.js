// Dawn tears down its native instance when the GPU object is garbage collected, which
// crashes the process if a device created from it is still in use. Keep every instance
// alive for as long as its device is.
const liveInstances = new Map();

export async function createNodeWebGpuDevice(options = {}) {
  const mod = await import('webgpu');
  Object.assign(globalThis, mod.globals);
  const gpu = mod.create(options.dawnOptions ?? []);
  const adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' });
  if (!adapter) throw new Error('Dawn could not create a WebGPU adapter');
  const device = await adapter.requestDevice({ requiredLimits: options.requiredLimits, requiredFeatures: options.requiredFeatures });
  liveInstances.set(device, gpu);
  device.lost.then(() => liveInstances.delete(device));
  return device;
}

export { PriorityCpuBatchScorer } from './cpu/priority-batch-scorer.js';
