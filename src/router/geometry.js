import { rotateQuarter, rotatedSize, worldPin } from '../problem.js';

export function makeGrid(problem, options={}) {
  const cellSize=options.cellSize ?? Math.min(problem.canvas.width,problem.canvas.height)/128;
  const width=options.gridWidth ?? Math.max(4,Math.ceil(problem.canvas.width/cellSize));
  const height=options.gridHeight ?? Math.max(4,Math.ceil(problem.canvas.height/cellSize));
  return {width,height,cellW:problem.canvas.width/width,cellH:problem.canvas.height/height};
}

export function worldToCell(problem,grid,x,y) {
  const gx=Math.max(0,Math.min(grid.width-1,Math.floor(x/problem.canvas.width*grid.width)));
  const gy=Math.max(0,Math.min(grid.height-1,Math.floor(y/problem.canvas.height*grid.height)));
  return gy*grid.width+gx;
}
export function cellCenter(problem,grid,index) {
  const x=index%grid.width,y=Math.floor(index/grid.width);
  return [(x+.5)*grid.cellW,(y+.5)*grid.cellH];
}

export function rasterizeComponents(problem,layout,grid,clearance=0) {
  const blocked=new Uint32Array(grid.width*grid.height);
  for(let ci=0;ci<problem.components.length;ci++) {
    const c=problem.components[ci],p=layout[ci]; const [w,h]=rotatedSize(c,p.rotation);
    const x0=p.x-w/2-clearance,x1=p.x+w/2+clearance,y0=p.y-h/2-clearance,y1=p.y+h/2+clearance;
    const gx0=Math.max(0,Math.floor(x0/problem.canvas.width*grid.width));
    const gx1=Math.min(grid.width-1,Math.floor(x1/problem.canvas.width*grid.width));
    const gy0=Math.max(0,Math.floor(y0/problem.canvas.height*grid.height));
    const gy1=Math.min(grid.height-1,Math.floor(y1/problem.canvas.height*grid.height));
    for(let y=gy0;y<=gy1;y++)for(let x=gx0;x<=gx1;x++)blocked[y*grid.width+x]=1;
  }
  return blocked;
}

function inferLocalNormal(problem,pin) {
  if(pin.normal) {
    const n=pin.normal,mag=Math.hypot(n[0],n[1])||1; return [n[0]/mag,n[1]/mag];
  }
  if(pin.side==='left')return[-1,0];if(pin.side==='right')return[1,0];if(pin.side==='top')return[0,-1];if(pin.side==='bottom')return[0,1];
  const c=problem.components[pin.componentIndex],x=pin.x,y=pin.y;
  const choices=[[Math.abs(x+c.width/2),-1,0],[Math.abs(x-c.width/2),1,0],[Math.abs(y+c.height/2),0,-1],[Math.abs(y-c.height/2),0,1]];
  choices.sort((a,b)=>a[0]-b[0]);return [choices[0][1],choices[0][2]];
}

export function carveNetPins(problem,layout,grid,baseBlocked,net,escapeCells=2) {
  const blocked=baseBlocked.slice(); const cells=[];
  for(const pi of net.pins) {
    const pin=problem.pins[pi],pl=layout[pin.componentIndex]; const [wx,wy]=worldPin(problem,layout,pi);
    const start=worldToCell(problem,grid,wx,wy); cells.push(start); blocked[start]=0;
    let [nx,ny]=inferLocalNormal(problem,pin); [nx,ny]=rotateQuarter(nx,ny,pl.rotation);
    // The router is 4-neighbour, so choose the dominant cardinal direction even
    // when the caller supplied a slightly diagonal pin normal. Carve until the
    // original obstacle mask has been exited (plus one cell), capped by escapeCells.
    let sx=0,sy=0; if(Math.abs(nx)>=Math.abs(ny)) sx=Math.sign(nx)||1; else sy=Math.sign(ny)||1;
    let cur=start,escaped=false;
    for(let k=0;k<escapeCells;k++) {
      const x=cur%grid.width,y=Math.floor(cur/grid.width); const xx=x+sx,yy=y+sy;
      if(xx<0||yy<0||xx>=grid.width||yy>=grid.height)break; cur=yy*grid.width+xx;blocked[cur]=0;
      if(baseBlocked[cur]===0){ if(escaped)break; escaped=true; }
    }
  }
  return {blocked,pinCells:cells};
}

export function guardCellsForPath(path,grid,radius) {
  const out=new Set();
  for(const idx of path) {
    const x=idx%grid.width,y=Math.floor(idx/grid.width);
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++) {
      if(Math.abs(dx)+Math.abs(dy)>radius)continue;
      const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<grid.width&&yy<grid.height)out.add(yy*grid.width+xx);
    }
  }
  return out;
}

export function pathToPolyline(problem,grid,path) {
  if(!path?.length)return[];
  const pts=path.map(i=>cellCenter(problem,grid,i)); if(pts.length<=2)return pts;
  const out=[pts[0]]; let pdx=Math.sign(pts[1][0]-pts[0][0]),pdy=Math.sign(pts[1][1]-pts[0][1]);
  for(let i=1;i<pts.length-1;i++) { const dx=Math.sign(pts[i+1][0]-pts[i][0]),dy=Math.sign(pts[i+1][1]-pts[i][1]); if(dx!==pdx||dy!==pdy)out.push(pts[i]);pdx=dx;pdy=dy; }
  out.push(pts.at(-1));return out;
}
