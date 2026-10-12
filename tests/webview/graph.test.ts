import { describe, it, expect } from 'vitest';
import { toFlow, CHAT_W, CHAT_H, AGENT_W } from '../../webview/graph';
import type { RunView } from '../../src/protocol';

const run: RunView = {
  id: 'r', title: 'Meu chat', busy: false, status: 'running', startedAt: 1,
  nodes: [
    { id: 'r:root', parentId: null, agentType: 'root', status: 'running', startedAt: 1, eventCount: 0 },
    { id: 'r:a', parentId: 'r:root', agentType: 'backend', status: 'running', startedAt: 2, eventCount: 3 },
    { id: 'r:b', parentId: 'r:root', agentType: 'tests', status: 'done', startedAt: 2, endedAt: 5, eventCount: 1 },
  ],
  edges: [{ from: 'r:root', to: 'r:a' }, { from: 'r:root', to: 'r:b' }],
};
const byId = (f: ReturnType<typeof toFlow>) => Object.fromEntries(f.nodes.map((n) => [n.id, n]));

describe('toFlow', () => {
  it('sem chats vira grafo vazio', () => {
    expect(toFlow([], {})).toEqual({ nodes: [], edges: [] });
  });

  it('a raiz do chat vira um cartão "chat" (tamanho padrão); os subagentes viram nodes "agent"', () => {
    const n = byId(toFlow([run], {}));
    expect(n['r:root']).toMatchObject({ type: 'chat', width: CHAT_W, height: CHAT_H, dragHandle: '.chat-drag' });
    expect(n['r:root']!.data).toMatchObject({ runId: 'r', title: 'Meu chat', rootId: 'r:root', status: 'running', busy: false });
    expect(n['r:a']).toMatchObject({ type: 'agent' });
    expect(n['r:a']!.data).toMatchObject({ label: 'backend', eventCount: 3, runId: 'r' });
  });

  it('sem título o cartão se chama "Chat"', () => {
    expect(byId(toFlow([{ ...run, title: '' }], {}))['r:root']!.data).toMatchObject({ title: 'Chat' });
  });

  it('os agentes ficam abaixo do cartão e o cartão fica centralizado sobre eles', () => {
    const n = byId(toFlow([run], {}));
    expect(n['r:a']!.position.y).toBeGreaterThanOrEqual(CHAT_H + 60);
    expect(n['r:a']!.position.y).toBe(n['r:b']!.position.y);
    const chatCenter = n['r:root']!.position.x + CHAT_W / 2;
    const agentCenters = ['r:a', 'r:b'].map((id) => n[id]!.position.x + AGENT_W / 2);
    expect(Math.abs(chatCenter - (agentCenters[0]! + agentCenters[1]!) / 2)).toBeLessThan(1);
  });

  it('posições e tamanhos salvos vencem o layout automático (o resto continua automático)', () => {
    const auto = byId(toFlow([run], {}));
    const f = byId(toFlow([run], { 'r:root': { x: 500, y: 40, width: 500, height: 420 }, 'r:a': { x: -30, y: 900 } }));
    expect(f['r:root']).toMatchObject({ position: { x: 500, y: 40 }, width: 500, height: 420 });
    expect(f['r:a']!.position).toEqual({ x: -30, y: 900 });
    // o agente sem posição própria acompanha o cartão (que foi para (500,40) com 500x420)
    const dx = 500 + 500 / 2 - (auto['r:root']!.position.x + CHAT_W / 2);
    const dy = 40 + 420 - CHAT_H;
    expect(f['r:b']!.position).toEqual({ x: auto['r:b']!.position.x + dx, y: auto['r:b']!.position.y + dy });
  });

  it('box salvo de node que não existe mais é ignorado', () => {
    expect(() => toFlow([run], { 'zz:root': { x: 1, y: 1 } })).not.toThrow();
    expect(toFlow([run], { 'zz:root': { x: 1, y: 1 } }).nodes).toHaveLength(3);
  });

  it('arestas saem do cartão para os agentes e animam só se o destino executa', () => {
    expect(toFlow([run], {}).edges).toEqual([
      { id: 'r:root->r:a', source: 'r:root', target: 'r:a', animated: true },
      { id: 'r:root->r:b', source: 'r:root', target: 'r:b', animated: false },
    ]);
  });

  it('aresta para node inexistente é descartada', () => {
    expect(toFlow([{ ...run, edges: [{ from: 'r:root', to: 'fantasma' }] }], {}).edges).toEqual([]);
  });

  it('vários chats ficam lado a lado sem sobrepor os cartões', () => {
    const other: RunView = { ...run, id: 's', title: 'Outro', nodes: run.nodes.map((n) => ({ ...n, id: n.id.replace('r:', 's:'), parentId: n.parentId?.replace('r:', 's:') ?? null })), edges: run.edges.map((e) => ({ from: e.from.replace('r:', 's:'), to: e.to.replace('r:', 's:') })) };
    const f = byId(toFlow([run, other], {}));
    expect(f['s:root']!.position.x).toBeGreaterThanOrEqual(f['r:root']!.position.x + CHAT_W);
    expect(f['s:root']!.data).toMatchObject({ title: 'Outro' });
    expect(toFlow([run, other], {}).edges).toHaveLength(4);
  });

  it('chat sem agentes: só o cartão, sem arestas', () => {
    const solo: RunView = { ...run, nodes: [run.nodes[0]!], edges: [] };
    const f = toFlow([solo], {});
    expect(f.nodes.map((n) => n.type)).toEqual(['chat']);
    expect(f.edges).toEqual([]);
  });

  it('os agentes sem posição própria acompanham o cartão quando ele é movido', () => {
    const auto = byId(toFlow([run], {}));
    const moved = byId(toFlow([run], { 'r:root': { x: auto['r:root']!.position.x + 800, y: auto['r:root']!.position.y + 100, width: CHAT_W, height: CHAT_H } }));
    expect(moved['r:a']!.position).toEqual({ x: auto['r:a']!.position.x + 800, y: auto['r:a']!.position.y + 100 });
    expect(moved['r:b']!.position).toEqual({ x: auto['r:b']!.position.x + 800, y: auto['r:b']!.position.y + 100 });
  });

  it('agente movido à mão mantém a posição própria; os outros seguem o cartão', () => {
    const auto = byId(toFlow([run], {}));
    const f = byId(toFlow([run], {
      'r:root': { x: auto['r:root']!.position.x + 50, y: auto['r:root']!.position.y, width: CHAT_W, height: CHAT_H },
      'r:a': { x: 7, y: 8 },
    }));
    expect(f['r:a']!.position).toEqual({ x: 7, y: 8 });
    expect(f['r:b']!.position.x).toBe(auto['r:b']!.position.x + 50);
  });

  it('cartão redimensionado mais alto empurra os agentes para baixo (sem sobrepor) e alargado mantém o centro', () => {
    const auto = byId(toFlow([run], {}));
    const taller = byId(toFlow([run], { 'r:root': { x: auto['r:root']!.position.x, y: 0, width: CHAT_W, height: CHAT_H + 200 } }));
    expect(taller['r:a']!.position.y).toBe(auto['r:a']!.position.y + 200);
    const wider = byId(toFlow([run], { 'r:root': { x: auto['r:root']!.position.x - 100, y: 0, width: CHAT_W + 200, height: CHAT_H } }));
    expect(wider['r:a']!.position.x).toBe(auto['r:a']!.position.x); // o centro do cartão não mudou
  });

  it('as opções do chat chegam aos dados do cartão', () => {
    const f = byId(toFlow([{ ...run, options: { model: 'opus', effort: 'high' } }], {}));
    expect(f['r:root']!.data).toMatchObject({ options: { model: 'opus', effort: 'high' } });
    expect((byId(toFlow([run], {}))['r:root']!.data as any).options).toBeUndefined();
  });
});
