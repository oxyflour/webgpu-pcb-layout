import fs from 'node:fs';
import path from 'node:path';
import { loadBoard,placement } from './board.mjs';
import { normalizeProblem,parseKicadBoard,designToProblem,rotatedSize } from './runtime.mjs';
import { writeJson } from './io.mjs';
export function initSession(workspace,{board,boardFile,seed}){
  fs.mkdirSync(workspace,{recursive:true});
  if(fs.existsSync(path.join(workspace,'session.json')))throw Error('Workspace already exists');
  const state={version:1,board,boardFile:path.resolve(boardFile),seed,placeCalls:0,current:'c000',best:null,submitted:null,candidates:{}};
  const {problem}=loadBoard(state);
  let randomState=seed>>>0;const random=()=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState/4294967296;};
  const layout=problem.components.map(c=>{
    if(c.fixed)return {...c.fixed};
    const rotation=Math.floor(random()*4),[w,h]=rotatedSize(c,rotation);
    return {x:w/2+random()*Math.max(0,problem.canvas.width-w),y:h/2+random()*Math.max(0,problem.canvas.height-h),rotation,side:c.sides==='bottom'?1:0};
  });
  writeJson(path.join(workspace,'c000.json'),{board,layout,placement:placement(problem,layout),metrics:null,eligible:false,provenance:'Seeded uniform initialization, not a solved placement or human movable pose'});
  state.candidates.c000={id:'c000',file:'c000.json',metrics:null,eligible:false};writeJson(path.join(workspace,'session.json'),state);return state;
}
