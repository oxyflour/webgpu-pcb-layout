// Repository paths and machine-specific locations.
//   CORE_ROOT    core/ in this repository: problem model, KiCad / IR import, legalizer, router
//   boardsRoot   checkout with the benchmark KiCad boards (core/bench/kicad-cases.mjs paths); needed only
//                for those boards (boards in harness/boards.json carry their own paths)
//   uiBoards     board JSON files of the web editor (harness/ui/server.mjs, UI tests)
//   freeroutingDir  FreeRouting jar (experiments/archive/freerouting.mjs only)
// Each location comes from an environment variable, else harness/local.json (git-ignored, see
// harness/local.example.json). Nothing machine-specific is hard-coded; a missing required location
// throws with the name of the setting.
import fs from 'node:fs';
import path from 'node:path';

export const HARNESS_ROOT = path.resolve(import.meta.dirname, '..');
export const REPO_ROOT = path.resolve(HARNESS_ROOT, '..');
export const CORE_ROOT = path.join(REPO_ROOT, 'core');
const LOCAL = (() => { const f = path.join(HARNESS_ROOT, 'local.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; })();
// First set value of the environment variables, then of the local.json keys (old names last).
const setting = (envNames, keys) => { const v = [...envNames.map((e) => process.env[e]), ...keys.map((k) => LOCAL[k])].find((x) => x != null && x !== ''); return v == null ? null : path.resolve(REPO_ROOT, v); };
export function required(value, key, envName, why) {
  if (value == null) throw new Error(`${key} is not set: ${why}. Set ${envName} or "${key}" in harness/local.json (see harness/local.example.json).`);
  return value;
}

export const BOARDS_ROOT = setting(['PCB_BOARDS_ROOT', 'CYPRESS_PLACER_ROOT'], ['boardsRoot', 'placerRoot']);
export const UI_BOARDS = setting(['UI_BOARDS'], ['uiBoards']);
export const FREEROUTING_DIR = setting(['FREEROUTING_DIR'], ['freeroutingDir']);
