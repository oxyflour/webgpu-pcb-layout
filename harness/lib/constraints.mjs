// Design constraints of a board: which IC each decoupling capacitor serves, and critical nets.
//
// Defaults come from the KiCad files; harness/constraints/<board>.json (optional) adds or overrides
// (harness/constraints/<board>.template.json = the defaults in this format, to copy and edit):
//   {
//     "decaps": {"C201": "U201", "C215": {"ic": "U201", "maxMm": 2}, "C300": {"candidates": ["U3", "U4"]}},
//     "critical": [
//       {"nets": ["/RF/ANT"], "kind": "rf", "maxLengthMm": 10, "maxVias": 0, "keepoutMm": 0.5, "layer": "top", "priority": 1},
//       {"pair": ["/CPU/USB_DP", "/CPU/USB_DM"], "maxMismatchMm": 0.5, "maxVias": 2},
//       {"class": "USB", "maxVias": 2}
//     ]
//   }
// Decap defaults: the ICs on the capacitor's supply that sit in the same schematic sheet (footprint
// `path` without its last element; k60: the human's IC is a same-sheet IC for 48 of 55 decaps), else
// every IC on the supply. Critical defaults: every KiCad net class other than Default whose nets are
// signals (power classes skipped), crystal nets, and differential pairs found by name. Limits are
// only set by the file (defaults report values, with the human layout as reference).
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_ROOT } from './env.mjs';
import { boardAnalysis } from './human-metrics.mjs';

