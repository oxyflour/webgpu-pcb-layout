/// <reference types="@webgpu/types" />
export function createNodeWebGpuDevice(options?:{dawnOptions?:string[];powerPreference?:GPUPowerPreference;requiredLimits?:Record<string,number>;requiredFeatures?:GPUFeatureName[]}):Promise<GPUDevice>;
