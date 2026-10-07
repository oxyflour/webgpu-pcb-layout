// Locations of the Cypress adapter checkout, the KiCad boards and the CUDA container.
// The adapter (bench/cypress, src/kicad, router, legalizer) lives in webgpu-layout-code
// branch codex/cypress-official-refresh; see skills/cypress-layout/SKILL.md.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LAYOUT_ROOT = path.resolve(process.env.CYPRESS_LAYOUT_ROOT ?? 'C:/Users/oxyfl/.codex/worktrees/7fa1/webgpu-layout-code');
export const PLACER_ROOT = path.resolve(process.env.CYPRESS_PLACER_ROOT ?? 'C:/Projects/webgpu_pcb_placer');
export const CONTAINER = process.env.CYPRESS_CONTAINER ?? 'codex-cypress-official-20261004';
export const HARNESS_ROOT = path.resolve(import.meta.dirname, '..');
export const REPO_ROOT = path.resolve(HARNESS_ROOT, '..');

export const lib = (rel) => import(pathToFileURL(path.join(LAYOUT_ROOT, rel)).href);
