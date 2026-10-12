import type { NodeStatus, Question } from '../src/core/schema';
import { layoutForest } from '../src/core/layout';
import type { ChatOptions, EventView, NodeBox, RunView } from '../src/protocol';

/** Cartão do chat (a raiz do run) e nodes de agente têm tamanhos diferentes. */
export const CHAT_W = 540;
export const CHAT_H = 340;
export const AGENT_W = 180;
const ROOT_GAP = 80;
const TREE_MIN_W = CHAT_W + 60;

export interface ChatNodeData {
  runId: string;
  rootId: string;
  title: string;
  status: NodeStatus;
  busy: boolean;
  question?: Question;
  options?: ChatOptions;
  /** conversa ao vivo do chat (vem do estado da Webview, não do snapshot) */
  log?: { events: EventView[]; total: number };
}

export interface AgentNodeData {
  runId: string;
  agentType: string;
  label: string;
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
}

type Pos = { x: number; y: number };

/**
 * Converte os chats em nodes do React Flow: a raiz vira um cartão de chat; os subagentes, nodes pequenos.
 * `boxes` (posições/tamanhos escolhidos pela pessoa) vencem o layout automático.
 */
export function toFlow(runs: RunView[], boxes: Record<string, NodeBox>) {
  const centers = layoutForest(
    runs.map((r) => r.nodes.map((n) => ({ id: n.id, parentId: n.parentId }))),
    { rootHeight: CHAT_H, rootGap: ROOT_GAP, minTreeWidth: TREE_MIN_W },
  );

  const nodes = runs.flatMap((run) => {
    // Agentes sem posição própria acompanham o cartão: se ele foi movido/redimensionado, a árvore inteira vai junto.
    const root = run.nodes.find((n) => n.parentId === null);
    const rootBox = root ? boxes[root.id] : undefined;
    const rootCenter = root ? centers.get(root.id) : undefined;
    const dx = rootBox && rootCenter ? rootBox.x + (rootBox.width ?? CHAT_W) / 2 - rootCenter.x : 0;
    const dy = rootBox ? rootBox.y + (rootBox.height ?? CHAT_H) - CHAT_H : 0;
    return run.nodes.map((n) => {
      const isChat = n.parentId === null;
      const box = boxes[n.id];
      const center = centers.get(n.id) ?? { x: 0, y: 0 };
      const w = isChat ? (box?.width ?? CHAT_W) : AGENT_W;
      const position: Pos = box ? { x: box.x, y: box.y } : isChat ? { x: center.x - w / 2, y: center.y } : { x: center.x - w / 2 + dx, y: center.y + dy };
      if (isChat) {
        return {
          id: n.id,
          type: 'chat' as const,
          position,
          width: w,
          height: box?.height ?? CHAT_H,
          dragHandle: '.chat-drag',
          data: {
            runId: run.id, rootId: n.id, title: run.title || 'Chat', status: n.status, busy: run.busy,
            ...(n.question ? { question: n.question } : {}),
            ...(run.options ? { options: run.options } : {}),
          } satisfies ChatNodeData,
        };
      }
      return {
        id: n.id,
        type: 'agent' as const,
        position,
        data: {
          runId: run.id, agentType: n.agentType, label: n.agentType, status: n.status,
          startedAt: n.startedAt, endedAt: n.endedAt, eventCount: n.eventCount,
        } satisfies AgentNodeData,
      };
    });
  });

  const edges = runs.flatMap((run) => {
    const ids = new Map(run.nodes.map((n) => [n.id, n]));
    return run.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to, animated: ids.get(e.to)!.status === 'running' }));
  });
  return { nodes, edges };
}
