import { worldPin, rotatedSize } from './problem.js';

export function coarseCongestionCpu(problem, layout, options={}) {
  const gridW=options.gridWidth ?? 32,gridH=options.gridHeight ?? 32,capacity=options.capacity ?? 1;
  const demand=new Uint16Array(gridW*gridH);
  const cell=(x,y)=>{
    const gx=Math.max(0,Math.min(gridW-1,Math.floor(x/problem.canvas.width*gridW)));
    const gy=Math.max(0,Math.min(gridH-1,Math.floor(y/problem.canvas.height*gridH)));
    return [gx,gy];
  };
  for(const net of problem.nets) {
    const [ax,ay]=cell(...worldPin(problem,layout,net.pins[0]));
    const touched=new Set();
    for(let k=1;k<net.pins.length;k++) {
      const [tx,ty]=cell(...worldPin(problem,layout,net.pins[k]));
      const x0=Math.min(ax,tx),x1=Math.max(ax,tx),y0=Math.min(ay,ty),y1=Math.max(ay,ty);
      for(let x=x0;x<=x1;x++)touched.add(ay*gridW+x);
      for(let y=y0;y<=y1;y++)touched.add(y*gridW+tx);
    }
    for(const i of touched)demand[i]++;
  }
  let penalty=0;for(const d of demand){const over=Math.max(0,d-capacity);penalty+=over*over;}
  return penalty;
}

export function scoreLayoutCpu(problem, layout, weights = {}, coarse = {}) {
  const w = { hpwl: 1, overlap: 1000, bounds: 1000, congestion: 1, ...weights };
  let hpwl = 0;
  for (const net of problem.nets) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pi of net.pins) {
      const [x, y] = worldPin(problem, layout, pi);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    hpwl += (maxX - minX) + (maxY - minY);
  }
  let overlap = 0;
  for (let i = 0; i < problem.components.length; i++) {
    const a = problem.components[i], pa = layout[i];
    const [aw, ah] = rotatedSize(a, pa.rotation);
    for (let j = i + 1; j < problem.components.length; j++) {
      const b = problem.components[j], pb = layout[j];
      const [bw, bh] = rotatedSize(b, pb.rotation);
      const ox = Math.max(0, Math.min(pa.x + aw / 2, pb.x + bw / 2) - Math.max(pa.x - aw / 2, pb.x - bw / 2));
      const oy = Math.max(0, Math.min(pa.y + ah / 2, pb.y + bh / 2) - Math.max(pa.y - ah / 2, pb.y - bh / 2));
      overlap += ox * oy;
    }
  }
  let bounds = 0;
  for (let i = 0; i < problem.components.length; i++) {
    const c = problem.components[i], p = layout[i];
    const [cw, ch] = rotatedSize(c, p.rotation);
    const left = Math.max(0, cw / 2 - p.x);
    const right = Math.max(0, p.x + cw / 2 - problem.canvas.width);
    const top = Math.max(0, ch / 2 - p.y);
    const bottom = Math.max(0, p.y + ch / 2 - problem.canvas.height);
    bounds += left * left + right * right + top * top + bottom * bottom;
  }
  const congestion=coarseCongestionCpu(problem,layout,coarse);
  return { total: w.hpwl * hpwl + w.overlap * overlap + w.bounds * bounds + w.congestion*congestion, hpwl, overlap, bounds, congestion };
}
