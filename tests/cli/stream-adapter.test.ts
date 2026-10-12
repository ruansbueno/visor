import { describe, it, expect } from 'vitest';
import { StreamAdapter } from '../../src/cli/stream-adapter';
import { RunStore, formatTree } from '../../src/core/store';

const L = (o: unknown) => JSON.stringify(o);
const init = L({ type: 'system', subtype: 'init', session_id: 's1' });
const task = (id: string, type = 'echo', name = 'Task') =>
  L({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id, name, input: { subagent_type: type, description: 'd', prompt: 'p' } },
  ] } });
const childText = (parent: string, text: string) =>
  L({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } });
const taskResult = (id: string, isError = false) =>
  L({ type: 'user', parent_tool_use_id: null, message: { content: [
    { type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError },
  ] } });
const result = (isError = false) => L({ type: 'result', subtype: 'success', is_error: isError, session_id: 's1' });

function run(lines: string[], opts: { end?: boolean; cancelled?: boolean } = {}) {
  const a = new StreamAdapter('r1');
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  for (const l of lines) for (const e of a.push(l)) s.apply(e);
  if (opts.end) for (const e of a.end(opts.cancelled ?? false)) s.apply(e);
  return { a, s };
}

describe('StreamAdapter', () => {
  it('converte rate_limit_event em evento usage', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 100 }, seven_day: { utilization: 0.23, resetsAt: 200 } } } });
    const ev = new StreamAdapter('r1').push(line);
    expect(ev).toMatchObject([{ type: 'usage', runId: 'r1', fiveHour: 0.12, sevenDay: 0.23, fiveHourResetsAt: 100, sevenDayResetsAt: 200 }]);
  });

  it('ignora rate_limit_event sem janelas', () => {
    expect(new StreamAdapter('r1').push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {} }))).toEqual([]);
  });

  it('system/init inicia o run com session_id', () => {
    const { s } = run([init]);
    expect(s.run.sessionId).toBe('s1');
    expect(s.nodes.get('r1:root')?.status).toBe('running');
  });

  it('tool_use de subagente cria filho e o resultado o conclui', () => {
    const { s } = run([init, task('t1'), childText('t1', 'alpha'), taskResult('t1'), result()]);
    expect(formatTree(s)).toBe('root [done]\n  echo (t1) [done]');
    expect(s.eventsOf('r1:t1').map((e) => e.kind)).toEqual(['message', 'tool_result']);
  });

  it('a tool "Agent" (nome real na versão 2.1.267) também abre subagente', () => {
    const { s } = run([init, task('t1', 'echo', 'Agent'), taskResult('t1'), result()]);
    expect(formatTree(s)).toBe('root [done]\n  echo (t1) [done]');
  });

  it('subagentes paralelos do mesmo tipo geram dois nodes', () => {
    const { s } = run([init, task('t1'), task('t2'), taskResult('t2'), taskResult('t1'), result()]);
    expect([...s.nodes.keys()].sort()).toEqual(['r1:root', 'r1:t1', 'r1:t2']);
    expect(s.nodes.get('r1:t1')?.status).toBe('done');
    expect(s.nodes.get('r1:t2')?.status).toBe('done');
  });

  it('tool_result com is_error fecha o filho como error', () => {
    const { s } = run([init, task('t1'), taskResult('t1', true), result()]);
    expect(s.nodes.get('r1:t1')?.status).toBe('error');
  });

  it('result com is_error marca o run como error', () => {
    const { s } = run([init, result(true)]);
    expect(s.run.status).toBe('error');
  });

  it('tool_call comum vai para o node dono (raiz ou filho)', () => {
    const bash = (parent: string | null) =>
      L({ type: 'assistant', parent_tool_use_id: parent, message: { content: [
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
      ] } });
    const { s } = run([init, task('t1'), bash(null), bash('t1')]);
    expect(s.eventsOf('r1:root').some((e) => e.kind === 'tool_call' && (e.payload as any).name === 'Bash')).toBe(true);
    expect(s.eventsOf('r1:t1').map((e) => e.kind)).toEqual(['tool_call']);
  });

  it('linhas malformadas, vazias e truncadas são ignoradas e contadas', () => {
    const { a, s } = run([init, '', 'not json', '{"type":"assis', task('t1'), result()]);
    expect(a.malformedLines).toBe(2);
    expect(s.nodes.has('r1:t1')).toBe(true);
  });

  it('JSON válido mas sem forma esperada não lança', () => {
    const { s } = run([init, '123', 'null', L({ type: 'assistant' }), L({ type: 'assistant', message: { content: 'x' } })]);
    expect(s.run.status).toBe('running');
  });

  it('end sem result marca run e filhos pendentes como error', () => {
    const { s } = run([init, task('t1')], { end: true });
    expect(s.run.status).toBe('error');
    expect(s.nodes.get('r1:t1')?.status).toBe('error');
  });

  it('end cancelado marca como cancelled', () => {
    const { s } = run([init, task('t1')], { end: true, cancelled: true });
    expect(s.run.status).toBe('cancelled');
    expect(s.nodes.get('r1:t1')?.status).toBe('cancelled');
  });

  it('end sem nenhuma linha (CLI ausente) ainda produz um run em error', () => {
    const { s } = run([], { end: true });
    expect(s.run.status).toBe('error');
    expect(s.nodes.get('r1:root')?.status).toBe('error');
  });

  it('end depois de result não duplica run_finished', () => {
    const a = new StreamAdapter('r1');
    a.push(init);
    a.push(result());
    expect(a.end(false)).toEqual([]);
  });

  it('mensagens de texto carregam o papel: assistant para respostas, user para o prompt delegado', () => {
    const userText = (parent: string, text: string) =>
      L({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } });
    const { s } = run([init, task('t1'), userText('t1', 'alpha'), childText('t1', 'ok'), L({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'fim' }] } })]);
    expect(s.eventsOf('r1:t1').map((e) => e.payload)).toEqual([
      { role: 'user', text: 'alpha' },
      { role: 'assistant', text: 'ok' },
    ]);
    expect(s.eventsOf('r1:root').find((e) => e.kind === 'message')!.payload).toEqual({ role: 'assistant', text: 'fim' });
  });

  it('o resultado do subagente também aparece no log do dono da chamada, pareável pelo id da tool', () => {
    const { s } = run([init, task('t1'), taskResult('t1'), result()]);
    const rootResults = s.eventsOf('r1:root').filter((e) => e.kind === 'tool_result');
    expect(rootResults).toHaveLength(1);
    expect(rootResults[0]!.payload).toMatchObject({ tool_use_id: 't1', content: 'ok', is_error: false });
    expect(s.eventsOf('r1:t1').filter((e) => e.kind === 'tool_result')).toHaveLength(1);
  });

  it('retomada propaga o session_id do init (a sessão pode mudar) e o segundo init também', () => {
    const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
    s.apply({ type: 'run_started', runId: 'r1', sessionId: 'velha', ts: 1 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 2 });
    const a = new StreamAdapter('r1', { resume: { subagents: [], tasks: {} } });
    for (const l of [L({ type: 'system', subtype: 'init', session_id: 'nova' })]) for (const e of a.push(l)) s.apply(e);
    expect(s.run.sessionId).toBe('nova');
    expect(s.run.status).toBe('running');
  });
});
