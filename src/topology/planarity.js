/**
 * Build a pin-order-aware augmented graph.
 * Each component becomes a wheel: its pins form the rim in declared order and
 * a hub is connected to every pin. Each net is a vertex connected to its pins.
 * A planar embedding of this graph preserves component pin cyclic order (up to reversal).
 */
export function buildAugmentedGraph(problem) {
  const edges = [];
  const vertices = new Set();
  const hubId = (ci) => `c:${ci}:hub`;
  const pinId = (pi) => `p:${pi}`;
  const netId = (ni) => `n:${ni}`;
  const add = (a,b) => { if (a===b) return; vertices.add(a); vertices.add(b); edges.push([a,b]); };

  for (const c of problem.components) {
    const h = hubId(c.index); vertices.add(h);
    const ps = c.pins;
    for (const p of ps) add(h, pinId(p));
    if (ps.length >= 3) {
      for (let i=0;i<ps.length;i++) add(pinId(ps[i]), pinId(ps[(i+1)%ps.length]));
    } else if (ps.length === 2) add(pinId(ps[0]), pinId(ps[1]));
  }
  for (const n of problem.nets) {
    const nv=netId(n.index); vertices.add(nv);
    for (const p of n.pins) add(nv,pinId(p));
  }
  return { vertices:[...vertices], edges, ids:{hubId,pinId,netId} };
}

export async function analyzeTopology(problem) {
  const augmented = buildAugmentedGraph(problem);
  const { graph, planarity, embedding, layout } = await import('@khalidsaidi/topoloom');
  const g = graph.fromEdgeList(augmented.edges);
  const result = planarity.testPlanarity(g);
  if (!result.planar) {
    return { planar:false, augmented, witness: result.witness ?? result.kuratowski ?? result.obstruction ?? null, raw:result };
  }
  let mesh=null,drawing=null;
  try {
    mesh=embedding.buildHalfEdgeMesh(g,result.embedding);
    drawing=layout.planarStraightLine(mesh);
  } catch {
    // Embedding is still valid even if the optional drawing stage cannot handle
    // an isolated/disconnected augmented graph.
  }
  return { planar:true, augmented, embedding:result.embedding, mesh, drawing, raw:result };
}

function lookupPosition(positions,id) {
  if (!positions) return null;
  let p=null;
  if (positions instanceof Map) p=positions.get(id);
  else p=positions[id] ?? positions[String(id)];
  if (!p) return null;
  if (Array.isArray(p) || ArrayBuffer.isView(p)) return [Number(p[0]),Number(p[1])];
  if (typeof p==='object' && 'x' in p && 'y' in p) return [Number(p.x),Number(p.y)];
  return null;
}

export function initialLayoutFromEmbedding(problem, topology, margin=0.08) {
  const positions=topology?.drawing?.positions ?? topology?.drawing;
  const raw=new Array(problem.components.length).fill(null);
  for (const c of problem.components) raw[c.index]=lookupPosition(positions,`c:${c.index}:hub`);
  const known=raw.filter(Boolean);
  let minX=0,maxX=1,minY=0,maxY=1;
  if (known.length) {
    minX=Math.min(...known.map(p=>p[0]));maxX=Math.max(...known.map(p=>p[0]));
    minY=Math.min(...known.map(p=>p[1]));maxY=Math.max(...known.map(p=>p[1]));
    if (maxX-minX<1e-9){minX-=.5;maxX+=.5;} if(maxY-minY<1e-9){minY-=.5;maxY+=.5;}
  }
  const W=problem.canvas.width,H=problem.canvas.height;
  const mx=W*margin,my=H*margin;
  return problem.components.map((c,i)=>{
    if(c.fixed) return {...c.fixed};
    const p=raw[i];
    if(p) return {x:mx+(p[0]-minX)/(maxX-minX)*(W-2*mx), y:my+(p[1]-minY)/(maxY-minY)*(H-2*my), rotation:0};
    const a=2*Math.PI*(i/Math.max(1,problem.components.length));
    return {x:W/2+0.35*W*Math.cos(a),y:H/2+0.35*H*Math.sin(a),rotation:0};
  });
}
