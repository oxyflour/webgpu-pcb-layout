// One agent session placing one board with the pcb tool: dsh (DeepSeek Flash, headless; default)
// or --agent claude (Claude Code `claude -p`, --model default claude-haiku-5-5)
// or --agent codex (Codex `codex exec`, --model default gpt-6-luna).
// node harness/agent/run-agent.mjs --board pico --prompt harness/prompts/v1.md --minutes 20 --places 8 --out DIR [--seed 1] [--agent claude|codex --model M]
// The gateway runs here, outside the dsh sandbox (which cannot spawn docker); the agent's
// `pcb.cmd` only sends JSON requests. The trajectory is saved as events.jsonl + tools.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { initSession, callTool } from './session.mjs';
import { loadBoard, evaluateRobust, legalOk, exactRouting } from '../lib/board.mjs';
import { HARNESS_ROOT } from '../lib/env.mjs';

const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const agent = arg('agent', 'dsh'), model = arg('model', { claude: 'claude-haiku-5-5', codex: 'gpt-6-luna' }[agent] ?? 'deepseek-flash');
const board = arg('board', 'pico'), minutes = Number(arg('minutes', 20)), places = Number(arg('places', 8)), seed = Number(arg('seed', 1));
const promptFile = path.resolve(arg('prompt', path.join(HARNESS_ROOT, 'prompts/v1.md')));
const out = path.resolve(arg('out', `harness/results/agent-${board}-${Date.now()}`));
const dsh = process.env.DSH_EXE ?? path.join(os.homedir(), 'AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd');
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw new Error('Output already has a run; choose a new --out');
const sessionDir = path.join(out, 'session');
await initSession(sessionDir, { board, seed });
// Agent workspace outside the repo so it cannot read the harness, boards or human layout.
const ws = path.join(os.homedir(), 'agent-ws', `cypress-${board}-${crypto.randomUUID()}`);
fs.mkdirSync(ws, { recursive: true });

const token = crypto.randomUUID();
let busy = false, placeCalls = 0, checkCalls = 0;
const MAX_CHECKS = 60; // acc v4 rep1 burned 7 min in a scripted loop of ~250 checks
const gateway = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end('{"error":"bad credential"}'); return; }
  let body = '';
  try {
    for await (const chunk of req) { body += chunk; if (body.length > 1 << 20) throw new Error('request too large'); }
    const { command, input } = JSON.parse(body);
    if (busy) throw new Error('another pcb command is still running; run commands one at a time');
    const costly = command === 'place';
    if (costly && placeCalls >= places) throw new Error(`place budget (${places}) used up: inspect/status and submit the best candidate`);
    if (costly) placeCalls++;
    if (command === 'check' && ++checkCalls > MAX_CHECKS) throw new Error(`check limit (${MAX_CHECKS}) reached: decide with what you have and run place`);
    busy = true;
    try {
      const result = await callTool(sessionDir, command, input);
      // A failed place (no candidate) does not use up the place budget.
      if (costly && !result.candidate) { placeCalls--; result.note = 'this failed place did not count against the budget'; }
      // Sessions stopped after 8-10 of 20 minutes believing time was up (v7/v8 k60): report the real budget.
      if (result && typeof result === 'object' && !Array.isArray(result)) result.budget = { minutesUsed: Math.round((Date.now() - start) / 6000) / 10, minutesLeft: Math.max(0, Math.round((minutes * 60000 - (Date.now() - start)) / 6000) / 10), placeCallsLeft: places - placeCalls };
      res.end(JSON.stringify(result));
    } finally { busy = false; }
  } catch (e) { res.end(JSON.stringify({ error: e.message })); }
});
await new Promise((r) => gateway.listen(0, '127.0.0.1', r));

