// Whole-board layout for the editor's 自动布局, exactly the evaluation's no-agent tool layout
// (experiments/noagent.mjs, agent `place` without a plan): start layout -> 0.1 mm legalizer ->
// detail pass (toolDetailBudget, native/detail.cpp when built) -> legalizer, on the evaluation board
// of the file (editor-board.mjs).
// Run by server.mjs in a child process (the native detail pass blocks for up to 60 s).
//   node harness/ui/tool-place.mjs <request.json>   request {name, text, seed}; prints the result JSON
import fs from 'node:fs';
import { legalize } from '../lib/board.mjs';
import { editorBoard } from './editor-board.mjs';
import { startLayout } from '../lib/init.mjs';
import { detailPlace, toolDetailBudget } from '../lib/detail.mjs';

const { name, text, seed = 1 } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t0 = performance.now(), ms = (t) => Math.round(performance.now() - t);
const { b, registered, exact, bodyMargin } = editorBoard(name, text);
const tLoad = ms(t0);
let t = performance.now();
const init = startLayout(b, {}, { seed }), tStart = ms(t);
t = performance.now();
const leg = legalize(b, init), tLegal = ms(t);
const d = detailPlace(b, leg.layout, { ...toolDetailBudget(b), seed });
t = performance.now();
const fin = legalize(b, d.layout), tLegal2 = ms(t);
process.stdout.write(JSON.stringify({
  board: registered, exact, bodyMargin,
  ids: b.p.components.map((c) => c.id), layout: fin.layout,
  timing: { loadMs: tLoad, startMs: tStart, legalizeMs: tLegal, detail: { evals: d.evals, accepted: d.accepted, seconds: d.seconds, engine: d.engine ?? 'js' }, legalize2Ms: tLegal2, legalFailed: fin.failed, totalMs: ms(t0) },
}));
