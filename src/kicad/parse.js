// KiCad .kicad_pcb text parser (footprints, pads, nets, Edge.Cuts outline).
// Vendored from webgpu_pcb_placer/src/kicad.js (same author); keep the two in sync.

const NUM = String.raw`[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?`;

function unquote(s) {
  if (!s) return '';
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

function matchingParen(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

export function extractBlocks(text, keyword) {
  const out = [];
  const re = new RegExp(`\\(${keyword}(?=\\s|\\))`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const start = m.index;
    const end = matchingParen(text, start);
    out.push(text.slice(start, end));
    re.lastIndex = end;
  }
  return out;
}

function parseAt(block) {
  const m = block.match(new RegExp(`\\(at\\s+(${NUM})\\s+(${NUM})(?:\\s+(${NUM}))?`));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0];
}

function parseSize(block) {
  const m = block.match(new RegExp(`\\(size\\s+(${NUM})\\s+(${NUM})`));
  return m ? [Math.abs(Number(m[1])), Math.abs(Number(m[2]))] : [0.8, 0.8];
}

function parseNet(block) {
  const m = block.match(/\(net\s+(\d+)(?:\s+("(?:\\.|[^"])*"|[^\s\)]+))?/);
  return m ? { id: Number(m[1]), name: unquote(m[2] || '') } : { id: 0, name: '' };
}

function parseReference(block, fallback) {
  let m = block.match(/\(property\s+"Reference"\s+("(?:\\.|[^"])*")/);
  if (m) return unquote(m[1]);
  m = block.match(/\(fp_text\s+reference\s+("(?:\\.|[^"])*"|[^\s\)]+)/);
  if (m) return unquote(m[1]);
  return fallback;
}

function footprintLibraryName(block) {
  const m = block.match(/^\((?:footprint|module)\s+("(?:\\.|[^"])*"|[^\s\)]+)/);
  return m ? unquote(m[1]) : 'unknown';
}

function rotate(x, y, deg) {
  const a = deg * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [c * x - s * y, s * x + c * y];
}

function addPoint(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function parseGraphicBounds(block, bounds) {
  const re = new RegExp(`\\((?:start|end|mid|center)\\s+(${NUM})\\s+(${NUM})`, 'g');
  let m;
  while ((m = re.exec(block))) addPoint(bounds, Number(m[1]), Number(m[2]));
}

function pointFrom(block, keyword) {
  const m = block.match(new RegExp(`\\(${keyword}\\s+(${NUM})\\s+(${NUM})`));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function arcThroughThree(start, mid, end) {
  const [x1,y1]=start,[x2,y2]=mid,[x3,y3]=end;
  const d=2*(x1*(y2-y3)+x2*(y3-y1)+x3*(y1-y2));
  if(Math.abs(d)<1e-10)return [start,end];
  const q1=x1*x1+y1*y1,q2=x2*x2+y2*y2,q3=x3*x3+y3*y3;
  const center=[(q1*(y2-y3)+q2*(y3-y1)+q3*(y1-y2))/d,(q1*(x3-x2)+q2*(x1-x3)+q3*(x2-x1))/d];
  let a0=Math.atan2(y1-center[1],x1-center[0]),am=Math.atan2(y2-center[1],x2-center[0]),a1=Math.atan2(y3-center[1],x3-center[0]);
  const tau=Math.PI*2; while(am<a0)am+=tau;while(a1<a0)a1+=tau;
  if(am>a1){while(a1>=a0)a1-=tau;while(am>=a0)am-=tau;}
  const radius=Math.hypot(x1-center[0],y1-center[1]);
  const steps=Math.max(2,Math.min(720,Math.ceil(Math.abs(a1-a0)/(Math.PI/18))));
  const out=[];for(let i=0;i<=steps;i++){const a=a0+(a1-a0)*i/steps;out.push(i===steps?end:[center[0]+Math.cos(a)*radius,center[1]+Math.sin(a)*radius]);}return out;
}

function stitchSegments(segments) {
  const contours=[];const near=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<1e-3;
  while(segments.length){const first=segments.pop();const contour=[...first];let changed=true;
    while(changed){changed=false;for(let i=segments.length-1;i>=0;i--){const s=segments[i],head=contour[0],tail=contour.at(-1);
      if(near(tail,s[0]))contour.push(...s.slice(1));else if(near(tail,s.at(-1)))contour.push(...[...s].reverse().slice(1));
      else if(near(head,s.at(-1)))contour.unshift(...s.slice(0,-1));else if(near(head,s[0]))contour.unshift(...[...s].reverse().slice(0,-1));else continue;
      segments.splice(i,1);changed=true;
    }}
    if(contour.length>=3)contours.push(contour);
  }return contours;
}

function parseEdgeGeometry(text) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const segments=[];
  for (const kind of ['gr_line', 'gr_rect', 'gr_arc', 'gr_circle', 'gr_poly']) {
    for (const b of extractBlocks(text, kind)) {
      if (!/\(layer\s+"?Edge\.Cuts"?\)/.test(b)) continue;
      parseGraphicBounds(b, bounds);
      const xy = new RegExp(`\\(xy\\s+(${NUM})\\s+(${NUM})`, 'g');
      let m; while ((m = xy.exec(b))) addPoint(bounds, Number(m[1]), Number(m[2]));
      const start=pointFrom(b,'start'),end=pointFrom(b,'end');
      if(kind==='gr_line'&&start&&end)segments.push([start,end]);
      else if(kind==='gr_rect'&&start&&end)segments.push([[start[0],start[1]],[end[0],start[1]],[end[0],end[1]],[start[0],end[1]],[start[0],start[1]]]);
      else if(kind==='gr_poly'){
        const pts=[];const re=new RegExp(`\\(xy\\s+(${NUM})\\s+(${NUM})`,'g');let p;while((p=re.exec(b)))pts.push([Number(p[1]),Number(p[2])]);if(pts.length>=3)segments.push([...pts,pts[0]]);
      }else if(kind==='gr_circle'){
        const center=pointFrom(b,'center');if(center&&end){const r=Math.hypot(end[0]-center[0],end[1]-center[1]),pts=[];for(let i=0;i<=72;i++){const a=i*Math.PI*2/72;pts.push([center[0]+Math.cos(a)*r,center[1]+Math.sin(a)*r]);}segments.push(pts);}
      }else if(kind==='gr_arc'&&start&&end){
        const mid=pointFrom(b,'mid');if(mid)segments.push(arcThroughThree(start,mid,end));
        else {const angle=b.match(new RegExp(`\\(angle\\s+(${NUM})`));if(angle){const center=start,arcStart=end,a0=Math.atan2(arcStart[1]-center[1],arcStart[0]-center[0]),sweep=Number(angle[1])*Math.PI/180,r=Math.hypot(arcStart[0]-center[0],arcStart[1]-center[1]),steps=Math.max(2,Math.ceil(Math.abs(sweep)/(Math.PI/18))),pts=[];for(let i=0;i<=steps;i++){const a=a0+sweep*i/steps;pts.push([center[0]+Math.cos(a)*r,center[1]+Math.sin(a)*r]);}segments.push(pts);}}
      }
    }
  }
  return {...bounds, contours:stitchSegments(segments)};
}

function finalizeBounds(bounds, fallback = 2.0) {
  if (!Number.isFinite(bounds.minX)) return { minX: -fallback/2, minY: -fallback/2, maxX: fallback/2, maxY: fallback/2 };
  const minSpan = 0.8;
  if (bounds.maxX - bounds.minX < minSpan) {
    const c = (bounds.maxX + bounds.minX) * 0.5; bounds.minX = c-minSpan/2; bounds.maxX = c+minSpan/2;
  }
  if (bounds.maxY - bounds.minY < minSpan) {
    const c = (bounds.maxY + bounds.minY) * 0.5; bounds.minY = c-minSpan/2; bounds.maxY = c+minSpan/2;
  }
  return bounds;
}

export function parseKicadPCB(text, name = 'KiCad PCB') {
  if (!text.includes('(kicad_pcb')) throw new Error('文件看起来不是 KiCad .kicad_pcb。');
  const rawBlocks = [
    ...extractBlocks(text, 'footprint'),
    ...extractBlocks(text, 'module'),
  ];
  if (!rawBlocks.length) throw new Error('没有找到 footprint/module。');

  const footprints = [];
  const pads = [];
  const rawNetNames = new Map();

  rawBlocks.forEach((block, fi) => {
    const libName = footprintLibraryName(block);
    const [ox, oy, rotDeg] = parseAt(block);
    const side = /\(layer\s+"?B\.Cu"?\)/.test(block) ? -1 : 1;
    const fixed = /\blocked\b/.test(block) || /\(locked\s+yes\)/.test(block);
    const ref = parseReference(block, `${libName.split(':').pop() || 'U'}#${fi}`);

    const localBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const kind of ['fp_line', 'fp_rect', 'fp_arc', 'fp_poly']) {
      for (const g of extractBlocks(block, kind)) {
        // Courtyard/Fab/Silk all help establish a useful body extent; text is intentionally ignored.
        parseGraphicBounds(g, localBounds);
        const xy = new RegExp(`\\(xy\\s+(${NUM})\\s+(${NUM})`, 'g');
        let mm; while ((mm = xy.exec(g))) addPoint(localBounds, Number(mm[1]), Number(mm[2]));
      }
    }

    const padBlocks = extractBlocks(block, 'pad');
    const padTemp = [];
    for (const pb of padBlocks) {
      let [px, py, prot] = parseAt(pb);
      const [pw, ph] = parseSize(pb);
      const net = parseNet(pb);
      if (net.id !== 0 && net.name) rawNetNames.set(net.id, net.name);
      if (side < 0) { px = -px; prot = -prot; }
      const aa = prot * Math.PI / 180;
      const hx = 0.5 * (Math.abs(Math.cos(aa))*pw + Math.abs(Math.sin(aa))*ph);
      const hy = 0.5 * (Math.abs(Math.sin(aa))*pw + Math.abs(Math.cos(aa))*ph);
      addPoint(localBounds, px-hx, py-hy); addPoint(localBounds, px+hx, py+hy);
      padTemp.push({ lx:px, ly:py, w:pw, h:ph, rot:prot, rawNet:net.id });
    }

    finalizeBounds(localBounds, 2.0);
    let cx = (localBounds.minX + localBounds.maxX) * 0.5;
    let cy = (localBounds.minY + localBounds.maxY) * 0.5;
    if (side < 0) cx = -cx;
    const [dcx, dcy] = rotate(cx, cy, rotDeg);
    const x = ox + dcx, y = oy + dcy;
    const halfW = Math.max(0.4, (localBounds.maxX - localBounds.minX) * 0.5);
    const halfH = Math.max(0.4, (localBounds.maxY - localBounds.minY) * 0.5);
    const firstPad = pads.length;
    for (const p of padTemp) {
      pads.push({ parent:fi, lx:p.lx-cx, ly:p.ly-cy, w:p.w, h:p.h, rot:p.rot, rawNet:p.rawNet, net:-1 });
    }
    footprints.push({ name:ref, libName, x, y, rot:rotDeg, halfW, halfH, fixed, side, layer:side<0?1:0, firstPad, padCount:padTemp.length });
  });

  // Compact sparse KiCad net IDs to [0, netCount).
  const rawIds = [...new Set(pads.map(p => p.rawNet).filter(id => id > 0))].sort((a,b)=>a-b);
  const compact = new Map(rawIds.map((id, i) => [id, i]));
  const nets = rawIds.map((rawId, i) => ({ id:i, rawId, name:rawNetNames.get(rawId) || `net-${rawId}`, pads:[] }));
  pads.forEach((p, pi) => {
    if (p.rawNet > 0 && compact.has(p.rawNet)) {
      p.net = compact.get(p.rawNet);
      nets[p.net].pads.push(pi);
    }
  });

  const links = [];
  for (const n of nets) {
    if (n.pads.length < 2) continue;
    const root = n.pads[0];
    for (let k=1; k<n.pads.length; k++) links.push([root, n.pads[k]]);
  }

  let board = parseEdgeGeometry(text);
  if (!Number.isFinite(board.minX)) {
    board = { minX:Infinity, minY:Infinity, maxX:-Infinity, maxY:-Infinity };
    for (const f of footprints) {
      addPoint(board, f.x-f.halfW, f.y-f.halfH); addPoint(board, f.x+f.halfW, f.y+f.halfH);
    }
    board.minX -= 5; board.minY -= 5; board.maxX += 5; board.maxY += 5;
    board.contours = [[[board.minX,board.minY],[board.maxX,board.minY],[board.maxX,board.maxY],[board.minX,board.maxY]]];
  }
  board = finalizeBounds(board, 100);
  if(!board.contours?.length)board.contours=[[[board.minX,board.minY],[board.maxX,board.minY],[board.maxX,board.maxY],[board.minX,board.maxY]]];

  return {
    name,
    board,
    footprints,
    pads,
    nets,
    links,
    layers: [
      {id:0, name:'F.Cu', side:'top'},
      {id:1, name:'B.Cu', side:'bottom'},
    ].filter(layer => footprints.some(fp => fp.layer === layer.id)),
    source: 'kicad',
    originalPositions: footprints.map(f => ({x:f.x, y:f.y, rot:f.rot, fixed:f.fixed})),
  };
}

