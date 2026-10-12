import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs } from '../src/cli/claude-args';
import { startProcessRun } from '../src/cli/process-run';
import { createHookChannel } from '../src/cli/hook-channel';
import { writeHookSettings } from '../src/cli/hook-settings';
import { HookAdapter } from '../src/cli/hook-adapter';
import { RunStore, formatTree } from '../src/core/store';

const [mode, prompt] = process.argv.slice(2);
if ((mode !== 'panel' && mode !== 'hooks') || !prompt) {
  console.error('uso: tsx scripts/m0-demo.ts <panel|hooks> "<prompt>"');
  process.exit(1);
}
const cwd = path.resolve('fixtures/project');

if (mode === 'panel') {
  const store = new RunStore({ runId: 'demo', source: 'panel', cwd });
  const run = startProcessRun('demo', {
    command: 'claude', args: buildClaudeArgs({ prompt, permissionMode: 'acceptEdits' }), cwd,
  }, (e) => { store.apply(e); console.log(formatTree(store), '\n'); });
  process.on('SIGINT', () => run.cancel());
  const r = await run.done;
  console.log('FINAL\n' + formatTree(store), '\nsessionId:', store.run.sessionId, '\nexit:', r.exitCode, r.spawnError ?? '');
} else {
  // Modo hooks via claude -p (equivalente automatizável); a sessão interativa não foi validada (ver findings).
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visor-demo-'));
  const store = new RunStore({ runId: 'demo', source: 'terminal', cwd });
  const adapter = new HookAdapter('demo');
  const channel = await createHookChannel((m) => {
    for (const e of adapter.push(m.payload)) store.apply(e);
    console.log(formatTree(store), '\n');
  });
  const settings = writeHookSettings(tmp, path.resolve('hooks/relay.mjs'));
  const child = spawn('claude', buildClaudeArgs({ prompt, permissionMode: 'acceptEdits', settingsFile: settings }), {
    cwd, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, VISOR_PIPE: channel.path, VISOR_RUN_ID: 'demo' },
  });
  await new Promise((r) => child.on('close', r));
  await new Promise((r) => setTimeout(r, 300));
  for (const e of adapter.end(false)) store.apply(e);
  await channel.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log('FINAL\n' + formatTree(store));
}
