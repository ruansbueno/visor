import { describe, it, expect } from 'vitest';
import { HookAdapter } from '../../src/cli/hook-adapter';
import { RunStore, formatTree } from '../../src/core/store';

function run(payloads: Record<string, unknown>[]) {
  const a = new HookAdapter('r1');
  const s = new RunStore({ runId: 'r1', source: 'terminal', cwd: '/p' });
  for (const p of payloads) for (const e of a.push(p)) s.apply(e);
  return s;
}
const start = { hook_event_name: 'SessionStart', session_id: 's1' };
const subStart = (id: string, type = 'echo') => ({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: id, agent_type: type });
const subStop = (id: string) => ({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: id });

describe('HookAdapter', () => {
  it('SessionStart cria a raiz com session_id', () => {
    const s = run([start]);
    expect(s.run.sessionId).toBe('s1');
    expect(s.nodes.get('r1:root')?.status).toBe('running');
  });

  it('SubagentStart/Stop criam e fecham o filho', () => {
    const s = run([start, subStart('a1'), subStop('a1')]);
    expect(formatTree(s)).toBe('root [running]\n  echo (a1) [done]');
  });

  it('SubagentStop registra last_assistant_message como resultado do filho', () => {
    const s = run([start, subStart('a1'), { ...subStop('a1'), last_assistant_message: 'alpha' }]);
    expect(s.eventsOf('r1:a1')).toMatchObject([{ kind: 'tool_result', payload: 'alpha' }]);
  });

  it('dois subagentes paralelos viram dois nodes', () => {
    const s = run([start, subStart('a1'), subStart('a2'), subStop('a2'), subStop('a1')]);
    expect(s.nodes.size).toBe(3);
  });

  it('PreToolUse sem agent_id vai para a raiz; com agent_id vai para o filho', () => {
    const s = run([
      start, subStart('a1'),
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { hook_event_name: 'PreToolUse', agent_id: 'a1', tool_name: 'Read', tool_input: { file_path: 'x' } },
      { hook_event_name: 'PostToolUse', agent_id: 'a1', tool_name: 'Read', tool_response: 'ok' },
    ]);
    expect(s.eventsOf('r1:root').map((e) => e.kind)).toEqual(['tool_call']);
    expect(s.eventsOf('r1:a1').map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
  });

  it('UserPromptSubmit registra o prompt na raiz', () => {
    const s = run([start, { hook_event_name: 'UserPromptSubmit', prompt: 'oi' }]);
    expect(s.eventsOf('r1:root')[0]).toMatchObject({ kind: 'message', payload: { role: 'user', text: 'oi' } });
  });

  it('SessionEnd encerra o run', () => {
    const s = run([start, { hook_event_name: 'SessionEnd' }]);
    expect(s.run.status).toBe('done');
  });

  it('evento sem SessionStart prévio ainda inicia o run (hook perdido)', () => {
    const s = run([subStart('a1')]);
    expect(s.nodes.has('r1:root')).toBe(true);
    expect(s.nodes.has('r1:a1')).toBe(true);
  });

  it('SubagentStop duplicado, evento desconhecido e payload sem forma não lançam', () => {
    const s = run([start, subStart('a1'), subStop('a1'), subStop('a1'), { hook_event_name: 'Coisa' }, {}, { hook_event_name: 42 }]);
    expect(s.nodes.get('r1:a1')?.status).toBe('done');
  });

  it('SubagentStart repetido com o mesmo agent_id não duplica o node', () => {
    const s = run([start, subStart('a1'), subStart('a1')]);
    expect(s.nodes.size).toBe(2);
  });

  it('SessionEnd com reason "clear" não encerra o run (a sessão continua)', () => {
    const s = run([start, { hook_event_name: 'SessionEnd', reason: 'clear' }, subStart('a1')]);
    expect(s.run.status).toBe('running');
    expect(s.nodes.get('r1:a1')?.status).toBe('running');
  });

  it('end() sem SessionEnd marca run e filhos como error; cancelled marca cancelled', () => {
    for (const [cancelled, expected] of [[false, 'error'], [true, 'cancelled']] as const) {
      const a = new HookAdapter('r1');
      const s = new RunStore({ runId: 'r1', source: 'terminal', cwd: '/p' });
      for (const p of [start, subStart('a1')]) for (const e of a.push(p)) s.apply(e);
      for (const e of a.end(cancelled)) s.apply(e);
      expect(s.run.status).toBe(expected);
      expect(s.nodes.get('r1:a1')?.status).toBe(expected);
    }
  });

  it('end() depois de SessionEnd não duplica', () => {
    const a = new HookAdapter('r1');
    a.push(start);
    a.push({ hook_event_name: 'SessionEnd' });
    expect(a.end(false)).toEqual([]);
  });
});
