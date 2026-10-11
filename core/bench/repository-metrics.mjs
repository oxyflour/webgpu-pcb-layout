import {rotatedSize,sharesSide,worldPin} from '../src/problem.js';
import {placementMasks,maskCellRect,blockedCells} from '../src/geometry/mask.js';

// Real-board checks exempt pre-existing conflicts between locked components.
export function repositoryMetrics(p,L,{clearance=.1}={}){
  let hpwl_mm=0;
  for(const n of p.nets){const pts=n.pins.map(pi=>worldPin(p,L,pi));if(pts.length>1)hpwl_mm+=Math.max(...pts.map(q=>q[0]))-Math.min(...pts.map(q=>q[0]))+Math.max(...pts.map(q=>q[1]))-Math.min(...pts.map(q=>q[1]));}
  const boxes=p.components.map((c,i)=>{const q=L[i],[w,h]=rotatedSize(c,q.rotation);return [q.x-w/2,q.y-h/2,q.x+w/2,q.y+h/2];});
  let movableOverlapPairs=0,movableClearancePairs=0,movableOutside=0,movableMaskViolations=0,fixed_changed=0,side_changed=0;
  const masks=placementMasks(p);
  for(let i=0;i<L.length;i++){
    const c=p.components[i],a=boxes[i];
    if(c.sides!=='any'&&(L[i].side??0)!==(c.sides==='bottom'?1:0))side_changed++;
    if(c.fixed){const q=c.fixed;if(Math.max(Math.abs(L[i].x-q.x),Math.abs(L[i].y-q.y))>1e-6||L[i].rotation!==q.rotation||(L[i].side??0)!==(q.side??0))fixed_changed++;}
    else{
      if(a[0]<-1e-6||a[1]<-1e-6||a[2]>p.canvas.width+1e-6||a[3]>p.canvas.height+1e-6)movableOutside++;
      if(masks&&blockedCells(masks,masks.componentLayers[i],L[i].side??0,!!c.twoSided,maskCellRect(masks,...a))>0)movableMaskViolations++;
    }
    for(let j=i+1;j<L.length;j++){
      if((c.fixed&&p.components[j].fixed)||!sharesSide(p,i,L[i],j,L[j]))continue;
      const b=boxes[j],ox=Math.min(a[2],b[2])-Math.max(a[0],b[0]),oy=Math.min(a[3],b[3])-Math.max(a[1],b[1]);
      if(ox>1e-6&&oy>1e-6)movableOverlapPairs++;
      if(Math.hypot(Math.max(0,-ox),Math.max(0,-oy))<clearance-1e-6)movableClearancePairs++;
    }
  }
  return {metrics:{hpwl_mm},geometry:{movableOverlapPairs,movableClearancePairs,movableOutside,movableMaskViolations,fixed_changed,side_changed,clearance_mm:clearance,tolerance_mm:1e-6}};
}
