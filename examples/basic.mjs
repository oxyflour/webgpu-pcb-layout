import { createNodeWebGpuDevice } from 'webgpu-pin-layout/node';
import { solveAutoLayout } from 'webgpu-pin-layout';
const device=await createNodeWebGpuDevice();
const problem={
  canvas:{width:120,height:80},
  components:[
    {id:'A',width:20,height:16,pins:[{id:'p1',x:10,y:-4,side:'right'},{id:'p2',x:10,y:4,side:'right'}]},
    {id:'B',width:20,height:16,pins:[{id:'p1',x:-10,y:-4,side:'left'},{id:'p2',x:-10,y:4,side:'left'}]},
    {id:'C',width:16,height:12,pins:[{id:'p1',x:0,y:-6,side:'top'}]}
  ],
  nets:[
    {id:'N1',pins:[{componentId:'A',pinId:'p1'},{componentId:'B',pinId:'p1'},{componentId:'C',pinId:'p1'}]},
    {id:'N2',pins:[{componentId:'A',pinId:'p2'},{componentId:'B',pinId:'p2'}]}
  ]
};
const result=await solveAutoLayout(problem,device,{optimizer:{iterations:30,population:512},router:{gridWidth:128,gridHeight:96,maxRounds:15}});
console.dir(result,{depth:4});
device.destroy();
