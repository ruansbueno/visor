import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProcessRun } from '../../src/cli/process-run';
import { RunStore, formatTree } from '../../src/core/store';
import type { NormalizedEvent } from '../../src/core/schema';

const fake = path.resolve('fixtures/fake-claude.mjs');
const L = (o: unknown) => JSON.stringify(o);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'visor-test-'));

function collect() {
  const store = new RunStore({ runId: 'r1', source: 'panel', cwd: process.cwd() });
  return { store, on: (e: NormalizedEvent) => store.apply(e) };
}

const happy = [
  L({ type: 'system', subtype: 'init', session_id: 's1' }),
  L({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'echo' } },
  ] } }),
  L({ type: 'user', parent_tool_use_id: null, message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
  ] } }),
  L({ type: 'result', is_error: false, session_id: 's1' }),
].join('\n') + '\n';

describe('startProcessRun', () => {
  describe('stdin e permissões', () => {
    const ask = L({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    const script = (extra: string[] = []) => [
      L({ type: 'system', subtype: 'init', session_id: 's1' }),
      ask,
      L({ __wait: 'req-1' }),
      ...extra,
      L({ type: 'result', is_error: false, session_id: 's1' }),
    ].join('\n') + '\n';

    it('escreve a mensagem inicial no stdin e entrega o pedido ao onEvent', async () => {
      const dir = tmp();
      const f = path.join(dir, 's.ndjson'); writeFileSync(f, script());
      const stdinFile = path.join(dir, 'stdin.log'); const replyFile = path.join(dir, 'reply.log');
      const events: NormalizedEvent[] = [];
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--stdin-file', stdinFile, '--reply-file', replyFile], cwd: process.cwd(),
        input: '{"type":"user","message":{"role":"user","content":"oi"}}\n',
      }, (e) => {
        events.push(e);
        if (e.type === 'permission_request') {
          expect(run.respond(e.requestId, { behavior: 'allow', updatedInput: { command: 'ls' } })).toBe(true);
        }
      });
      const r = await run.done;
      expect(r.exitCode).toBe(0);
      expect(events.map((e) => e.type)).toContain('permission_request');
      expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'done' });
      expect(readFileSync(stdinFile, 'utf8')).toContain('"content":"oi"');
      expect(JSON.parse(readFileSync(replyFile, 'utf8').trim())).toEqual({
        type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
      });
    });

    it('respond depois do fim do processo devolve false, sem exceção', async () => {
      const f = path.join(tmp(), 's.ndjson'); writeFileSync(f, happy);
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd(), input: 'x\n' }, () => {});
      await run.done;
      expect(run.respond('req-1', { behavior: 'deny', message: 'n' })).toBe(false);
    });

    it('processo que sai antes de ler o stdin não gera erro não tratado (EPIPE)', async () => {
      const f = path.join(tmp(), 's.ndjson'); writeFileSync(f, happy);
      const big = 'y'.repeat(1_000_000) + '\n';
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd(), input: big }, () => {});
      const r = await run.done;
      expect(r.exitCode).toBe(0);
    });

    it('cancelar com pedido pendente encerra o processo e termina cancelled', async () => {
      const dir = tmp(); const f = path.join(dir, 's.ndjson'); writeFileSync(f, script());
      const events: NormalizedEvent[] = [];
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd(), input: 'x\n' }, (e) => {
        events.push(e);
        if (e.type === 'permission_request') run.cancel();
      });
      const r = await run.done;
      expect(r.cancelled).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'cancelled' });
    });

    it('sem input o stdin continua fechado (Codex e usos antigos)', async () => {
      const f = path.join(tmp(), 's.ndjson'); writeFileSync(f, happy);
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, () => {});
      expect(run.respond('req-1', { behavior: 'deny', message: 'n' })).toBe(false);
      await run.done;
    });

    it('fecha o stdin no run_finished: o CLI que espera o fim do stdin sai sozinho', async () => {
      const f = path.join(tmp(), 's.ndjson');
      writeFileSync(f, [L({ type: 'system', subtype: 'init', session_id: 's1' }), L({ type: 'result', is_error: false, session_id: 's1' })].join('\n') + '\n');
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f, '--until-stdin-end'], cwd: process.cwd(), input: 'x\n' }, () => {});
      const r = await run.done;
      expect(r.exitCode).toBe(0);
      expect(r.cancelled).toBe(false);
    });

    it('tarefa em segundo plano: 1º result mantém o stdin aberto; o 2º turno (task_notification → init → result) o fecha e o processo sai', async () => {
      const f = path.join(tmp(), 's.ndjson');
      const bg = (n: number) => L({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, k) => ({ task_id: `t${k}` })) });
      writeFileSync(f, [
        L({ type: 'system', subtype: 'init', session_id: 's1' }), bg(1), L({ type: 'result', is_error: false, session_id: 's1' }),
        bg(0), L({ type: 'system', subtype: 'init', session_id: 's1' }), L({ type: 'result', is_error: false, session_id: 's1' }),
      ].join('\n') + '\n');
      const events: NormalizedEvent[] = [];
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f, '--until-stdin-end'], cwd: process.cwd(), input: 'x\n' }, (e) => events.push(e));
      const r = await run.done;
      expect(r.exitCode).toBe(0);
      expect(r.cancelled).toBe(false);
      expect(events.filter((e) => e.type === 'run_finished')).toHaveLength(2);
      expect(events.some((e) => e.type === 'run_resumed')).toBe(true);
    });

    it('com tarefa em segundo plano pendente o stdin segue aberto até o run_finished seguinte', async () => {
      const f = path.join(tmp(), 's.ndjson');
      const bg = (n: number) => L({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, k) => ({ task_id: `t${k}` })) });
      writeFileSync(f, [
        L({ type: 'system', subtype: 'init', session_id: 's1' }), bg(1), L({ type: 'result', is_error: false, session_id: 's1' }),
      ].join('\n') + '\n');
      const events: NormalizedEvent[] = [];
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f, '--until-stdin-end'], cwd: process.cwd(), input: 'x\n' }, (e) => events.push(e));
      let exited = false;
      void run.done.then(() => { exited = true; });
      await new Promise((r) => setTimeout(r, 600));
      expect(events.at(-1)).toMatchObject({ type: 'run_finished' });
      expect(exited).toBe(false); // o stdin continua aberto: o processo vive para a tarefa
      run.cancel();
      const r = await run.done;
      expect(r.cancelled).toBe(true);
    });

    const bgLine = (n: number) => L({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, k) => ({ task_id: `t${k}` })) });
    const initLine = L({ type: 'system', subtype: 'init', session_id: 's1' });
    const resultLine = L({ type: 'result', is_error: false, session_id: 's1' });

    it('sendUserMessage depois do result, com tarefa em segundo plano, escreve um novo turno no stdin', async () => {
      const dir = tmp();
      const f = path.join(dir, 's.ndjson');
      const stdinFile = path.join(dir, 'stdin.log');
      writeFileSync(f, [initLine, bgLine(1), resultLine].join('\n') + '\n');
      let finished!: () => void;
      const turnOver = new Promise<void>((r) => (finished = r));
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--until-stdin-end', '--stdin-file', stdinFile], cwd: process.cwd(), input: 'primeira\n',
      }, (e) => { if (e.type === 'run_finished') finished(); });
      await turnOver;
      expect(run.hasBackgroundTasks()).toBe(true);
      expect(run.sendUserMessage('segunda')).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      run.cancel();
      await run.done;
      const lines = readFileSync(stdinFile, 'utf8').trim().split('\n');
      expect(JSON.parse(lines.at(-1)!)).toEqual({ type: 'user', message: { role: 'user', content: 'segunda' } });
    });

    it('sendUserMessage com o processo já encerrado devolve false', async () => {
      const f = path.join(tmp(), 's.ndjson');
      writeFileSync(f, happy);
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f, '--until-stdin-end'], cwd: process.cwd(), input: 'x\n' }, () => {});
      await run.done;
      expect(run.sendUserMessage('tarde')).toBe(false);
    });

    it('tarefas zeradas sem turno novo: o stdin fecha depois de lingerCloseMs e o processo sai sozinho', async () => {
      const f = path.join(tmp(), 's.ndjson');
      writeFileSync(f, [initLine, bgLine(1), resultLine, bgLine(0)].join('\n') + '\n');
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--until-stdin-end'], cwd: process.cwd(), input: 'x\n', lingerCloseMs: 100,
      }, () => {});
      const r = await run.done;
      expect(r.cancelled).toBe(false);
      expect(r.exitCode).toBe(0);
    });

    it.skipIf(process.platform === 'win32')('cancel({ immediate: true }) mata na hora, mesmo se o CLI ignora SIGTERM', async () => {
      const f = path.join(tmp(), 's.ndjson');
      writeFileSync(f, happy.split('\n').slice(0, 2).join('\n') + '\n');
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--hang', '--ignore-sigterm'], cwd: process.cwd(), cancelGraceMs: 10_000,
      }, () => {});
      expect(typeof run.pid).toBe('number');
      await new Promise((r) => setTimeout(r, 150));
      const t0 = Date.now();
      run.cancel({ immediate: true });
      const r = await run.done;
      expect(r.cancelled).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
    });
  });

  it('o Claude roda como a extensão do VS Code (não como sdk-cli) e sem marcas de sessão filha; o Codex não é alterado', async () => {
    const dump = path.join(tmp(), 'env.json');
    const script = path.join(tmp(), 'dump.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ e: process.env.CLAUDE_CODE_ENTRYPOINT ?? null, c: process.env.CLAUDECODE ?? null, k: process.env.CLAUDE_CODE_CHILD_SESSION ?? null }));`);
    const saved = { ...process.env };
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      await startProcessRun('r1', { command: process.execPath, args: [script], cwd: process.cwd() }, () => {}).done;
      expect(JSON.parse(readFileSync(dump, 'utf8'))).toEqual({ e: 'claude-vscode', c: null, k: null });
      await startProcessRun('r2', { command: process.execPath, args: [script], cwd: process.cwd(), adapter: 'codex' }, () => {}).done;
      expect(JSON.parse(readFileSync(dump, 'utf8'))).toEqual({ e: 'cli', c: '1', k: '1' });
    } finally {
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  });

  it('lê o stdout por linha e termina em done', async () => {
    const f = path.join(tmp(), 'happy.ndjson');
    writeFileSync(f, happy);
    const { store, on } = collect();
    const r = await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect(r.exitCode).toBe(0);
    expect(formatTree(store)).toBe('root [done]\n  echo (t1) [done]');
  });

  it('linha de 200KB é lida inteira', async () => {
    const big = 'x'.repeat(200_000);
    const f = path.join(tmp(), 'big.ndjson');
    writeFileSync(f, L({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: big }] } }) + '\n' + L({ type: 'result', is_error: false }) + '\n');
    const { store, on } = collect();
    await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect((store.eventsOf('r1:root')[0]?.payload as { text: string }).text.length).toBe(200_000);
  });

  it('processo que sai sem result vira error', async () => {
    const f = path.join(tmp(), 'partial.ndjson');
    writeFileSync(f, happy.split('\n').slice(0, 2).join('\n') + '\n');
    const { store, on } = collect();
    await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect(store.run.status).toBe('error');
    expect(store.nodes.get('r1:t1')?.status).toBe('error');
  });

  it('CLI ausente (ENOENT) produz run em error e spawnError', async () => {
    const { store, on } = collect();
    const r = await startProcessRun('r1', { command: 'visor-cli-que-nao-existe', args: [], cwd: process.cwd() }, on).done;
    expect(r.spawnError).toBeTruthy();
    expect(store.run.status).toBe('error');
  });

  it('cancel encerra o processo e marca o run como cancelled', async () => {
    const f = path.join(tmp(), 'run.ndjson');
    writeFileSync(f, happy.split('\n').slice(0, 2).join('\n') + '\n');
    const { store, on } = collect();
    const run = startProcessRun('r1', { command: process.execPath, args: [fake, f, '--hang'], cwd: process.cwd() }, on);
    await new Promise((r) => setTimeout(r, 500));
    run.cancel();
    const r = await run.done;
    expect(r.cancelled).toBe(true);
    expect(store.run.status).toBe('cancelled');
    expect(store.nodes.get('r1:t1')?.status).toBe('cancelled');
  });

  it.skipIf(process.platform === 'win32')('cancel mata também os processos netos', async () => {
    const pidFile = path.join(tmp(), 'gc.pid');
    const { on } = collect();
    const run = startProcessRun('r1', { command: process.execPath, args: [fake, '-', '--hang', '--grandchild-pid-file', pidFile], cwd: process.cwd() }, on);
    await new Promise((r) => setTimeout(r, 700));
    const gc = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(gc, 0)).not.toThrow();
    run.cancel();
    await run.done;
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(gc, 0)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('cancel escala para SIGKILL se o processo ignora SIGTERM', async () => {
    const { store, on } = collect();
    const run = startProcessRun('r1', { command: process.execPath, args: [fake, '-', '--hang', '--ignore-sigterm'], cwd: process.cwd(), cancelGraceMs: 300 }, on);
    await new Promise((r) => setTimeout(r, 400));
    run.cancel();
    const r = await Promise.race([run.done, new Promise<null>((res) => setTimeout(() => res(null), 3000))]);
    expect(r).not.toBeNull();
    expect(store.run.status).toBe('cancelled');
  });

  it('expõe a contagem de linhas malformadas no resultado', async () => {
    const f = path.join(tmp(), 'bad.ndjson');
    writeFileSync(f, 'lixo\n' + happy);
    const { on } = collect();
    const r = await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect(r.malformedLines).toBe(1);
  });

  it('com adapter "codex" lê o `codex exec --json` (fixture real) e termina em done com a sessão do thread', async () => {
    const { store, on } = collect();
    const r = await startProcessRun('r1', { command: process.execPath, args: [fake, path.resolve('fixtures/codex/command.ndjson')], cwd: process.cwd(), adapter: 'codex' }, on).done;
    expect(r.exitCode).toBe(0);
    expect(store.run.status).toBe('done');
    expect(store.run.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.nodes.size).toBe(1);
  });

  it('adapter "codex" com resume reabre o run em vez de criar outro', async () => {
    const first = collect();
    await startProcessRun('r1', { command: process.execPath, args: [fake, path.resolve('fixtures/codex/command.ndjson')], cwd: process.cwd(), adapter: 'codex' }, first.on).done;
    const sid = first.store.run.sessionId;
    await startProcessRun('r1', { command: process.execPath, args: [fake, path.resolve('fixtures/codex/resume.ndjson')], cwd: process.cwd(), adapter: 'codex', resume: { subagents: [], tasks: {} } }, first.on).done;
    expect(first.store.run.sessionId).toBe(sid);
    expect(first.store.run.status).toBe('done');
  });

  it('o padrão continua sendo o claude (nada muda sem o campo adapter)', async () => {
    const f = path.join(tmp(), 'happy.ndjson');
    writeFileSync(f, happy);
    const { store, on } = collect();
    await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect(formatTree(store)).toBe('root [done]\n  echo (t1) [done]');
  });
});
