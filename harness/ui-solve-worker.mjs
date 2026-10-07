// Runs one blocking Cypress solve off the UI server's event loop.
import { parentPort, workerData } from 'node:worker_threads';
process.env.CYPRESS_RUNTIME = workerData.runtime;
const { solve } = await import('./cypress.mjs');
try {
  const { adapted, initial, seed, dir, clearance, container } = workerData;
  parentPort.postMessage({ ok: true, ...solve(adapted, initial, { seed, dir, clearance, container }) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
