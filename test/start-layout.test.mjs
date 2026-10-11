import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UI_BOARDS } from '../harness/lib/env.mjs';
import path from 'node:path';
import { createStartLayout } from '../harness/lib/start-layout.mjs';

import { irToProblem } from '../core/src/ir/to-problem.js';
import { normalizeProblem, worldPin, rotatedSize } from '../core/src/problem.js';
// The web editor's sample board (uiBoards / UI_BOARDS); skipped when not configured.
const boardFile = UI_BOARDS && path.join(UI_BOARDS, 'edk.board.json');
const skip = !(boardFile && fs.existsSync(boardFile)) && 'uiBoards / UI_BOARDS not set or edk.board.json missing';

test('editor worker start layout: fixed parts kept, movable parts inside the board, deterministic per seed', { skip }, () => {
  // As in ui/editor-worker.js load(), mode 'auto'.
  const ir = JSON.parse(fs.readFileSync(boardFile, 'utf8')), adapted = irToProblem(ir, { preplace: true, sides: 'ir' });
  const problem = normalizeProblem(adapted.input), { startLayout } = createStartLayout({ worldPin, rotatedSize });
  const b = { p: problem, a: { ...adapted, ir } }, L = startLayout(b, {}, { seed: 1 });
  assert.equal(L.length, problem.components.length);
  problem.components.forEach((c, i) => {
    if (c.fixed) return assert.deepEqual(L[i], { ...c.fixed }, `${c.id} fixed pose kept`);
    const [w, h] = rotatedSize(c, L[i].rotation);
    assert.ok([0, 1, 2, 3].includes(L[i].rotation), `${c.id} quarter turn`);
    assert.ok(L[i].x >= w / 2 - 1e-9 && L[i].x <= problem.canvas.width - w / 2 + 1e-9 && L[i].y >= h / 2 - 1e-9 && L[i].y <= problem.canvas.height - h / 2 + 1e-9, `${c.id} inside the board`);
  });
  // Connected parts are pulled off the board centre (the start of every movable part).
  const moved = problem.components.filter((c, i) => !c.fixed && Math.hypot(L[i].x - problem.canvas.width / 2, L[i].y - problem.canvas.height / 2) > 2).length;
  assert.ok(moved > 0.5 * problem.components.filter((c) => !c.fixed).length, `most movable parts placed by connectivity (${moved})`);
  assert.deepEqual(startLayout(b, {}, { seed: 1 }), L, 'same seed, same layout');
  assert.notDeepEqual(startLayout(b, {}, { seed: 2 }), L, 'seed changes the jitter');
});
