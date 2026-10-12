import { it, expect, describe } from 'vitest';
import { RunStore } from '../../src/core/store';
import { toRunView, toEventViews } from '../../src/core/snapshot';
import type { AgentEvent } from '../../src/core/schema';

it('converte o store em dados simples, sem eventos nem payloads', () => {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  s.apply({ type: 'run_started', runId: 'r1', sessionId: 's', ts: 1 });
  s.apply({ type: 'node_started', runId: 'r1', nodeId: 'r1:t1', parentId: 'r1:root', agentType: 'echo', invocationId: 't1', ts: 2 });
  s.apply({ type: 'node_event', runId: 'r1', nodeId: 'r1:t1', kind: 'message', payload: 'segredo', ts: 3 });
  const v = toRunView(s);
  expect(v).toMatchObject({ id: 'r1', status: 'running', startedAt: 1 });
  expect(v.nodes.map((n) => [n.id, n.parentId, n.agentType, n.status, n.eventCount])).toEqual([
    ['r1:root', null, 'root', 'running', 0],
    ['r1:t1', 'r1:root', 'echo', 'running', 1],
  ]);
  expect(v.edges).toEqual([{ from: 'r1:root', to: 'r1:t1' }]);
  expect(JSON.stringify(v)).not.toContain('segredo');
  expect(() => structuredClone(v)).not.toThrow();
});

it('store ainda sem run_started tem zero nodes e status pending', () => {
  const v = toRunView(new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' }));
  expect(v.nodes).toEqual([]);
  expect(v.status).toBe('pending');
});

const ev = (seq: number, payload: unknown, kind: AgentEvent['kind'] = 'message'): AgentEvent => ({ id: `n#${seq}`, nodeId: 'n', seq, ts: seq, kind, payload });

describe('toEventViews', () => {
  it('preserva ordem, seq, kind e payload pequeno', () => {
    const out = toEventViews([ev(1, { role: 'user', text: 'oi' }), ev(2, { id: 't', name: 'Read', input: { file_path: 'a' } }, 'tool_call')]);
    expect(out.map((e) => [e.seq, e.kind])).toEqual([[1, 'message'], [2, 'tool_call']]);
    expect(out[1]!.payload).toEqual({ id: 't', name: 'Read', input: { file_path: 'a' } });
  });

  it('trunca strings gigantes em qualquer profundidade e marca o corte', () => {
    const big = 'x'.repeat(50_000);
    const [e] = toEventViews([ev(1, { content: [{ type: 'text', text: big }] }, 'tool_result')], 1000);
    const text = (e!.payload as any).content[0].text as string;
    expect(text.length).toBeLessThan(1100);
    expect(text).toContain('(truncado)');
  });

  it('payload total enorme (muitas chaves) vira prévia truncada', () => {
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 'v'.repeat(50)]));
    const [e] = toEventViews([ev(1, wide)], 1000);
    expect(JSON.stringify(e!.payload).length).toBeLessThan(6000);
    expect((e!.payload as any).truncated).toBe(true);
  });

  it('payload não serializável (BigInt/circular) não lança', () => {
    const circ: any = {}; circ.self = circ;
    expect(() => toEventViews([ev(1, circ), ev(2, 10n as unknown)])).not.toThrow();
  });

  it('é JSON puro (clonável por postMessage)', () => {
    const out = toEventViews([ev(1, { a: undefined, b: [1, 'x'] })]);
    expect(() => structuredClone(out)).not.toThrow();
  });
});

it('a pergunta pendente do node vai para a view; agentId interno não vaza', () => {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  s.apply({ type: 'run_started', runId: 'r1', ts: 1 });
  s.apply({ type: 'node_started', runId: 'r1', nodeId: 'r1:a', parentId: 'r1:root', agentType: 'echo', invocationId: 'a', ts: 2 });
  s.apply({ type: 'node_meta', runId: 'r1', nodeId: 'r1:a', agentId: 'seg-agent-id', ts: 2 });
  s.apply({ type: 'run_finished', runId: 'r1', status: 'done', question: { text: 'Qual?', options: ['A'], source: 'marker' }, ts: 3 });
  const v = toRunView(s);
  expect(v.status).toBe('waiting');
  expect(v.nodes.find((n) => n.id === 'r1:root')!.question).toEqual({ text: 'Qual?', options: ['A'], source: 'marker' });
  expect(JSON.stringify(v)).not.toContain('seg-agent-id');
});

it('o título do chat vai para a view do run', () => {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p', title: 'Refatorar API' });
  expect(toRunView(s).title).toBe('Refatorar API');
});

it('busy vai para a view do run (padrão false)', () => {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  expect(toRunView(s).busy).toBe(false);
  expect(toRunView(s, true).busy).toBe(true);
});

it('toRunView expõe os pedidos de permissão do node (sem input nem sugestões)', () => {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  s.apply({ type: 'run_started', runId: 'r1', ts: 1 });
  s.apply({ type: 'permission_request', runId: 'r1', nodeId: 'r1:root', requestId: 'a', tool: 'Bash', input: { command: 'ls' }, suggestions: [], ts: 2 });
  const node = toRunView(s).nodes[0]!;
  expect(node.permissions).toEqual([{ requestId: 'a', tool: 'Bash', summary: 'ls', hasAlways: false }]);
  expect(JSON.stringify(node)).not.toContain('suggestions');
});
