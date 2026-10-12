// Evaluation board of a file loaded in the editor ({name, text}: .kicad_pcb text or IR JSON), for the
// server's tool-place / tool-route. A file registered in boards.json (same sha256) is loadBoard's
// board; an IR of a registered board (same name, e.g. the editor's sample librem5.board.json) the
// uploaded IR with the registered body margin; any other file the uploaded IR with the default margin.
import { parseKicadBoard, kicadToIR } from '../../core/src/kicad/adapter.js';
import { loadBoard, boardFromIR, registeredBoardOf, bodyMargin } from '../lib/board.mjs';

export function editorBoard(name, text) {
  const ir = /\.kicad_pcb$/i.test(name) || text.trimStart().startsWith('(kicad_pcb') ? kicadToIR(parseKicadBoard(text, name), name.replace(/\.kicad_pcb$/i, '')) : JSON.parse(text);
  const reg = registeredBoardOf(text, ir.name), registered = reg?.name ?? null;
  const b = reg?.exact ? loadBoard(registered) : boardFromIR(registered ?? ir.name ?? name, ir);
  return { b, registered, exact: !!reg?.exact, bodyMargin: registered ? bodyMargin(registered) ?? null : null };
}