const base = fs.readFileSync(promptFile, 'utf8');
const task = `${base}\n\n# This session\nBoard: ${board}. Budget: at most ${places} \`pcb place\` calls and ${minutes} minutes in total. Every shell command must finish within 3 minutes (one place takes about 35-90 s).\nRun the tool as \`.\\pcb.cmd <command> ...\` from the current directory. Write plan files into the current directory.\n`;
// Claude Code runs its Bash tool in a POSIX shell: same tool as ./pcb.
const taskText = agent === 'claude' ? task.replaceAll('.\\pcb.cmd', './pcb') : task;
fs.writeFileSync(path.join(ws, 'TASK.md'), taskText);
fs.writeFileSync(path.join(out, 'prompt.md'), taskText);
fs.writeFileSync(path.join(ws, 'pcb.cmd'), `@echo off\r\nset "PCB_TOOL_URL=http://127.0.0.1:${gateway.address().port}"\r\nset "PCB_TOOL_TOKEN=${token}"\r\nnode "${path.join(HARNESS_ROOT, 'agent/cli.mjs')}" %*\r\n`);
if (agent === 'claude') fs.writeFileSync(path.join(ws, 'pcb'), `#!/bin/sh\nPCB_TOOL_URL="http://127.0.0.1:${gateway.address().port}" PCB_TOOL_TOKEN="${token}" exec node "${path.join(HARNESS_ROOT, 'agent/cli.mjs').replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
const patch = path.join(out, 'dsh-patch.yml');
fs.writeFileSync(patch, `- id: agent\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n${['tool-web', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'tool-skill', 'tool-jobs', 'tool-user-questions'].map((id) => `- id: ${id}\n  disabled: true`).join('\n')}\n- id: pwsh-sandbox\n  config:\n    timeoutMs: 175000\n    maxTimeoutMs: 175000\n- id: tool-pwsh\n  config:\n    enableRunInBackground: false\n    promoteOnTimeout: false\n`);
const gitHead = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HARNESS_ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })();
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ board, seed, minutes, places, prompt: promptFile, promptSha256: crypto.createHash('sha256').update(taskText).digest('hex'), workspace: ws, model, transport: { claude: 'claude -p (restricted)', codex: 'codex exec (workspace-write sandbox)' }[agent] ?? 'dsh headless', gitHead, start: new Date().toISOString() }, null, 1));

const start = Date.now(), active = new Map();
let reason = null, buf = '', stderr = '', maxToolS = 0, exited = false;
// Claude Code: restricted mode (no user/project settings, file tools confined to the workspace),
// shell limited to the pcb tool and the agent's own node / python scripts, everything else denied
// without a prompt; Bash timeout 175 s like the dsh sandbox.
const claudeArgs = ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config', '--no-session-persistence',
  '--tools', 'Bash,Read,Write,Edit,Glob,Grep', '--allowedTools', 'Bash(./pcb:*)', 'Bash(node:*)', 'Bash(python:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
// Codex: workspace-write sandbox (writes confined to the workspace) with network on so .\pcb.cmd
// reaches the local gateway; user config, rules and session files ignored.
const codexArgs = ['exec', '--json', '-m', model, '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'approval_policy="never"', '-c', 'windows.sandbox="unelevated"', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-C', ws, '-'];
const child = agent === 'claude'
  ? spawn('claude', claudeArgs, { cwd: ws, env: { ...process.env, BASH_DEFAULT_TIMEOUT_MS: '175000', BASH_MAX_TIMEOUT_MS: '175000' }, windowsHide: true, shell: false })
  : agent === 'codex' ? spawn('cmd.exe', ['/d', '/s', '/c', 'codex', ...codexArgs], { cwd: ws, windowsHide: true })
  : spawn('cmd.exe', ['/d', '/s', '/c', `""${dsh}" --patch "${patch}" --profile headless --json -"`], { cwd: ws, env: { ...process.env, DSH_PERMISSION_MODE: 'workspace-write' }, windowsVerbatimArguments: true, windowsHide: true });
// Claude Code stream-json -> the dsh event shapes used below (tool_call / tool_result / text / final).
const normalize = (ev) => {
  if (agent === 'codex') {
    // codex exec --json: item.started / item.completed (command_execution, file_change, agent_message), turn.completed.
    const it = ev.item ?? {};
    if (ev.type === 'item.started' && it.type === 'command_execution') return [{ type: 'tool_call', callId: it.id, tool: 'shell', input: { command: it.command } }];
    if (ev.type === 'item.completed' && it.type === 'command_execution') return [{ type: 'tool_result', callId: it.id, exitCode: it.exit_code }];
    if (ev.type === 'item.completed' && it.type === 'file_change') return [{ type: 'tool_call', callId: it.id, tool: 'file_change', input: { changes: it.changes } }, { type: 'tool_result', callId: it.id }];
    if (ev.type === 'item.completed' && it.type === 'agent_message') return [{ type: 'text', text: it.text }];
    if (ev.type === 'turn.completed') return [{ type: 'final', text: 'turn completed', usage: ev.usage }];
    if (ev.type === 'error' || ev.type === 'turn.failed') return [{ type: 'text', text: `codex ${ev.type}: ${JSON.stringify(ev).slice(0, 300)}` }];
    return [];
  }
  if (agent !== 'claude') return [ev];
  const content = ev.message?.content ?? [];
  if (ev.type === 'assistant') return content.map((c) => c.type === 'tool_use' ? { type: 'tool_call', callId: c.id, tool: c.name, input: c.input } : c.type === 'text' ? { type: 'text', text: c.text } : null).filter(Boolean);
  if (ev.type === 'user') return content.filter((c) => c.type === 'tool_result').map((c) => ({ type: 'tool_result', callId: c.tool_use_id }));
  if (ev.type === 'result') return [{ type: 'final', text: ev.result, usage: ev.usage, costUsd: ev.total_cost_usd, turns: ev.num_turns }];
  return [];
};
const stop = (why) => { if (reason || exited) return; reason = why; console.log(`stop: ${why}`); try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {} };
// Reads of the harness, boards or result dirs would leak the human layout.
const forbidden = /cypress-layout|webgpu-layout|webgpu_pcb_placer|kicad_pcb|session\.json|candidates[\\/]|agent[\\/]cli\.mjs|PCB_TOOL_TOKEN/i;
child.stdout.on('data', (bytes) => {
  buf += bytes.toString('utf8'); let k;
  while ((k = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1); if (!line) continue;
    let raw; try { raw = JSON.parse(line); } catch { raw = { type: 'raw', text: line }; }
    if (agent !== 'dsh') fs.appendFileSync(path.join(out, `${agent}-stream.jsonl`), JSON.stringify({ t: Date.now() - start, ...raw }) + '\n');
    for (let ev of normalize(raw)) {
    ev = { t: Date.now() - start, ...ev };
    fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify(ev) + '\n');
    if (ev.type === 'tool_call') {
      active.set(ev.callId, Date.now());
      console.log(`[${(ev.t / 1000).toFixed(0)}s] ${ev.tool}: ${JSON.stringify(ev.input).slice(0, 200)}`);
      if (forbidden.test(JSON.stringify(ev.input))) stop('audit: forbidden path in tool input');
    }
    if (ev.type === 'tool_result') { const t = active.get(ev.callId); if (t) maxToolS = Math.max(maxToolS, (Date.now() - t) / 1000); active.delete(ev.callId); }
    if (ev.type === 'text' || ev.type === 'final') console.log(`[${(ev.t / 1000).toFixed(0)}s] ${ev.type}: ${String(ev.text).slice(0, 300)}`);
    }
  }
});
child.stderr.on('data', (b) => { stderr += b.toString(); });
child.stdin.end(taskText);
const timer = setInterval(() => { if (Date.now() - start > minutes * 60000) stop('session deadline'); for (const t of active.values()) if (Date.now() - t > 178000) stop('tool call over 3 minutes'); }, 500);
const code = await new Promise((r) => { child.on('error', () => { exited = true; r(-1); }); child.on('close', (c) => { exited = true; r(c); }); });
clearInterval(timer);
gateway.closeAllConnections(); await new Promise((r) => gateway.close(r));
while (busy) await new Promise((r) => setTimeout(r, 50));

const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'));
const chosen = state.submitted ?? state.best;
let final = null;
if (chosen) {
  // Independent re-evaluation of the chosen layout on a fresh problem (no agent locks).
  // The layout is written first so a killed evaluation can be redone from disk; routing stops
  // at a 60 min cap (reported as routeConverged=false).
  const b = loadBoard(board), saved = JSON.parse(fs.readFileSync(path.join(sessionDir, 'candidates', `${chosen}.json`), 'utf8'));
  fs.writeFileSync(path.join(out, 'final-layout.json'), JSON.stringify(saved.layout));
  const t0 = performance.now();
  // Median over grid phases (evaluateRobust): exact routing per phase, phases in parallel workers.
  const m = await evaluateRobust(b, saved.layout, { deadlineS: 3600, ...exactRouting() });
  final = { candidate: chosen, viaSubmit: !!state.submitted, legal: legalOk(m), routeSeconds: (performance.now() - t0) / 1000, ...m };
  fs.writeFileSync(path.join(out, 'final-eval.json'), JSON.stringify(final, null, 1));
}
fs.writeFileSync(path.join(out, 'stderr.txt'), stderr);
fs.cpSync(ws, path.join(out, 'agent-workspace'), { recursive: true });
for (const w of ['pcb.cmd', 'pcb']) fs.rmSync(path.join(out, 'agent-workspace', w), { force: true });
const toolsFile = path.join(sessionDir, 'tools.jsonl'), tools = (fs.existsSync(toolsFile) ? fs.readFileSync(toolsFile, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'result');
const summary = { board, seed, stopReason: reason ?? 'agent finished', exitCode: code, minutes: (Date.now() - start) / 60000, placeCalls: state.placeCalls, maxShellToolS: maxToolS, maxPcbToolS: Math.max(0, ...tools.map((t) => t.seconds)),
  errors: tools.filter((t) => t.result?.error).map((t) => `${t.command}: ${t.result.error}`).slice(0, 20), target: state.target, final,
  candidates: Object.values(state.candidates).map((c) => ({ id: c.id, from: c.from, planned: c.planned, clean: c.metrics.clean, vias: c.metrics.vias, hpwlMm: c.metrics.hpwlMm })) };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ board, final: final && { clean: final.clean, vias: final.vias, hpwlMm: final.hpwlMm, legal: final.legal }, target: state.target, stop: summary.stopReason, places: state.placeCalls }));
