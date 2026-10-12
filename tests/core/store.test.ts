import { describe, it, expect } from 'vitest';
import { RunStore, formatTree } from '../../src/core/store';

function newStore(max?: number) {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p', maxEventsPerNode: max });
  s.apply({ type: 'run_started', runId: 'r1', sessionId: 's1', ts: 1 });
  return s;
}
const child = (id: string, parent: string | null = null) => ({
  type: 'node_started' as const, runId: 'r1', nodeId: `r1:${id}`,
  parentId: parent === null ? 'r1:root' : `r1:${parent}`,
  agentType: 'echo', invocationId: id, ts: 2,
});

describe('RunStore', () => {

  describe('permissões', () => {
    const req = (id: string, extra: Record<string, unknown> = {}) => ({
      type: 'permission_request' as const, runId: 'r1', nodeId: 'r1:root', requestId: id, tool: 'Bash',
      input: { command: `cmd-${id}` }, suggestions: [{ type: 'addRules', behavior: 'allow', rules: [] }], ts: 3, ...extra,
    });

    it('pedido entra na fila do node sem mudar o status; resolved remove só o pedido certo', () => {
      const s = newStore();
      s.apply(req('a'));
      s.apply(req('b'));
      const root = s.nodes.get('r1:root')!;
      expect(root.status).toBe('running');
      expect(root.permissions!.map((p) => p.requestId)).toEqual(['a', 'b']);
      expect(root.permissions![0]).toEqual({ requestId: 'a', tool: 'Bash', summary: 'cmd-a', hasAlways: true });
      s.apply({ type: 'permission_resolved', runId: 'r1', requestId: 'a', ts: 4 });
      expect(root.permissions!.map((p) => p.requestId)).toEqual(['b']);
    });

    it('o nome da ferramenta também é limpo', () => {
      const s = newStore();
      s.apply(req('a', { tool: 'Ba\u202esh' }));
      expect(s.nodes.get('r1:root')!.permissions![0]!.tool).toBe('Bash');
    });

    it('hasAlways é false sem sugestão', () => {
      const s = newStore();
      s.apply(req('a', { suggestions: [] }));
      expect(s.nodes.get('r1:root')!.permissions![0]!.hasAlways).toBe(false);
    });

    it('pedido para node inexistente cai na raiz', () => {
      const s = newStore();
      s.apply(req('a', { nodeId: 'r1:nao-existe' }));
      expect(s.nodes.get('r1:root')!.permissions).toHaveLength(1);
    });

    it('run_finished NÃO apaga pedidos pendentes (o processo segue vivo com tarefa em segundo plano esperando a resposta)', () => {
      const s = newStore();
      s.apply(req('a'));
      s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 9 });
      expect(s.nodes.get('r1:root')!.permissions!.map((p) => p.requestId)).toEqual(['a']);
    });

    it('pedido de uma tarefa em segundo plano que chega depois do run_finished ainda é registrado e pode ser resolvido', () => {
      const s = newStore();
      s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 9 });
      s.apply(req('late'));
      expect(s.nodes.get('r1:root')!.permissions!.map((p) => p.requestId)).toEqual(['late']);
      s.apply({ type: 'permission_resolved', runId: 'r1', requestId: 'late', ts: 10 });
      expect(s.nodes.get('r1:root')!.permissions).toEqual([]);
    });
  });
  it('run_started cria a raiz em running', () => {
    const s = newStore();
    expect(s.run.status).toBe('running');
    expect(s.run.sessionId).toBe('s1');
    expect(s.nodes.get('r1:root')?.status).toBe('running');
    expect(s.nodes.get('r1:root')?.parentId).toBeNull();
  });

  it('node_started cria filho e aresta derivada de parentId', () => {
    const s = newStore();
    s.apply(child('t1'));
    expect(s.edges()).toEqual([{ from: 'r1:root', to: 'r1:t1' }]);
  });

  it('dois subagentes do mesmo tipo em paralelo viram nodes distintos', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply(child('t2'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    expect(s.nodes.get('r1:t1')?.status).toBe('done');
    expect(s.nodes.get('r1:t2')?.status).toBe('running');
  });

  it('node_started duplicado é ignorado', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply(child('t1'));
    expect(s.nodes.size).toBe(2);
  });

  it('parentId desconhecido anexa à raiz', () => {
    const s = newStore();
    s.apply({ ...child('t1'), parentId: 'r1:nao-existe' });
    expect(s.nodes.get('r1:t1')?.parentId).toBe('r1:root');
  });

  it('evento para node inexistente não lança nem altera o store', () => {
    const s = newStore();
    expect(() =>
      s.apply({ type: 'node_event', runId: 'r1', nodeId: 'r1:x', kind: 'message', payload: 'a', ts: 2 }),
    ).not.toThrow();
    expect(s.nodes.size).toBe(1);
  });

  it('retém no máximo maxEventsPerNode mas conta todos', () => {
    const s = newStore(3);
    for (let i = 0; i < 5; i++) {
      s.apply({ type: 'node_event', runId: 'r1', nodeId: 'r1:root', kind: 'message', payload: i, ts: 2 });
    }
    expect(s.nodes.get('r1:root')?.eventCount).toBe(5);
    expect(s.eventsOf('r1:root').map((e) => e.payload)).toEqual([2, 3, 4]);
    expect(s.eventsOf('r1:root').map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('run_finished error marca nodes ainda em andamento como error', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply({ type: 'run_finished', runId: 'r1', status: 'error', ts: 5 });
    expect(s.run.status).toBe('error');
    expect(s.nodes.get('r1:t1')?.status).toBe('error');
    expect(s.nodes.get('r1:root')?.status).toBe('error');
  });

  it('run_finished cancelled marca nodes em andamento como cancelled', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    s.apply(child('t2'));
    s.apply({ type: 'run_finished', runId: 'r1', status: 'cancelled', ts: 5 });
    expect(s.nodes.get('r1:t1')?.status).toBe('done');
    expect(s.nodes.get('r1:t2')?.status).toBe('cancelled');
  });

  it('formatTree imprime a hierarquia', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    expect(formatTree(s)).toBe('root [done]\n  echo (t1) [done]');
  });

  it('eventos depois de run_finished são ignorados', () => {
    const s = newStore();
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 3 });
    s.apply(child('late'));
    s.apply({ type: 'run_finished', runId: 'r1', status: 'error', ts: 4 });
    expect(s.nodes.has('r1:late')).toBe(false);
    expect(s.run.status).toBe('done');
  });
});

