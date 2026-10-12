import { describe, it, expect } from 'vitest';
import { reduce, initialState, isRunning, runOfNode } from '../../webview/state';
import type { RunView } from '../../src/protocol';

const run = (status: RunView['status'], id = 'r'): RunView => ({ id, title: `chat ${id}`, busy: false, status, startedAt: 1, nodes: [], edges: [] });

describe('reduce', () => {
  it('snapshot substitui a lista de runs (vários chats); lista vazia limpa', () => {
    const s1 = reduce(initialState, { type: 'snapshot', runs: [run('running', 'a'), run('done', 'b')] });
    expect(s1.runs.map((r) => r.id)).toEqual(['a', 'b']);
    expect(reduce(s1, { type: 'snapshot', runs: [] }).runs).toEqual([]);
  });

  it('cli guarda o diagnóstico POR CLI (sem id = claude)', () => {
    const check = { state: 'ok', version: '1', authMethod: 'claude.ai' } as const;
    const codex = { state: 'ok', version: '0.1', authMethod: 'ChatGPT' } as const;
    let s = reduce(initialState, { type: 'cli', check });
    expect(s.checks).toEqual({ claude: check });
    s = reduce(s, { type: 'cli', check: codex, cli: 'codex' });
    expect(s.checks).toEqual({ claude: check, codex });
    expect(reduce(s, { type: 'cli', check: { state: 'not_authenticated', version: '1', message: 'x' }, cli: 'codex' }).checks.claude).toEqual(check);
  });

  it('notice acumula com ids crescentes, no máximo 5, e dismiss remove', () => {
    let s = initialState;
    for (let i = 0; i < 7; i++) s = reduce(s, { type: 'notice', level: 'info', text: `n${i}` });
    expect(s.notices).toHaveLength(5);
    expect(s.notices.map((n) => n.text)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
    const ids = s.notices.map((n) => n.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(reduce(s, { type: 'dismiss', id: ids[0]! }).notices).toHaveLength(4);
  });

  it('não muta o estado anterior', () => {
    const before = structuredClone(initialState);
    reduce(initialState, { type: 'notice', level: 'warn', text: 'x' });
    expect(initialState).toEqual(before);
  });
});

const nodeRun = (ids: string[], id = 'r'): RunView => ({
  id, title: `chat ${id}`, busy: false, status: 'running', startedAt: 1, edges: [],
  nodes: ids.map((id, i) => ({ id, parentId: i === 0 ? null : ids[0]!, agentType: 'x', status: 'running' as const, eventCount: 0 })),
});

describe('prefs e inspeção', () => {
  it('prefs guarda se o aviso de autenticação foi dispensado', () => {
    expect(initialState.authDismissed).toBe(false);
    expect(reduce(initialState, { type: 'prefs', authBannerDismissed: true }).authDismissed).toBe(true);
  });

  it('select guarda o node inspecionado e limpa o log antigo', () => {
    let s = reduce(initialState, { type: 'snapshot', runs: [nodeRun(['a', 'b'])] });
    s = reduce(s, { type: 'select', nodeId: 'a' });
    expect(s.inspectedId).toBe('a');
    s = reduce(s, { type: 'node_log', nodeId: 'a', events: [], total: 3 });
    expect(s.log).toEqual({ nodeId: 'a', events: [], total: 3 });
    s = reduce(s, { type: 'select', nodeId: 'b' });
    expect(s.log).toBeNull();
    expect(reduce(s, { type: 'select', nodeId: null }).inspectedId).toBeNull();
  });

  it('node_log de um node que não é o inspecionado é ignorado', () => {
    let s = reduce(initialState, { type: 'select', nodeId: 'a' });
    s = reduce(s, { type: 'node_log', nodeId: 'zzz', events: [], total: 1 });
    expect(s.log).toBeNull();
  });

  it('snapshot de outro run (node some) fecha a inspeção', () => {
    let s = reduce(initialState, { type: 'snapshot', runs: [nodeRun(['a'])] });
    s = reduce(s, { type: 'select', nodeId: 'a' });
    s = reduce(s, { type: 'node_log', nodeId: 'a', events: [], total: 1 });
    s = reduce(s, { type: 'snapshot', runs: [nodeRun(['x'])] });
    expect(s.inspectedId).toBeNull();
    expect(s.log).toBeNull();
    const kept = reduce(reduce(initialState, { type: 'snapshot', runs: [nodeRun(['a'])] }), { type: 'select', nodeId: 'a' });
    expect(reduce(kept, { type: 'snapshot', runs: [nodeRun(['a', 'b'])] }).inspectedId).toBe('a');
    // o node pode estar em qualquer um dos chats
    expect(reduce(kept, { type: 'snapshot', runs: [nodeRun(['z'], 'o'), nodeRun(['a'], 'p')] }).inspectedId).toBe('a');
  });
});

describe('chat_log, layout e moved', () => {
  const ev = [{ id: 'e1', seq: 1, ts: 1, kind: 'message' as const, payload: { role: 'user', text: 'oi' } }];

  it('chat_log guarda a conversa ao vivo por chat', () => {
    const s = reduce(initialState, { type: 'chat_log', runId: 'a', events: ev, total: 7 });
    expect(s.chatLogs.a).toEqual({ events: ev, total: 7 });
    expect(reduce(s, { type: 'chat_log', runId: 'b', events: [], total: 0 }).chatLogs.a).toBeDefined();
  });

  it('snapshot descarta logs e posições de chats que não existem mais', () => {
    let s = reduce(initialState, { type: 'chat_log', runId: 'a', events: ev, total: 1 });
    s = reduce(s, { type: 'chat_log', runId: 'b', events: ev, total: 1 });
    s = reduce(s, { type: 'layout', boxes: { 'a:root': { x: 1, y: 2 }, 'b:root': { x: 3, y: 4 } } });
    s = reduce(s, { type: 'snapshot', runs: [nodeRun(['root'].map((n) => `a:${n}`), 'a')] });
    expect(Object.keys(s.chatLogs)).toEqual(['a']);
    expect(Object.keys(s.layout)).toEqual(['a:root']);
  });

  it('layout do host é mesclado e moved atualiza uma posição (otimista)', () => {
    let s = reduce(initialState, { type: 'layout', boxes: { n1: { x: 1, y: 2 } } });
    s = reduce(s, { type: 'moved', nodeId: 'n2', box: { x: 9, y: 8, width: 400 } });
    expect(s.layout).toEqual({ n1: { x: 1, y: 2 }, n2: { x: 9, y: 8, width: 400 } });
    expect(reduce(s, { type: 'moved', nodeId: 'n1', box: { x: 5, y: 5 } }).layout.n1).toEqual({ x: 5, y: 5 });
  });
});

describe('estabilidade das referências', () => {
  it('snapshot que não remove nada mantém a MESMA referência de chatLogs e layout (evita re-render em cascata)', () => {
    let s = reduce(initialState, { type: 'snapshot', runs: [nodeRun(['a:root'], 'a')] });
    s = reduce(s, { type: 'chat_log', runId: 'a', events: [], total: 0 });
    s = reduce(s, { type: 'layout', boxes: { 'a:root': { x: 1, y: 1 } } });
    const next = reduce(s, { type: 'snapshot', runs: [nodeRun(['a:root'], 'a')] });
    expect(next.chatLogs).toBe(s.chatLogs);
    expect(next.layout).toBe(s.layout);
  });
});

describe('reconciliação de snapshots', () => {
  it('um chat idêntico ao anterior mantém a MESMA referência (mesmo vindo de um clone novo); o que mudou ganha referência nova', () => {
    const a = nodeRun(['a:root'], 'a');
    const b = nodeRun(['b:root'], 'b');
    const s1 = reduce(initialState, { type: 'snapshot', runs: [a, b] });
    const s2 = reduce(s1, { type: 'snapshot', runs: [structuredClone(a), { ...structuredClone(b), title: 'novo título' }] });
    expect(s2.runs[0]).toBe(s1.runs[0]);
    expect(s2.runs[1]).not.toBe(s1.runs[1]);
    expect(s2.runs[1]!.title).toBe('novo título');
  });
});

describe('clis, capabilities e arquivos escolhidos', () => {
  it('guarda a lista de CLIs e as capacidades (comandos + modelo padrão)', () => {
    expect(initialState.clis).toEqual([]);
    expect(initialState.caps).toEqual({ commands: [] });
    const clis = [{ id: 'claude' as const, label: 'Claude Code', version: '2', supported: true }];
    expect(reduce(initialState, { type: 'clis', clis }).clis).toEqual(clis);
    const s = reduce(initialState, { type: 'capabilities', commands: [{ name: 'ping', kind: 'command', group: 'comando' }], defaultModel: 'm' });
    expect(s.caps).toEqual({ commands: [{ name: 'ping', kind: 'command', group: 'comando' }], defaultModel: 'm' });
  });

  it('capabilities repetidas e idênticas mantêm a mesma referência (não re-renderiza os campos)', () => {
    const a = reduce(initialState, { type: 'capabilities', commands: [{ name: 'x', kind: 'skill', group: 'skill' }] });
    const b = reduce(a, { type: 'capabilities', commands: [{ name: 'x', kind: 'skill', group: 'skill' }] });
    expect(b.caps).toBe(a.caps);
  });

  it('files guarda os arquivos escolhidos para o requestId e files_consumed limpa', () => {
    const files = [{ path: '/a.txt', name: 'a.txt', isDir: false }];
    const s = reduce(initialState, { type: 'files', requestId: 'req', files });
    expect(s.picked).toEqual({ requestId: 'req', files });
    expect(reduce(s, { type: 'files_consumed' }).picked).toBeNull();
  });
});

describe('starting', () => {
  it('guarda quantos inícios estão em andamento', () => {
    expect(initialState.starting).toBe(0);
    expect(reduce(initialState, { type: 'starting', count: 2 }).starting).toBe(2);
  });
});

describe('agents', () => {
  it('guarda a lista de agentes recebida', () => {
    expect(initialState.agents).toEqual([]);
    const s = reduce(initialState, { type: 'agents', agents: [{ name: 'reader', description: 'Lê' }] });
    expect(s.agents).toEqual([{ name: 'reader', description: 'Lê' }]);
  });
  it('runOfNode acha o chat dono do node', () => {
    const runs = [nodeRun(['a', 'b'], 'x'), nodeRun(['c'], 'y')];
    expect(runOfNode(runs, 'c')?.id).toBe('y');
    expect(runOfNode(runs, 'b')?.id).toBe('x');
    expect(runOfNode(runs, 'zz')).toBeUndefined();
    expect(runOfNode(runs, null)).toBeUndefined();
  });
});

describe('isRunning', () => {
  it('running e pending estão executando; waiting (aguarda a pessoa), o resto e nulo não', () => {
    expect(isRunning(run('running'))).toBe(true);
    expect(isRunning(run('pending'))).toBe(true);
    for (const st of ['waiting', 'done', 'error', 'cancelled'] as const) expect(isRunning(run(st))).toBe(false);
    expect(isRunning(undefined)).toBe(false);
  });
});
