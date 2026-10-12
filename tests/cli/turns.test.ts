import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { StreamAdapter } from '../../src/cli/stream-adapter';
import { RunStore, formatTree } from '../../src/core/store';
import type { NormalizedEvent } from '../../src/core/schema';

const lines = (f: string) => readFileSync(`fixtures/turns/${f}.ndjson`, 'utf8').split('\n');

function replay(store: RunStore, file: string, resume = false) {
  const subagents = [...store.nodes.values()].filter((n) => n.invocationId).map((n) => n.invocationId!);
  const tasks = Object.fromEntries([...store.nodes.values()].filter((n) => n.agentId && n.invocationId).map((n) => [n.agentId!, n.invocationId!]));
  const a = new StreamAdapter('r1', resume ? { resume: { subagents, tasks } } : undefined);
  const seen: NormalizedEvent[] = [];
  for (const l of lines(file)) for (const e of a.push(l)) { seen.push(e); store.apply(e); }
  for (const e of a.end(false)) { seen.push(e); store.apply(e); }
  return { a, seen };
}

describe('turnos reais do claude (fixtures/turns)', () => {
  it('ask: pergunta com marcador deixa o run em waiting, com opções', () => {
    const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
    replay(s, 'ask');
    expect(s.run.status).toBe('waiting');
    expect(s.run.sessionId).toBeTruthy();
    expect(s.nodes.get('r1:root')).toMatchObject({
      status: 'waiting',
      question: { text: 'Qual cor você prefere?', options: ['Vermelho', 'Azul'], source: 'marker' },
    });
  });

  it('resume-agent: a resposta retoma o run (mesma sessão), cria o subagente e conclui', () => {
    const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
    replay(s, 'ask');
    const sid = s.run.sessionId;
    replay(s, 'resume-agent', true);
    expect(s.run.sessionId).toBe(sid);
    expect(s.run.status).toBe('done');
    expect(s.nodes.get('r1:root')?.status).toBe('done');
    expect(s.nodes.get('r1:root')?.question).toBeUndefined();
    const echo = [...s.nodes.values()].filter((n) => n.agentType === 'echo');
    expect(echo).toHaveLength(1);
    expect(echo[0]).toMatchObject({ status: 'done' });
    expect(echo[0]!.agentId).toMatch(/^[0-9a-f]{10,}$/);
  });

  it('sendmessage: continuar o subagente reaproveita o MESMO node, mensagens vão para ele, e o segundo init/result não perde eventos', () => {
    const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
    replay(s, 'ask');
    replay(s, 'resume-agent', true);
    const echo = [...s.nodes.values()].find((n) => n.agentType === 'echo')!;
    const before = s.eventsOf(echo.id).length;
    const nodesBefore = s.nodes.size;
    const { seen } = replay(s, 'sendmessage', true);
    expect(s.nodes.size).toBe(nodesBefore); // nenhum node novo
    expect(seen.some((e) => e.type === 'node_resumed' && e.nodeId === echo.id)).toBe(true);
    expect(s.eventsOf(echo.id).length).toBeGreaterThan(before); // mensagem do subagente anexada a ele
    expect(s.nodes.get(echo.id)?.status).toBe('done');
    expect(s.run.status).toBe('done');
    expect(seen.filter((e) => e.type === 'run_resumed').length).toBeGreaterThanOrEqual(2); // início da retomada + segundo init
    expect(formatTree(s)).toContain('echo');
  });
});
