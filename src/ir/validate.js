// Board IR validation (docs/board-ir.md, section 10).
import { BOARD_FORMAT } from './to-problem.js';

const SIDES = ['top', 'bottom'];
const PAD_SHAPES = ['rect', 'roundrect', 'oval', 'circle', 'polygon'];
const PAD_TYPES = ['smd', 'through', 'npth'];
const NET_CLASSES = ['signal', 'power', 'ground'];
const KNOWN_TOP = new Set(['format', 'yAxis', 'name', 'source', 'board', 'nets', 'footprints', 'regions', 'keepouts', 'modules', 'rules', 'extensions']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const point = (p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]);

/** @returns {{errors: string[], warnings: string[]}} */
export function validateBoardIR(ir) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  if (!ir || typeof ir !== 'object') return { errors: ['IR must be an object'], warnings };
  if (ir.format !== BOARD_FORMAT) err(`format must be "${BOARD_FORMAT}", got ${JSON.stringify(ir.format)}`);
  if (ir.yAxis !== undefined && ir.yAxis !== 'down' && ir.yAxis !== 'up') err(`yAxis must be "down" or "up"`);
  for (const k of Object.keys(ir)) if (!KNOWN_TOP.has(k)) warn(`unknown top-level field "${k}" is ignored`);

  const shape = (s, where) => {
    if (!s || typeof s !== 'object') return err(`${where}: shape missing`);
    if (s.type === 'rect') { if (![s.x, s.y, s.width, s.height].every(finite) || !(s.width > 0) || !(s.height > 0)) err(`${where}: rect needs finite x, y and width, height > 0`); }
    else if (s.type === 'circle') { if (!point(s.center) || !(finite(s.radius) && s.radius > 0)) err(`${where}: circle needs center and radius > 0`); }
    else if (s.type === 'polygon') {
      if (!Array.isArray(s.points) || s.points.length < 3 || !s.points.every(point)) err(`${where}: polygon needs at least 3 finite points`);
      for (const [h, hole] of (s.holes ?? []).entries()) if (!Array.isArray(hole) || hole.length < 3 || !hole.every(point)) err(`${where}: hole ${h} needs at least 3 finite points`);
    } else err(`${where}: unknown shape type ${JSON.stringify(s.type)}`);
  };

  // Board
  const board = ir.board;
  let boardSides = SIDES;
  if (!board || typeof board !== 'object') err('board is required');
  else {
    if (!Array.isArray(board.outline) || !board.outline.length) err('board.outline must contain at least one polygon');
    else board.outline.forEach((o, k) => {
      if (!Array.isArray(o.outer) || o.outer.length < 3 || !o.outer.every(point)) err(`board.outline[${k}].outer needs at least 3 finite points`);
      (o.holes ?? []).forEach((h, j) => { if (!Array.isArray(h) || h.length < 3 || !h.every(point)) err(`board.outline[${k}].holes[${j}] needs at least 3 finite points`); });
    });
    if (board.sides !== undefined) {
      if (!Array.isArray(board.sides) || !board.sides.length || !board.sides.every((s) => SIDES.includes(s))) err('board.sides must be a non-empty subset of ["top", "bottom"]');
      else boardSides = board.sides;
    }
  }

  // Nets
  const nets = new Map();
  if (!Array.isArray(ir.nets)) err('nets must be an array');
  else ir.nets.forEach((n, k) => {
    if (typeof n?.name !== 'string' || !n.name) return err(`nets[${k}]: name is required`);
    if (nets.has(n.name)) err(`duplicate net "${n.name}"`);
    nets.set(n.name, n);
    if (n.class !== undefined && !NET_CLASSES.includes(n.class)) err(`net "${n.name}": class must be one of ${NET_CLASSES.join(', ')}`);
    if (n.priority !== undefined && !(finite(n.priority) && n.priority >= 0 && n.priority <= 100)) err(`net "${n.name}": priority must be within 0..100`);
  });

  // Regions
  const regions = new Map();
  for (const [k, r] of (ir.regions ?? []).entries()) {
    if (typeof r?.id !== 'string') { err(`regions[${k}]: id is required`); continue; }
    if (regions.has(r.id)) err(`duplicate region "${r.id}"`);
    regions.set(r.id, r);
    shape(r.shape, `region "${r.id}"`);
    if (r.shape && r.shape.type !== 'rect') warn(`region "${r.id}": only rect regions are used by the engine yet; its bounding box is used`);
  }
  for (const [k, ko] of (ir.keepouts ?? []).entries()) {
    shape(ko?.shape, `keepouts[${k}]`);
    if (ko?.sides !== undefined && (!Array.isArray(ko.sides) || !ko.sides.every((x) => SIDES.includes(x)))) err(`keepouts[${k}]: sides must be a subset of ["top", "bottom"]`);
    if (ko?.maxHeight != null && !(finite(ko.maxHeight) && ko.maxHeight >= 0)) err(`keepouts[${k}]: maxHeight must be a number >= 0 or null`);
    if (ko?.rules?.vias) warn(`keepouts[${k}]: rules.vias is not used by the engine yet`);
  }

  // Footprints
  const footprints = new Map(), usedNets = new Set();
  if (!Array.isArray(ir.footprints)) err('footprints must be an array');
  else ir.footprints.forEach((f, k) => {
    if (typeof f?.id !== 'string' || !f.id) return err(`footprints[${k}]: id is required`);
    const at = `footprint "${f.id}"`;
    if (footprints.has(f.id)) err(`duplicate footprint "${f.id}"`);
    footprints.set(f.id, f);
    const padIds = new Set();
    for (const [j, p] of (f.pads ?? []).entries()) {
      const pw = `${at} pad ${p?.id ?? j}`;
      if (typeof p?.id !== 'string') err(`${at} pads[${j}]: id is required`);
      else if (padIds.has(p.id)) err(`${at}: duplicate pad "${p.id}"`);
      padIds.add(p?.id);
      if (!point(p?.at)) err(`${pw}: at must be [x, y]`);
      if (!Array.isArray(p?.size) || p.size.length !== 2 || !p.size.every((v) => finite(v) && v > 0)) err(`${pw}: size must be [w, h] with w, h > 0`);
      if (p?.shape !== undefined && !PAD_SHAPES.includes(p.shape)) err(`${pw}: shape must be one of ${PAD_SHAPES.join(', ')}`);
      if (p?.shape === 'polygon' && (!Array.isArray(p.points) || p.points.length < 3 || !p.points.every(point))) err(`${pw}: polygon pads need at least 3 points`);
      if (p?.type !== undefined && !PAD_TYPES.includes(p.type)) err(`${pw}: type must be one of ${PAD_TYPES.join(', ')}`);
      if (p?.rotation !== undefined && !finite(p.rotation)) err(`${pw}: rotation must be a number`);
      if (p?.net != null) { if (!nets.has(p.net)) err(`${pw}: unknown net "${p.net}"`); usedNets.add(p.net); }
    }
    if (f.courtyard) shape(f.courtyard, `${at} courtyard`);
    if (f.height !== undefined && !(finite(f.height) && f.height >= 0)) err(`${at}: height must be a number >= 0`);
    if (f.region != null) { if (!regions.has(f.region)) err(`${at}: unknown region "${f.region}"`); else warn(`${at}: footprint regions are not used by the engine yet (use a module region)`); }
    const pl = f.placement;
    if (pl) {
      if (![pl.x, pl.y].every(finite) || (pl.rotation !== undefined && !finite(pl.rotation))) err(`${at}: placement needs finite x, y and rotation`);
      if (pl.side !== undefined && !SIDES.includes(pl.side)) err(`${at}: placement.side must be "top" or "bottom"`);
      if (f.fixed && !Number.isInteger((pl.rotation ?? 0) / 90)) warn(`${at}: fixed at ${pl.rotation}°; the angle is baked into local coordinates and returned unchanged`);
    } else {
      if (f.fixed) err(`${at}: fixed footprints need a placement`);
      else warn(`${at}: no placement, the engine starts it at a random position`);
    }
    if (f.allowedSides !== undefined) {
      if (!Array.isArray(f.allowedSides) || !f.allowedSides.length) err(`${at}: allowedSides must be a non-empty array`);
      else {
        for (const s of f.allowedSides) if (!boardSides.includes(s)) err(`${at}: allowedSides contains "${s}", which is not in board.sides`);
        if (pl && !f.allowedSides.includes(pl.side ?? 'top')) err(`${at}: placement.side "${pl.side ?? 'top'}" is not in allowedSides`);
      }
    }
    if (f.allowedRotations !== undefined) {
      if (!Array.isArray(f.allowedRotations) || !f.allowedRotations.length || !f.allowedRotations.every(finite)) err(`${at}: allowedRotations must be a non-empty array of numbers`);
      else if (f.allowedRotations.some((r) => !Number.isInteger(r / 90))) warn(`${at}: allowedRotations other than multiples of 90° are ignored`);
    }
  });

  // Modules
  const moduleIds = new Set(), moduleOf = new Map();
  for (const [k, m] of (ir.modules ?? []).entries()) {
    if (typeof m?.id !== 'string') { err(`modules[${k}]: id is required`); continue; }
    if (moduleIds.has(m.id)) err(`duplicate module "${m.id}"`);
    moduleIds.add(m.id);
    if (!Array.isArray(m.footprints)) { err(`module "${m.id}": footprints must be an array`); continue; }
    for (const id of m.footprints) {
      if (!footprints.has(id)) err(`module "${m.id}": unknown footprint "${id}"`);
      else if (moduleOf.has(id)) err(`module "${m.id}": footprint "${id}" is already in module "${moduleOf.get(id)}"`);
      else moduleOf.set(id, m.id);
    }
    if (m.side !== undefined && !['auto', 'top', 'bottom'].includes(m.side)) err(`module "${m.id}": side must be "auto", "top" or "bottom"`);
    if (m.region != null && !regions.has(m.region)) err(`module "${m.id}": unknown region "${m.region}"`);
    if (m.cohesion !== undefined && !(finite(m.cohesion) && m.cohesion >= 0)) err(`module "${m.id}": cohesion must be a number >= 0`);
  }

  // Rules
  const rules = ir.rules ?? {};
  if (rules.componentClearance !== undefined && !(finite(rules.componentClearance) && rules.componentClearance >= 0)) err('rules.componentClearance must be a number >= 0');
  if (rules.edgeClearance !== undefined && !(finite(rules.edgeClearance) && rules.edgeClearance >= 0)) err('rules.edgeClearance must be a number >= 0');
  for (const k of ['track', 'via']) if (rules[k] !== undefined) warn(`rules.${k} is not used by the engine yet`);

  for (const name of nets.keys()) if (!usedNets.has(name)) warn(`net "${name}" is declared but no pad uses it`);
  return { errors, warnings };
}

/** Throws with every problem listed when the IR has errors; returns the warnings. */
export function assertValidBoardIR(ir) {
  const { errors, warnings } = validateBoardIR(ir);
  if (errors.length) throw new Error(`Board IR has ${errors.length} error(s):\n  ${errors.join('\n  ')}`);
  return warnings;
}
