import { worldPin, rotatedSize, sharesSide } from '../problem.js';

function cloneLayout(layout){ return layout.map(p=>({...p})); }

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

function deterministicUnit(i,j){
  const a = ((i + 1) * 73856093 ^ (j + 1) * 19349663) >>> 0;
  const t = (a % 628319) / 100000;
  return [Math.cos(t), Math.sin(t)];
}

export function pinAnchorOutsideFixed(problem, layout, pinIndex, gap=4){
  const pin = problem.pins[pinIndex];
  const comp = problem.components[pin.componentIndex];
  if(!comp.fixed || !pin.normal) return worldPin(problem, layout, pinIndex);
  const pl = layout[pin.componentIndex];
  const [w,h] = rotatedSize(comp, pl.rotation);
  const [px,py] = worldPin(problem, layout, pinIndex);
  const [nx,ny] = pin.normal;
  if(Math.abs(nx) >= Math.abs(ny)) {
    return [pl.x + Math.sign(nx || 1) * (w/2 + gap), py];
  }
  return [px, pl.y + Math.sign(ny || 1) * (h/2 + gap)];
}

/** Resolve AnalyticalGlobalPlacer defaults (shared with the WebGPU placer). */
export function resolveGlobalPlacerOptions(options={}){
  return {
    iterations: options.iterations ?? 500,
    wireStrength: options.wireStrength ?? 1.0,
    densityStrength: options.densityStrength ?? 0.50,
    overlapStrength: options.overlapStrength ?? 2.5,
    macroStrength: options.macroStrength ?? 4.0,
    boundaryStrength: options.boundaryStrength ?? 2.0,
    clearance: options.clearance ?? 2.5,
    macroClearance: options.macroClearance ?? 5.0,
    egressGap: options.egressGap ?? 6.0,
    fixedAnchorBoost: options.fixedAnchorBoost ?? 4.0,
    movableNetScale: options.movableNetScale ?? 0.85,
    damping: options.damping ?? 0.72,
    step: options.step ?? 0.55,
    maxMove: options.maxMove ?? 2.5,
    cooling: options.cooling ?? 0.997,
    recordEvery: options.recordEvery ?? 5,
    onIteration: options.onIteration ?? null,
    netWeight: options.netWeight ?? null,
    // Long-range bin density (off when strength is 0); see densityGridSpec().
    gridDensity: {
      strength: 0, bins: 64, target: 0.7, pinArea: 0, scales: [1, 2, 4, 8, 16],
      ...options.gridDensity,
    },
  };
}

/** Fixed-point resolution of bin coverage (shared with the WebGPU placer's atomics). */
export const DENSITY_FIXED_POINT = 4096;

/**
 * Density grid shared by the CPU and WebGPU placers. Each side of the board has a
 * grid of `bins` cells along its longer edge. A component covers its rectangle,
 * scaled by `inflate` so that its area grows by `pinArea` mm² per pin (routing
 * whitespace). The potential is sum over scales of Gaussian-blurred
 * (coverage - target); parts move down its gradient.
 */
export function densityGridSpec(problem, gd) {
  const W = problem.canvas.width, H = problem.canvas.height, bin = Math.max(W, H) / gd.bins;
  const gw = Math.max(2, Math.ceil(W / bin)), gh = Math.max(2, Math.ceil(H / bin));
  const inflate = problem.components.map((c) => Math.sqrt((c.width * c.height + gd.pinArea * c.pins.length) / (c.width * c.height)));
  const kernels = gd.scales.map((sigma) => {
    const r = Math.ceil(3 * sigma), w = [];
    for (let k = -r; k <= r; k++) w.push(Math.exp(-k * k / (2 * sigma * sigma)));
    const sum = w.reduce((a, b) => a + b, 0);
    return { sigma, radius: r, weights: w.map((v) => v / sum) };
  });
  return { gw, gh, binW: W / gw, binH: H / gh, inflate, kernels };
}

