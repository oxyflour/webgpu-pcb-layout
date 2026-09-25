import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuGridRouter } from '../src/index.js';
import { getGpuOrSkip } from './gpu-helper.mjs';

test('WebGPU weighted wavefront routes through the only wall opening',async t=>{
  const device=await getGpuOrSkip(t);if(!device)return;
  const width=32,height=24,cells=width*height,blocked=new Uint32Array(cells),cost=new Float32Array(cells);cost.fill(1);
  const gapY=13;for(let y=0;y<height;y++)if(y!==gapY)blocked[y*width+15]=1;
  const source=5*width+3,target=19*width+28;
  const router=new GpuGridRouter(device);
  const r=await router.shortestPath({width,height,sources:[source],target,blocked,cellCost:cost,maxIterations:128});
  assert.ok(r.path?.length>0); assert.ok(r.path.includes(gapY*width+15));
  for(const c of r.path)assert.equal(blocked[c],0);
  device.destroy();
});
