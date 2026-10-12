import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHookChannel, type HookMessage } from '../../src/cli/hook-channel';
import { buildHookSettings, writeHookSettings, HOOK_EVENTS } from '../../src/cli/hook-settings';

const relay = path.resolve('hooks/relay.mjs');

function runRelay(env: Record<string, string>, input: string) {
  return spawnSync(process.execPath, [relay], {
    input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000,
  });
}

describe('hook channel + relay', () => {
  it('entrega ao canal a mensagem enviada pelo relay', async () => {
    const got: HookMessage[] = [];
    const ch = await createHookChannel((m) => got.push(m));
    const r = runRelay({ VISOR_PIPE: ch.path, VISOR_RUN_ID: 'r9' }, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's' }));
    await new Promise((res) => setTimeout(res, 200));
    await ch.close();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(got).toEqual([{ runId: 'r9', payload: { hook_event_name: 'SessionStart', session_id: 's' } }]);
  });

  it('sem VISOR_PIPE sai 0 e sem stdout', () => {
    const r = runRelay({ VISOR_PIPE: '', VISOR_RUN_ID: 'r9' }, '{"a":1}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('canal inexistente sai 0, sem stdout, rapidamente', () => {
    const t0 = Date.now();
    const r = runRelay({ VISOR_PIPE: path.join(os.tmpdir(), 'visor-nao-existe.sock'), VISOR_RUN_ID: 'r9' }, '{"a":1}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('stdin que não é JSON sai 0 sem enviar nada', async () => {
    const got: HookMessage[] = [];
    const ch = await createHookChannel((m) => got.push(m));
    const r = runRelay({ VISOR_PIPE: ch.path, VISOR_RUN_ID: 'r9' }, 'isso não é json');
    await new Promise((res) => setTimeout(res, 150));
    await ch.close();
    expect(r.status).toBe(0);
    expect(got).toEqual([]);
  });

  it('o canal ignora linhas inválidas sem cair', async () => {
    const got: HookMessage[] = [];
    const ch = await createHookChannel((m) => got.push(m));
    const net = await import('node:net');
    await new Promise<void>((res) => {
      const s = net.connect(ch.path, () => {
        s.write('lixo\n{"runId":1}\n{"runId":"a","payload":{"k":1}}\n', () => { s.end(); res(); });
      });
    });
    await new Promise((res) => setTimeout(res, 150));
    await ch.close();
    expect(got).toEqual([{ runId: 'a', payload: { k: 1 } }]);
  });
});

describe('hook settings', () => {
  it('registra o relay em todos os eventos de HOOK_EVENTS', () => {
    const s = buildHookSettings('/x/relay.mjs', '/opt/node/bin/node') as any;
    for (const ev of HOOK_EVENTS) {
      expect(s.hooks[ev][0].hooks[0]).toEqual({ type: 'command', command: `"/opt/node/bin/node" "/x/relay.mjs"` });
    }
    expect(HOOK_EVENTS).toEqual(expect.arrayContaining(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse']));
  });

  it('por padrão usa o caminho absoluto do node atual, não depende do PATH', () => {
    const s = buildHookSettings('/x/relay.mjs') as any;
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe(`"${process.execPath}" "/x/relay.mjs"`);
  });

  it('escreve o arquivo no diretório pedido', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'visor-set-'));
    const file = writeHookSettings(dir, '/x/relay.mjs');
    expect(path.dirname(file)).toBe(dir);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionStart).toBeDefined();
  });
});
