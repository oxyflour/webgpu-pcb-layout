export async function requestWebGpuDevice(options = {}) {
  const gpu = options.gpu ?? globalThis.navigator?.gpu;
  if (!gpu) throw new Error('WebGPU is not available. In Node import createNodeWebGpuDevice from "webgpu-pin-layout/node".');
  const adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter available');
  return await adapter.requestDevice({ requiredFeatures: options.requiredFeatures ?? [] });
}

export function createBuffer(device, size, usage, data = null) {
  const aligned = Math.max(4, (size + 3) & ~3);
  const buffer = device.createBuffer({ size: aligned, usage, mappedAtCreation: !!data });
  if (data) {
    const dst = new Uint8Array(buffer.getMappedRange());
    dst.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
  }
  return buffer;
}

export async function readBuffer(device, source, byteLength) {
  const out = device.createBuffer({
    size: Math.max(4, (byteLength + 3) & ~3),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(source, 0, out, 0, Math.max(4, (byteLength + 3) & ~3));
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const copy = out.getMappedRange().slice(0, byteLength);
  out.unmap(); out.destroy();
  return copy;
}
