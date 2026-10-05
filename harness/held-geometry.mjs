import {upstream} from './runtime.mjs';
const {rotatedSize,sharesSide}=await upstream('src/problem.js');
// Validate immutable execution constraints separately from random movable parts.
// Temporary held targets must not gain the fixed-fixed exemption of source data.
export function heldGeometry(problem,layout,held,{clearance=.1}={}){
  const selected=new Set(held),locked=problem.components.map((c,i)=>!!c.fixed||selected.has(i));
  const boxes=problem.components.map((c,i)=>{const p=layout[i],[w,h]=rotatedSize(c,p.rotation);return [p.x-w/2,p.y-h/2,p.x+w/2,p.y+h/2];});
  const conflicts=[];
  for(let i=0;i<layout.length;i++)for(let j=i+1;j<layout.length;j++){
    if(!locked[i]||!locked[j]||!selected.has(i)&&!selected.has(j)||!sharesSide(problem,i,layout[i],j,layout[j]))continue;
    const a=boxes[i],b=boxes[j],ox=Math.min(a[2],b[2])-Math.max(a[0],b[0]),oy=Math.min(a[3],b[3])-Math.max(a[1],b[1]);
    const gap=Math.hypot(Math.max(0,-ox),Math.max(0,-oy));
    if(gap<clearance-1e-6)conflicts.push({refs:[problem.components[i].id,problem.components[j].id],gapMm:+gap.toFixed(4),overlapMm:[+Math.max(0,ox).toFixed(4),+Math.max(0,oy).toFixed(4)]});
  }
  return {passed:conflicts.length===0,clearanceMm:clearance,conflictCount:conflicts.length,conflicts:conflicts.slice(0,12)};
}
