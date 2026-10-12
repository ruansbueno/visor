import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CodexAdapter } from '../../src/cli/codex-adapter';
import { RunStore } from '../../src/core/store';
import type { NormalizedEvent } from '../../src/core/schema';

const L = (o: unknown) => JSON.stringify(o);
const fixture = (n: string) => readFileSync(`fixtures/codex/${n}.ndjson`, 'utf8').split('\n');

function run(lines: string[], opts: { resume?: boolean; end?: boolean; cancelled?: boolean; store?: RunStore } = {}) {
  const a = new CodexAdapter('r1', opts.resume ? { resume: true } : undefined);
  const s = opts.store ?? new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  const seen: NormalizedEvent[] = [];
  for (const l of lines) for (const e of a.push(l)) { seen.push(e); s.apply(e); }
  if (opts.end) for (const e of a.end(opts.cancelled ?? false)) { seen.push(e); s.apply(e); }
  return { a, s, seen };
}
const texts = (s: RunStore) => s.eventsOf('r1:root').filter((e) => e.kind === 'message').map((e) => (e.payload as any).text);

describe('CodexAdapter com execuções reais (fixtures/codex)', () => {
  it('command: thread vira sessão; fala do agente; comando vira tool call com a saída como resultado; run done', () => {
    const { s } = run(fixture('command'));
    expect(s.run.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.run.status).toBe('done');
    expect(s.nodes.size).toBe(1); // o Codex não tem subagentes
    const ev = s.eventsOf('r1:root');
    const call = ev.find((e) => e.kind === 'tool_call')!.payload as any;
    expect(call).toMatchObject({ name: 'Shell' });
    expect(call.input.command).toContain('cat notes.txt');
    const result = ev.find((e) => e.kind === 'tool_result')!.payload as any;
    expect(result).toMatchObject({ tool_use_id: call.id, content: 'primeira linha do notes\n', is_error: false });
    expect(texts(s).length).toBeGreaterThan(0);
  });

  it('file: alteração de arquivo pelo shell termina em done', () => {
    const { s } = run(fixture('file'));
    expect(s.run.status).toBe('done');
    expect(s.eventsOf('r1:root').some((e) => e.kind === 'tool_call')).toBe(true);
  });

  it('effort: uma resposta simples termina em done com o texto', () => {
    const { s } = run(fixture('effort'));
    expect(texts(s)).toEqual(['LOW']);
    expect(s.run.status).toBe('done');
  });

  it('resume: continua a MESMA sessão (run_resumed com o thread_id) e conclui', () => {
    const first = run(fixture('command'));
    const sid = first.s.run.sessionId;
    const { s, seen } = run(fixture('resume'), { resume: true, store: first.s });
    expect(seen[0]).toMatchObject({ type: 'run_resumed', sessionId: sid });
    expect(s.run.sessionId).toBe(sid);
    expect(s.run.status).toBe('done');
    expect(texts(s).at(-1)).toBe('notes.txt');
  });

  it('error: modelo inexistente vira run em error, com o motivo no log e o aviso não fatal registrado', () => {
    const { s } = run(fixture('error'));
    expect(s.run.status).toBe('error');
    const errors = s.eventsOf('r1:root').filter((e) => e.kind === 'error').map((e) => String(e.payload));
    expect(errors.some((t) => /not supported when using Codex/.test(t))).toBe(true);
    expect(errors.some((t) => /Model metadata/.test(t))).toBe(true);
  });

  it('write-blocked: a resposta "no" do agente aparece normalmente', () => {
    const { s } = run(fixture('write-blocked'));
    expect(texts(s).at(-1)).toBe('no');
    expect(s.run.status).toBe('done');
  });
});

