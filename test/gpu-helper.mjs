export async function getGpuOrSkip(t){
  try{
    const {createNodeWebGpuDevice}=await import('../src/node.js');
    return await createNodeWebGpuDevice();
  }catch(e){
    if(process.env.WEBGPU_REQUIRED==='1')throw e;
    t.skip(`real WebGPU unavailable: ${e?.message??e}`);return null;
  }
}
