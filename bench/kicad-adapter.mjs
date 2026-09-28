// KiCad adapter for the benchmark scripts; the implementation lives in src/kicad/adapter.js.
import { parseKicadBoard } from '../src/kicad/adapter.js';
export * from '../src/kicad/adapter.js';

/** Returns parse(text, name). The parser is vendored in src/kicad/, `placerRoot` is unused. */
export async function loadKicadParser(_placerRoot) { return parseKicadBoard; }
