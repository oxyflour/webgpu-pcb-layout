import fs from 'node:fs';
import path from 'node:path';
import { normalizeProblem, rotatedSize, worldPin } from '../../src/problem.js';

// Bookshelf uses y-up, lower-left positions and integer database units. Keep
// dimensions/offsets within 0.005 mm; fixed off-quarter parts are already baked by IR.
export function exportBookshelf(adapted, initial, dir, { units = 100 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const p = normalizeProblem(adapted.input), names = p.components.map((_, i) => `c${i}`);
  const q = (v) => Math.round(v * units), H = p.canvas.height;
  const entries = p.components.map((c, i) => {
    const fixed = c.fixed, pl = fixed ?? initial[i], side = pl.side ?? (c.sides === 'bottom' ? 1 : 0);
    const [w, h] = fixed ? rotatedSize(c, pl.rotation) : [c.width, c.height];
    return { name: names[i], id: c.id, index: i, fixed: !!fixed, rotatable: c.rotatable !== false,
      side, width: q(w) / units, height: q(h) / units,
      x: pl.x, y: H - pl.y, rotation: pl.rotation, engineRotation: fixed ? 0 : pl.rotation };
  });
  // Through-hole bodies occupy both sides. A pinless fixed copy on the other
  // side gives Cypress the same obstacle geometry as the shared legalizer.
  p.components.forEach((c,i)=>{
    if (c.twoSided && c.fixed) entries.push({...entries[i], name:`obstacle${i}`,
      id:`__cypress_obstacle_${i}`,side:1-entries[i].side,rotatable:false,obstacle:true});
  });
  const nodes = [`UCLA nodes 1.0`, `NumNodes : ${entries.length}`, `NumTerminals : ${entries.filter(e => e.fixed).length}`,
    ...entries.map(e => `${e.name} ${q(e.width)} ${q(e.height)}${e.fixed ? ' terminal' : ''}`)];
  const pl = ['UCLA pl 1.0', ...entries.map(e => `${e.name} ${q(e.x - e.width / 2)} ${q(e.y - e.height / 2)} : ${e.side ? 'FN' : 'N'}${e.fixed ? ' /FIXED' : ''}`)];
  const nets = ['UCLA nets 1.0', `NumNets : ${p.nets.length}`, `NumPins : ${p.nets.reduce((s,n)=>s+n.pins.length,0)}`];
  const expectedPins = [];
  for (let ni = 0; ni < p.nets.length; ni++) {
    nets.push(`NetDegree : ${p.nets[ni].pins.length} n${ni}`);
    for (const pi of p.nets[ni].pins) {
      const pin = p.pins[pi], ci = pin.componentIndex, e = entries[ci];
      let px, py;
      if (e.fixed) { const wp = worldPin(p, initial, pi); px = wp[0] - e.x; py = H - wp[1] - e.y; if (e.side) px = -px; }
      else { px = pin.x; py = -pin.y; }
      nets.push(`${e.name} I : ${q(px)} ${q(py)}`);
      const mx = e.side ? -q(px) / units : q(px) / units, my = q(py) / units;
      expectedPins.push({ node: e.name, net: `n${ni}`, x: q(e.x - e.width / 2) / units + e.width / 2 + mx,
        y: q(e.y - e.height / 2) / units + e.height / 2 + my });
    }
  }
  const rowHeight = 1, rows = Math.ceil(q(H) / rowHeight), width = q(p.canvas.width);
  const scl = ['UCLA scl 1.0', `NumRows : ${rows}`];
  for (let k=0;k<rows;k++) scl.push(`CoreRow Horizontal\n Coordinate : ${k*rowHeight}\n Height : ${rowHeight}\n Sitewidth : 1\n Sitespacing : 1\n Siteorient : N\n Sitesymmetry : Y\n SubrowOrigin : 0 NumSites : ${width}\nEnd`);
  for (const [ext, lines] of Object.entries({ nodes, pl, nets, scl })) fs.writeFileSync(path.join(dir, `board.${ext}`), lines.join('\n')+'\n');
  fs.writeFileSync(path.join(dir,'board.aux'),'RowBasedPlacement : board.nodes board.nets board.pl board.scl\n');
  const bridge = { units, height: H, entries, expectedPins, netIds: p.nets.map(n=>n.id) };
  fs.writeFileSync(path.join(dir,'bridge.json'),JSON.stringify(bridge,null,2));
  return bridge;
}

export function importCypressPlacement(adapted, output) {
  const entries = new Map(output.placements.map(e=>[e.id,e]));
  return adapted.input.components.map(c=>{
    const e = entries.get(c.id);
    if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.y)) throw new Error(`Invalid Cypress result: ${c.id}`);
    if (c.fixed) return { ...c.fixed };
    if (!Number.isInteger(e.rotation)||e.rotation<0||e.rotation>3) throw new Error(`Invalid Cypress rotation: ${c.id}`);
    const side = c.sides === 'bottom' ? 1 : 0;
    if (e.side !== side) throw new Error(`Cypress changed preassigned side: ${c.id}`);
    return {x:e.x,y:e.y,rotation:e.rotation,side:e.side};
  });
}