describe('CodexAdapter (casos sintéticos)', () => {
  const thread = L({ type: 'thread.started', thread_id: 't1' });
  const msg = (text: string) => L({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text } });
  const done = L({ type: 'turn.completed', usage: {} });

  it('pergunta com o bloco visor-question deixa o run em waiting, com opções', () => {
    const text = 'Qual?\n\n```visor-question\n{"question":"Qual cor?","options":["Azul","Verde"]}\n```';
    const { s } = run([thread, msg(text), done]);
    expect(s.run.status).toBe('waiting');
    expect(s.nodes.get('r1:root')!.question).toEqual({ text: 'Qual cor?', options: ['Azul', 'Verde'], source: 'marker' });
  });

  it('pergunta só pelo "?" final usa a heurística', () => {
    const { s } = run([thread, msg('Feito. Quer que eu continue?'), done]);
    expect(s.run.status).toBe('waiting');
    expect(s.nodes.get('r1:root')!.question!.source).toBe('heuristic');
  });

  it('só a ÚLTIMA fala do agente decide a pergunta', () => {
    const { s } = run([thread, msg('Posso começar?'), msg('Pronto, terminei.'), done]);
    expect(s.run.status).toBe('done');
  });

  it('comando que falha (exit_code != 0) marca o resultado como erro; item.completed sem started também vira tool_call', () => {
    const { s } = run([
      thread,
      L({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'false', aggregated_output: 'boom', exit_code: 2, status: 'failed' } }),
      done,
    ]);
    const ev = s.eventsOf('r1:root');
    expect(ev.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    expect((ev[1]!.payload as any).is_error).toBe(true);
    expect((ev[1]!.payload as any).tool_use_id).toBe('c1');
  });

  it('started + completed do mesmo comando geram UM tool_call e um resultado', () => {
    const { s } = run([
      thread,
      L({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' } }),
      L({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 0, status: 'completed' } }),
      done,
    ]);
    expect(s.eventsOf('r1:root').map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
  });

  it('itens de outros tipos (file_change, mcp_tool_call…) viram tool call genérica; "reasoning" é ignorado', () => {
    const { s } = run([
      thread,
      L({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' } }),
      L({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'pensando' } }),
      done,
    ]);
    const ev = s.eventsOf('r1:root');
    expect(ev.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    expect((ev[0]!.payload as any).name).toBe('file_change');
    expect(JSON.stringify(ev[0]!.payload)).toContain('a.ts');
  });

  it('turn.failed fecha o run em error com a mensagem; error solto só registra', () => {
    const { s } = run([thread, L({ type: 'error', message: 'falhou' }), L({ type: 'turn.failed', error: { message: 'motivo final' } })]);
    expect(s.run.status).toBe('error');
    expect(s.eventsOf('r1:root').filter((e) => e.kind === 'error').map((e) => e.payload)).toEqual(['falhou', 'motivo final']);
  });

  it('linhas malformadas, vazias, truncadas e formas estranhas são ignoradas e contadas', () => {
    const { a, s } = run([thread, '', 'lixo', '{"type":"item.comp', '123', 'null', L({ type: 'item.completed' }), L({ type: 'item.completed', item: 5 }), msg('ok'), done]);
    expect(a.malformedLines).toBe(2);
    expect(s.run.status).toBe('done');
  });

  it('processo que acaba sem turn.completed vira error (ou cancelled se cancelado)', () => {
    expect(run([thread, msg('metade')], { end: true }).s.run.status).toBe('error');
    expect(run([thread, msg('metade')], { end: true, cancelled: true }).s.run.status).toBe('cancelled');
    expect(run([], { end: true }).s.run.status).toBe('error'); // CLI ausente
  });

  it('end() depois de turn.completed não duplica', () => {
    const a = new CodexAdapter('r1');
    a.push(thread);
    a.push(done);
    expect(a.end(false)).toEqual([]);
  });

  it('saída de comando enorme é entregue inteira ao store (o corte é do host)', () => {
    const big = 'x'.repeat(300_000);
    const { s } = run([thread, L({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'x', aggregated_output: big, exit_code: 0, status: 'completed' } }), done]);
    expect(((s.eventsOf('r1:root')[1]!.payload as any).content as string).length).toBe(300_000);
  });
});