describe('RunStore: waiting, retomada e metadados', () => {
  const q = { text: 'Qual cor?', options: ['Azul'], source: 'marker' as const };

  it('run_finished com pergunta deixa run e raiz em waiting, com a pergunta no node, sem encerrar', () => {
    const s = newStore();
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', question: q, ts: 5 });
    expect(s.run.status).toBe('waiting');
    expect(s.run.endedAt).toBeUndefined();
    expect(s.nodes.get('r1:root')).toMatchObject({ status: 'waiting', question: q });
  });

  it('subagente ainda ativo continua ativo; concluídos continuam concluídos', () => {
    const s = newStore();
    s.apply(child('a'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:a', status: 'done', ts: 3 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', question: q, ts: 5 });
    expect(s.nodes.get('r1:a')?.status).toBe('done');
  });

  it('run_resumed reabre run e raiz (inclusive depois de done) e limpa a pergunta', () => {
    const s = newStore();
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', question: q, ts: 5 });
    s.apply({ type: 'run_resumed', runId: 'r1', ts: 6 });
    expect(s.run.status).toBe('running');
    expect(s.nodes.get('r1:root')?.status).toBe('running');
    expect(s.nodes.get('r1:root')?.question).toBeUndefined();

    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 7 });
    expect(s.run.endedAt).toBe(7);
    s.apply({ type: 'run_resumed', runId: 'r1', ts: 8 });
    expect(s.run.status).toBe('running');
    expect(s.run.endedAt).toBeUndefined();
    s.apply(child('depois'));
    expect(s.nodes.has('r1:depois')).toBe(true);
  });

  it('run_finished sem pergunta fecha o waiting (marcar como concluído)', () => {
    const s = newStore();
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', question: q, ts: 5 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 6 });
    expect(s.run.status).toBe('done');
    expect(s.nodes.get('r1:root')?.status).toBe('done');
    expect(s.nodes.get('r1:root')?.question).toBeUndefined();
  });

  it('node_resumed põe um subagente concluído de volta em running', () => {
    const s = newStore();
    s.apply(child('a'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:a', status: 'done', ts: 3 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    s.apply({ type: 'run_resumed', runId: 'r1', ts: 5 });
    s.apply({ type: 'node_resumed', runId: 'r1', nodeId: 'r1:a', ts: 6 });
    expect(s.nodes.get('r1:a')?.status).toBe('running');
    expect(s.nodes.get('r1:a')?.endedAt).toBeUndefined();
  });

  it('node_meta guarda o agentId; node inexistente é ignorado', () => {
    const s = newStore();
    s.apply(child('a'));
    s.apply({ type: 'node_meta', runId: 'r1', nodeId: 'r1:a', agentId: 'abc123', ts: 3 });
    s.apply({ type: 'node_meta', runId: 'r1', nodeId: 'r1:zz', agentId: 'x', ts: 3 });
    expect(s.nodes.get('r1:a')?.agentId).toBe('abc123');
    expect(s.nodes.size).toBe(2);
  });

  it('run_finished cancelled/error também fecha uma raiz em waiting', () => {
    const s = newStore();
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', question: q, ts: 5 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'cancelled', ts: 6 });
    expect(s.nodes.get('r1:root')?.status).toBe('cancelled');
  });

  it('subagente em segundo plano fechado como erro pelo fim do run se corrige quando a conclusão chega depois', () => {
    const s = newStore();
    s.apply(child('bg'));
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    expect(s.nodes.get('r1:bg')?.status).toBe('error'); // fechado à força pelo fim do run
    s.apply({ type: 'node_event', runId: 'r1', nodeId: 'r1:bg', kind: 'message', payload: { role: 'assistant', text: 'pronto' }, ts: 5 });
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:bg', status: 'done', ts: 6 });
    expect(s.nodes.get('r1:bg')?.status).toBe('done');
    expect(s.eventsOf('r1:bg')).toHaveLength(1);
    expect(s.run.status).toBe('done'); // o run em si não é reaberto por isso
  });

  it('um node que terminou por conta própria não é reaberto por um node_finished tardio', () => {
    const s = newStore();
    s.apply(child('a'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:a', status: 'error', ts: 3 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:a', status: 'done', ts: 5 });
    expect(s.nodes.get('r1:a')?.status).toBe('error');
  });

  it('depois do fim do run continuam descartados: node_started, run_finished e run_started', () => {
    const s = newStore();
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    s.apply(child('tarde'));
    s.apply({ type: 'run_finished', runId: 'r1', status: 'error', ts: 5 });
    expect(s.nodes.has('r1:tarde')).toBe(false);
    expect(s.run.status).toBe('done');
  });

  it('run_resumed com sessionId atualiza a sessão (a retomada pode gerar outro id)', () => {
    const s = newStore();
    expect(s.run.sessionId).toBe('s1');
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    s.apply({ type: 'run_resumed', runId: 'r1', sessionId: 's2', ts: 5 });
    expect(s.run.sessionId).toBe('s2');
    s.apply({ type: 'run_resumed', runId: 'r1', ts: 6 });
    expect(s.run.sessionId).toBe('s2');
  });

  it('o run guarda o título do chat (padrão vazio)', () => {
    expect(new RunStore({ runId: 'r', source: 'panel', cwd: '/p', title: 'Meu chat' }).run.title).toBe('Meu chat');
    expect(new RunStore({ runId: 'r', source: 'panel', cwd: '/p' }).run.title).toBe('');
  });

  it('run_started criado antes pelo host não impede o sessionId de chegar no run_started do CLI', () => {
    const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
    s.apply({ type: 'run_started', runId: 'r1', ts: 1 }); // criado na hora pelo host
    expect(s.run.sessionId).toBeUndefined();
    s.apply({ type: 'run_started', runId: 'r1', sessionId: 'sess-9', ts: 2 }); // init do CLI
    expect(s.run.sessionId).toBe('sess-9');
    s.apply({ type: 'run_started', runId: 'r1', sessionId: 'outra', ts: 3 });
    expect(s.run.sessionId).toBe('sess-9'); // não troca uma sessão já conhecida
    expect(s.nodes.size).toBe(1);
  });
});