/** CPU reference of the density potential; returns phi[side][gy*gw+gx]. */
export function densityPotential(problem, layout, gd, spec) {
  const { gw, gh, binW, binH, inflate, kernels } = spec, B = gw * gh;
  const cover = [new Float64Array(B), new Float64Array(B)];
  problem.components.forEach((c, i) => {
    const p = layout[i], [w, h] = rotatedSize(c, p.rotation), hw = 0.5 * w * inflate[i], hh = 0.5 * h * inflate[i];
    const x0 = p.x - hw, x1 = p.x + hw, y0 = p.y - hh, y1 = p.y + hh;
    const bx0 = Math.max(0, Math.floor(x0 / binW)), bx1 = Math.min(gw - 1, Math.floor(x1 / binW));
    const by0 = Math.max(0, Math.floor(y0 / binH)), by1 = Math.min(gh - 1, Math.floor(y1 / binH));
    const sides = c.twoSided ? [0, 1] : [p.side ? 1 : 0];
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const ox = Math.min(x1, (bx + 1) * binW) - Math.max(x0, bx * binW), oy = Math.min(y1, (by + 1) * binH) - Math.max(y0, by * binH);
      if (ox <= 0 || oy <= 0) continue;
      const q = Math.round(ox * oy / (binW * binH) * DENSITY_FIXED_POINT) / DENSITY_FIXED_POINT;
      for (const s of sides) cover[s][by * gw + bx] += q;
    }
  });
  return cover.map((cv) => {
    const phi = new Float64Array(B);
    for (const { radius: r, weights } of kernels) {
      const tmp = new Float64Array(B);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < gw) acc += weights[k + r] * (cv[y * gw + xx] - gd.target); }
        tmp[y * gw + x] = acc;
      }
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < gh) acc += weights[k + r] * tmp[yy * gw + x]; }
        phi[y * gw + x] += acc;
      }
    }
    return phi;
  });
}

/** Bilinearly interpolated gradient (per bin) of one side's potential at (x, y) mm. */
export function densityGradient(phi, spec, x, y) {
  const { gw, gh, binW, binH } = spec;
  const at = (ix, iy) => phi[iy * gw + ix];
  const grad = (ix, iy) => [
    ix === 0 ? at(1, iy) - at(0, iy) : ix === gw - 1 ? at(gw - 1, iy) - at(gw - 2, iy) : 0.5 * (at(ix + 1, iy) - at(ix - 1, iy)),
    iy === 0 ? at(ix, 1) - at(ix, 0) : iy === gh - 1 ? at(ix, gh - 1) - at(ix, gh - 2) : 0.5 * (at(ix, iy + 1) - at(ix, iy - 1)),
  ];
  const fx = x / binW - 0.5, fy = y / binH - 0.5;
  const ix0 = clamp(Math.floor(fx), 0, gw - 1), iy0 = clamp(Math.floor(fy), 0, gh - 1);
  const ix1 = Math.min(ix0 + 1, gw - 1), iy1 = Math.min(iy0 + 1, gh - 1);
  const tx = clamp(fx - ix0, 0, 1), ty = clamp(fy - iy0, 0, 1);
  const g00 = grad(ix0, iy0), g10 = grad(ix1, iy0), g01 = grad(ix0, iy1), g11 = grad(ix1, iy1);
  return [0, 1].map((k) => (1 - ty) * ((1 - tx) * g00[k] + tx * g10[k]) + ty * ((1 - tx) * g01[k] + tx * g11[k]));
}

/**
 * Small/medium-scale analytical/force global placer for arbitrary component+pin canvases.
 *
 * This is intentionally not a DREAMPlace clone. It uses pin-aware spring forces,
 * fixed-macro egress anchors, soft density repulsion, exact rectangle-overlap pushes,
 * and boundary forces. The API is backend-neutral and is used as the global stage
 * before the repository LNS + negotiated router.
 */
export class AnalyticalGlobalPlacer {
  constructor(problem, options={}){
    this.problem = problem;
    this.options = resolveGlobalPlacerOptions(options);
  }

