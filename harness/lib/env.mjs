// Locations of the adapter code, the KiCad boards and other machine-specific resources.
//   layoutRoot   adapter code (src/, bench/): default vendor/webgpu-layout-code in this repository
//   placerRoot   checkout with the registered KiCad boards (bench/kicad-cases.mjs paths); needed only
//                for those boards (boards in harness/boards.json carry their own paths)
//   uiBoards     board JSON files of the web editor (harness/ui/server.mjs, UI tests)
//   cypressContainer, freeroutingDir: only for the older Cypress / FreeRouting experiments
// Each value comes from an environment variable, else harness/local.json (git-ignored, see
// harness/local.example.json); nothing machine-specific is hard-coded. A missing required value
// throws with the name of the setting.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HARNESS_ROOT = path.resolve(import.meta.dirname, '..');
export const REPO_ROOT = path.resolve(HARNESS_ROOT, '..');
const LOCAL = (() => { const f = path.join(HARNESS_ROOT, 'local.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; })();
const setting = (key, envName, fallback = null) => { const v = process.env[envName] ?? LOCAL[key] ?? fallback; return v == null ? null : path.isAbsolute(v) ? v : path.resolve(REPO_ROOT, v); };
export function required(value, key, envName, why) {
  if (value == null) throw new Error(`${key} is not set: ${why}. Set ${envName} or "${key}" in harness/local.json (see harness/local.example.json).`);
  return value;
}

export const LAYOUT_ROOT = setting('layoutRoot', 'CYPRESS_LAYOUT_ROOT', path.join(REPO_ROOT, 'vendor', 'webgpu-layout-code'));
export const PLACER_ROOT = setting('placerRoot', 'CYPRESS_PLACER_ROOT');
export const UI_BOARDS = setting('uiBoards', 'UI_BOARDS');
export const FREEROUTING_DIR = setting('freeroutingDir', 'FREEROUTING_DIR');
export const CONTAINER = process.env.CYPRESS_CONTAINER ?? LOCAL.cypressContainer ?? null;

export const lib = (rel) => import(pathToFileURL(path.join(LAYOUT_ROOT, rel)).href);