// Footprint blocks of a .kicad_pcb (KiCad 4-8): reference, sheet path; net_class blocks (KiCad <= 5).
export function kicadInfo(b) {
  const text = fs.readFileSync(b.file, 'utf8'), sheetOf = {}, netClasses = [];
  // Top-level blocks start with "\n  (" at depth 1; footprints are "(module" (<= 5) or "(footprint" (>= 6).
  for (const blk of text.split(/\n {2}(?=\((?:module|footprint|net_class) )/).slice(1)) {
    if (blk.startsWith('(net_class')) {
      const name = blk.match(/^\(net_class\s+("([^"]*)"|\S+)/); const num = (k) => { const m = blk.match(new RegExp(`\\(${k}\\s+([\\d.]+)\\)`)); return m ? Number(m[1]) : null; };
      netClasses.push({ name: name[2] ?? name[1], clearance: num('clearance'), traceWidth: num('trace_width'), viaDia: num('via_dia'), nets: [...blk.matchAll(/\(add_net\s+("([^"]*)"|[^)\s]+)\)/g)].map((m) => m[2] ?? m[1]) });
      continue;
    }
    const ref = (blk.match(/\(fp_text reference\s+"?([^"\s)]+)"?/) ?? blk.match(/\(property "Reference" "([^"]+)"/))?.[1];
    const p = blk.match(/\(path\s+"?([^")]+)"?\)/)?.[1];
    if (ref && p) sheetOf[ref] = p.split('/').slice(0, -1).join('/');
  }
  // KiCad >= 6: classes in the .kicad_pro next to the board (assignments by pattern / explicit map).
  const pro = b.file.replace(/\.kicad_pcb$/, '.kicad_pro');
  if (!netClasses.length && fs.existsSync(pro)) {
    const ns = JSON.parse(fs.readFileSync(pro, 'utf8')).net_settings ?? {}, all = b.p.nets.map((n) => n.id);
    for (const c of ns.classes ?? []) { if (c.name === 'Default') continue;
      const pats = (ns.netclass_patterns ?? []).filter((q) => q.netclass === c.name).map((q) => new RegExp('^' + q.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'));
      const nets = all.filter((n) => (ns.netclass_assignments?.[n] ?? []).includes?.(c.name) || ns.netclass_assignments?.[n] === c.name || pats.some((r) => r.test(n)));
      netClasses.push({ name: c.name, clearance: c.clearance ?? null, traceWidth: c.track_width ?? null, viaDia: c.via_diameter ?? null, nets }); }
  }
  return { sheetOf, netClasses };
}

const powerClass = /power|aliment|potencia|supply|gnd|ground|chassis|mec|terminal|^\+|\dV|VPHY|VPLL|PoE/i;

export function loadConstraints(b, { file = path.join(HARNESS_ROOT, 'constraints', `${b.name}.json`) } = {}) {
  const A = boardAnalysis(b), K = kicadInfo(b), fps = b.a.ir.footprints, ref = fps.map((f) => f.id), idx = new Map(ref.map((r, i) => [r, i]));
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  // Decaps.
  const decaps = A.decaps.map((d) => {
    const onSupply = [...new Set(A.icPadsOn[d.net].map((q) => A.padOf[q].comp))].filter((i) => i !== d.comp);
    const sheet = K.sheetOf[d.ref], same = sheet != null ? onSupply.filter((i) => K.sheetOf[ref[i]] === sheet) : [];
    const u = user.decaps?.[d.ref], uIcs = typeof u === 'string' ? [u] : u?.ic ? [u.ic] : u?.candidates ?? null;
    for (const r of uIcs ?? []) if (!idx.has(r)) throw new Error(`constraints: decap ${d.ref}: unknown IC ${r}`);
    const ics = uIcs ? uIcs.map((r) => idx.get(r)) : same.length ? same : onSupply;
    return { ...d, ics, source: uIcs ? 'file' : same.length ? 'sheet' : 'supply', ...(u?.maxMm != null ? { maxMm: u.maxMm } : {}) };
  }).filter((d) => d.ics.length);
  // Critical nets.
  const netIdx = new Map(b.p.nets.map((n, i) => [n.id, i])), critical = [];
  for (const c of K.netClasses) { if (c.name === 'Default' || /all nets/i.test(c.name) || powerClass.test(c.name) || c.nets.length > b.p.nets.length / 2) continue;
    const nets = c.nets.map((n) => netIdx.get(n)).filter((i) => i != null); if (!nets.length) continue;
    critical.push({ name: `class ${c.name}`, kind: 'class', class: c.name, nets, traceWidth: c.traceWidth, clearance: c.clearance, source: 'netclass' }); }
  if (A.groups.crystal.length) critical.push({ name: 'crystal nets', kind: 'crystal', nets: A.groups.crystal, source: 'crystal parts' });
  const setKey = (nets) => [...nets].sort((x, y) => x - y).join();
  for (const [p, n] of A.pairs) { const same = critical.find((c) => setKey(c.nets) === setKey([p, n]));
    if (same) { same.kind = 'pair'; same.nets = [p, n]; continue; } // a net class that is exactly this pair
    critical.push({ name: `pair ${b.p.nets[p].id}`, kind: 'pair', nets: [p, n], source: 'net names' }); }
  for (const u of user.critical ?? []) {
    const nets = u.pair ?? u.nets ?? (u.class ? K.netClasses.find((c) => c.name === u.class)?.nets : null);
    if (!nets) throw new Error(`constraints: critical entry needs nets, pair or a known class: ${JSON.stringify(u)}`);
    const ni = nets.map((n) => { if (!netIdx.has(n)) throw new Error(`constraints: unknown net ${n}`); return netIdx.get(n); });
    const key = setKey(ni), k = critical.findIndex((c) => setKey(c.nets) === key), base = k >= 0 ? critical[k] : {};
    const kind = u.kind ?? (u.pair ? 'pair' : base.kind ?? 'net');
    const entry = { ...base, name: u.name ?? base.name ?? (u.class ? `class ${u.class}` : `${kind} ${nets[0]}`), ...u, kind, nets: ni, source: 'file' };
    if (k >= 0) critical[k] = entry; else critical.push(entry);
  }
  return { board: b.name, decaps, critical, sheets: Object.keys(K.sheetOf).length > 0, netClasses: K.netClasses.map((c) => c.name), analysis: A };
}

// Router rules of the critical entries that set routing limits (lib/native-router.mjs netRules):
// priority (default 1 when any limit is set; lower routes first), maxVias 0 -> via cost x30, other
// maxVias -> x4, layer 'top' / 'bottom' / [layer indices] -> allowed layers, keepoutMm -> cells.
export function routerRules(b, C, cell = 0.4) {
  const L = Math.max(2, b.a.routing.layers ?? 2), rules = new Map();
  for (const c of C.critical) {
    if (c.priority == null && c.maxVias == null && c.layer == null && c.keepoutMm == null) continue;
    const mask = c.layer == null ? -1 : c.layer === 'top' ? 1 : c.layer === 'bottom' ? 1 << (L - 1) : c.layer.reduce((m, l) => m | (1 << l), 0);
    for (const net of c.nets) rules.set(net, { net, priority: c.priority ?? 1, viaMul: c.maxVias === 0 ? 30 : c.maxVias != null ? 4 : 1, layerMask: mask, keepout: c.keepoutMm ? Math.ceil(c.keepoutMm / cell) : 0 });
  }
  return [...rules.values()];
}

// Editable form of the constraints (refs and net names), e.g. as a template for <board>.json.
export function constraintsTemplate(b, C) {
  const ref = b.a.ir.footprints.map((f) => f.id), net = (i) => b.p.nets[i].id;
  return { board: b.name, note: 'Defaults derived from the KiCad files (decaps: ICs in the same schematic sheet on the same supply; critical: net classes, crystal nets, differential pairs by name). Save as <board>.json and edit: a decap value is one IC ref (or {ic, maxMm}); critical entries take nets / pair / class plus kind, maxLengthMm, maxVias, maxMismatchMm, keepoutMm, layer, priority.',
    decaps: Object.fromEntries(C.decaps.map((d) => [d.ref, d.ics.length === 1 ? ref[d.ics[0]] : { candidates: d.ics.map((i) => ref[i]), source: d.source }])),
    critical: C.critical.map((c) => ({ name: c.name, kind: c.kind, ...(c.kind === 'pair' ? { pair: c.nets.map(net) } : c.class ? { class: c.class } : { nets: c.nets.map(net) }), ...Object.fromEntries(['maxLengthMm', 'maxVias', 'maxMismatchMm', 'keepoutMm', 'layer', 'priority', 'traceWidth', 'clearance'].filter((k) => c[k] != null).map((k) => [k, c[k]])) })) };
}

const rq = (x, y, r) => { r = ((r % 4) + 4) % 4; return r === 0 ? [x, y] : r === 1 ? [-y, x] : r === 2 ? [-x, -y] : [y, -x]; };
const centre = (L, rp) => { const q = L[rp.comp], [rx, ry] = rq(q.side ? -rp.lx : rp.lx, rp.ly, q.rotation); return [q.x + rx, q.y + ry]; };

// Distance of a decap's supply pad to the nearest pad of one of its assigned ICs on the same supply.
export function decapDistance(L, C, d) {
  const A = C.analysis, [x, y] = centre(L, A.padOf[d.pad].rp), ics = new Set(d.ics); let best = Infinity;
  for (const q of A.icPadsOn[d.net]) { const p = A.padOf[q]; if (!ics.has(p.comp)) continue; const [u, v] = centre(L, p.rp), e = Math.hypot(u - x, v - y); if (e < best) best = e; }
  return best;
}

// Values of every constraint for a layout (perNet from evaluate / evaluateRobust with detail: true).
export function evalConstraints(b, L, C, perNet) {
  const dist = C.decaps.map((d) => decapDistance(L, C, d)), q = (v, f) => { const s = [...v].sort((a, c) => a - c); return s.length ? +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(2) : null; };
  const decap = { count: dist.length, fromSheet: C.decaps.filter((d) => d.source === 'sheet').length, medianMm: q(dist, 0.5), p90Mm: q(dist, 0.9), within3mm: dist.length ? +(dist.filter((v) => v <= 3).length / dist.length).toFixed(2) : null,
    overMax: C.decaps.filter((d, k) => d.maxMm != null && dist[k] > d.maxMm).map((d) => d.ref) };
  const critical = C.critical.map((c) => { const len = c.nets.map((ni) => perNet[ni].lengthMm), vias = c.nets.reduce((a, ni) => a + perNet[ni].vias, 0), clean = c.nets.every((ni) => perNet[ni].status === 'clean');
    const v = { name: c.name, kind: c.kind, nets: c.nets.length, clean, lengthMm: Math.round(len.reduce((a, x) => a + x, 0) * 10) / 10, maxNetLengthMm: Math.round(Math.max(...len) * 10) / 10, vias, ...(c.kind === 'pair' ? { mismatchMm: Math.round(Math.abs(len[0] - len[1]) * 10) / 10 } : {}) };
    const fails = [...(c.maxLengthMm != null && v.maxNetLengthMm > c.maxLengthMm ? ['length'] : []), ...(c.maxVias != null && vias > c.maxVias ? ['vias'] : []), ...(c.maxMismatchMm != null && v.mismatchMm > c.maxMismatchMm ? ['mismatch'] : []), ...(!clean ? ['not routed'] : [])];
    return { ...v, pass: fails.length === 0, fails }; });
  return { decap, critical };
}
