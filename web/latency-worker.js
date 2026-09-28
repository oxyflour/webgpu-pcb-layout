// Worker for web/latency.html: owns the WebGPU device and runs the session scenarios
// off the main thread, the way the interactive editor will.
import { requestWebGpuDevice } from '../src/gpu/device.js';
import { irToProblem } from '../src/ir/to-problem.js';
import { normalizeProblem } from '../src/problem.js';
import { runSessionScenarios, gpuRoundTrip, cpuProbe } from '../bench/session-scenarios.js';

let device = null;
const post = (type, data) => self.postMessage({ type, ...data });

self.onmessage = async ({ data }) => {
  try {
    if (data.type !== 'run') return;
    if (!device) {
      device = await requestWebGpuDevice();
      device.lost.then((info) => post('error', { message: `GPU device lost: ${info.message}` }));
      const info = device.adapterInfo ?? {};
      post('device', { adapter: [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'unknown adapter' });
    }
    const roundTrip = await gpuRoundTrip(device);
    post('roundTrip', { roundTrip, cpuProbeMs: cpuProbe() });
    for (const name of data.boards) {
      post('status', { message: `${name}: loading` });
      const ir = await (await fetch(`./boards/${name}.board.json`)).json();
      const adapted = irToProblem(ir, { preplace: true, sides: 'ir' });
      const problem = normalizeProblem(adapted.input);
      post('status', { message: `${name}: ${problem.components.length} parts, running` });
      await runSessionScenarios({
        name, problem, layout: adapted.originalLayout, device, budgets: data.budgets, drags: data.drags, modes: data.modes,
        onRow: (row) => post('row', { row }),
      });
    }
    post('done', {});
  } catch (e) {
    post('error', { message: e?.stack ?? String(e) });
  }
};