  #netForces(layout, fx, fy, wireStrength){
    const p=this.problem;
    for(const net of p.nets){
      if(net.pins.length < 2) continue;
      const rawWeight = typeof this.options.netWeight === 'function'
        ? this.options.netWeight(net)
        : (this.options.netWeight?.[net.id] ?? 1);
      const priorityWeight = Math.max(0, Number(rawWeight) || 0);
      if(priorityWeight === 0) continue;
      // Build effective pin positions. Fixed pins with a normal anchor the movable
      // endpoint just outside the macro rather than pulling it through the package.
      const pos = net.pins.map(pi=>{
        const pin=p.pins[pi];
        return p.components[pin.componentIndex].fixed && pin.normal
          ? pinAnchorOutsideFixed(p,layout,pi,this.options.egressGap)
          : worldPin(p,layout,pi);
      });
      if(net.pins.length===2){
        const [a,b]=net.pins;
        const pa=p.pins[a], pb=p.pins[b];
        const ca=pa.componentIndex, cb=pb.componentIndex;
        let dx=pos[1][0]-pos[0][0],dy=pos[1][1]-pos[0][1];
        const dist=Math.hypot(dx,dy)+1e-9;
        // Saturating spring: strong direction signal without giant random-start forces.
        const aFixed=p.components[ca].fixed && pa.normal;
        const bFixed=p.components[cb].fixed && pb.normal;
        const netScale=(aFixed||bFixed)?this.options.fixedAnchorBoost:this.options.movableNetScale;
        const mag=wireStrength*netScale*priorityWeight*Math.tanh(dist/18);
        dx=dx/dist*mag;dy=dy/dist*mag;
        if(!p.components[ca].fixed){fx[ca]+=dx;fy[ca]+=dy;}
        if(!p.components[cb].fixed){fx[cb]-=dx;fy[cb]-=dy;}
      } else {
        let cx=0,cy=0;for(const [x,y] of pos){cx+=x;cy+=y;}cx/=pos.length;cy/=pos.length;
        for(let k=0;k<net.pins.length;k++){
          const pin=p.pins[net.pins[k]], ci=pin.componentIndex;
          if(p.components[ci].fixed) continue;
          let dx=cx-pos[k][0],dy=cy-pos[k][1];const d=Math.hypot(dx,dy)+1e-9;
          const mag=wireStrength*priorityWeight*Math.tanh(d/18)/Math.max(1,net.pins.length-1);
          fx[ci]+=dx/d*mag;fy[ci]+=dy/d*mag;
        }
      }
    }
  }

  #densityAndOverlap(layout, fx, fy, densityStrength, overlapStrength){
    const p=this.problem, clear=this.options.clearance;
    for(let i=0;i<p.components.length;i++){
      if(p.components[i].fixed) continue;
      const [wi,hi]=rotatedSize(p.components[i],layout[i].rotation);
      for(let j=i+1;j<p.components.length;j++){
        if(p.components[j].fixed || !sharesSide(p,i,layout[i],j,layout[j])) continue;
        const [wj,hj]=rotatedSize(p.components[j],layout[j].rotation);
        let dx=layout[i].x-layout[j].x, dy=layout[i].y-layout[j].y;
        if(Math.abs(dx)+Math.abs(dy)<1e-8){const u=deterministicUnit(i,j);dx=u[0]*1e-3;dy=u[1]*1e-3;}
        const ax=(wi+wj)/2+clear, ay=(hi+hj)/2+clear;
        const ox=ax-Math.abs(dx), oy=ay-Math.abs(dy);
        if(ox>0 && oy>0){
          // Exact overlap legalization force along the cheaper separation axis.
          if(ox/ax < oy/ay){
            const s=Math.sign(dx)||1, f=overlapStrength*(ox/ax+0.15);
            fx[i]+=s*f;fx[j]-=s*f;
          }else{
            const s=Math.sign(dy)||1, f=overlapStrength*(oy/ay+0.15);
            fy[i]+=s*f;fy[j]-=s*f;
          }
        }
        // Short-range density repulsion keeps random starts from collapsing into one basin.
        const sx=Math.max(ax,1),sy=Math.max(ay,1);
        const qx=dx/sx,qy=dy/sy,d=Math.hypot(qx,qy)+1e-6;
        if(d<2.6){
          const f=densityStrength*(2.6-d)/(d*2.6);
          fx[i]+=qx/d*f;fy[i]+=qy/d*f;
          fx[j]-=qx/d*f;fy[j]-=qy/d*f;
        }
      }
    }
  }

  #macroAndBoundary(layout, fx, fy, macroStrength, boundaryStrength){
    const p=this.problem, mc=this.options.macroClearance;
    const fixed=[];for(let j=0;j<p.components.length;j++)if(p.components[j].fixed)fixed.push(j);
    for(let i=0;i<p.components.length;i++){
      if(p.components[i].fixed) continue;
      const c=p.components[i],[wi,hi]=rotatedSize(c,layout[i].rotation);
      for(const j of fixed){
        if(!sharesSide(p,i,layout[i],j,layout[j])) continue;
        const fcomp=p.components[j],[wj,hj]=rotatedSize(fcomp,layout[j].rotation);
        let dx=layout[i].x-layout[j].x,dy=layout[i].y-layout[j].y;
        if(Math.abs(dx)+Math.abs(dy)<1e-8){const u=deterministicUnit(i,j);dx=u[0]*1e-3;dy=u[1]*1e-3;}
        const ax=(wi+wj)/2+mc, ay=(hi+hj)/2+mc;
        const ox=ax-Math.abs(dx),oy=ay-Math.abs(dy);
        if(ox>0&&oy>0){
          // Push out of inflated fixed macro rectangle by nearest escape side.
          if(ox<oy){const s=Math.sign(dx)||1;fx[i]+=s*macroStrength*(0.5+ox/ax);}
          else {const s=Math.sign(dy)||1;fy[i]+=s*macroStrength*(0.5+oy/ay);}
        }else{
          // Gentle near-field repulsion from macro to keep routing channels open.
          const nx=dx/Math.max(ax,1),ny=dy/Math.max(ay,1),d=Math.hypot(nx,ny)+1e-6;
          if(d<1.8){const f=0.22*macroStrength*(1.8-d)/1.8;fx[i]+=nx/d*f;fy[i]+=ny/d*f;}
        }
      }
      const halfW=wi/2,halfH=hi/2;
      if(layout[i].x<halfW) fx[i]+=boundaryStrength*(halfW-layout[i].x)/Math.max(halfW,1);
      if(layout[i].x>p.canvas.width-halfW) fx[i]-=boundaryStrength*(layout[i].x-(p.canvas.width-halfW))/Math.max(halfW,1);
      if(layout[i].y<halfH) fy[i]+=boundaryStrength*(halfH-layout[i].y)/Math.max(halfH,1);
      if(layout[i].y>p.canvas.height-halfH) fy[i]-=boundaryStrength*(layout[i].y-(p.canvas.height-halfH))/Math.max(halfH,1);
    }
  }

  #gridDensity(layout, fx, fy, strength){
    const p=this.problem, gd=this.options.gridDensity;
    this.densitySpec ??= densityGridSpec(p, gd);
    const phi=densityPotential(p,layout,gd,this.densitySpec);
    for(let i=0;i<p.components.length;i++){
      const c=p.components[i]; if(c.fixed) continue;
      const sides=c.twoSided?[0,1]:[layout[i].side?1:0];
      for(const s of sides){
        const [gx,gy]=densityGradient(phi[s],this.densitySpec,layout[i].x,layout[i].y);
        fx[i]-=strength*gx/sides.length; fy[i]-=strength*gy/sides.length;
      }
    }
  }

  async optimize(initial){
    const p=this.problem,o=this.options,layout=cloneLayout(initial);
    const vx=new Float64Array(p.components.length),vy=new Float64Array(p.components.length);
    const trace=[];
    let step=o.step;
    for(let it=0;it<o.iterations;it++){
      const fx=new Float64Array(p.components.length),fy=new Float64Array(p.components.length);
      // Density/overlap starts stronger, then wire attraction becomes relatively dominant.
      const phase=it/Math.max(1,o.iterations-1);
      const density=o.densityStrength*(1.25-0.45*phase);
      const overlap=o.overlapStrength*(1.15-0.15*phase);
      const wire=o.wireStrength*(0.75+0.45*phase);
      this.#netForces(layout,fx,fy,wire);
      this.#densityAndOverlap(layout,fx,fy,density,overlap);
      this.#macroAndBoundary(layout,fx,fy,o.macroStrength,o.boundaryStrength);
      if(o.gridDensity.strength>0)this.#gridDensity(layout,fx,fy,o.gridDensity.strength);

      let maxDelta=0;
      for(let i=0;i<p.components.length;i++){
        const c=p.components[i];if(c.fixed){layout[i]={...c.fixed};continue;}
        vx[i]=o.damping*vx[i]+step*fx[i];vy[i]=o.damping*vy[i]+step*fy[i];
        const mag=Math.hypot(vx[i],vy[i]);
        if(mag>o.maxMove){vx[i]*=o.maxMove/mag;vy[i]*=o.maxMove/mag;}
        layout[i].x+=vx[i];layout[i].y+=vy[i];
        const [w,h]=rotatedSize(c,layout[i].rotation);
        layout[i].x=clamp(layout[i].x,w/2,p.canvas.width-w/2);
        layout[i].y=clamp(layout[i].y,h/2,p.canvas.height-h/2);
        maxDelta=Math.max(maxDelta,Math.hypot(vx[i],vy[i]));
      }
      step*=o.cooling;
      if(it===0 || it%o.recordEvery===o.recordEvery-1 || it===o.iterations-1){
        const row={iteration:it,maxDelta,layout:cloneLayout(layout)};trace.push(row);
        if(o.onIteration) await o.onIteration(row);
      }
    }
    return {layout:cloneLayout(layout),trace};
  }
}
