import type { NodeChange } from '@xyflow/react';
import type { NodeBox } from '../src/protocol';

export interface Move {
  nodeId: string;
  box: NodeBox;
  /** true quando a pessoa soltou o node/alça: aí a posição vai para o host */
  persist: boolean;
}

interface FlowNodeLike {
  id: string;
  type?: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
}

/** Traduz uma mudança do React Flow (arrastar/redimensionar) na posição a guardar. */
export function toMove(change: NodeChange, nodes: FlowNodeLike[]): Move | null {
  if (change.type === 'position') {
    if (!change.position) return null;
    const node = nodes.find((n) => n.id === change.id);
    if (!node) return null;
    const sized = typeof node.width === 'number' && typeof node.height === 'number';
    return {
      nodeId: node.id,
      box: { x: change.position.x, y: change.position.y, ...(sized ? { width: node.width as number, height: node.height as number } : {}) },
      persist: change.dragging === false,
    };
  }
  // As medições automáticas do React Flow não trazem `resizing`: só o gesto da alça traz.
  if (change.type === 'dimensions' && change.resizing !== undefined && change.dimensions) {
    const node = nodes.find((n) => n.id === change.id);
    if (!node) return null;
    if (node.type !== 'chat') return { nodeId: node.id, box: { x: node.position.x, y: node.position.y }, persist: false };
    return {
      nodeId: node.id,
      box: { x: node.position.x, y: node.position.y, width: change.dimensions.width, height: change.dimensions.height },
      persist: change.resizing === false,
    };
  }
  return null;
}

/**
 * Processa um lote inteiro de mudanças. Ao redimensionar pela alça de cima/esquerda o React Flow manda
 * posição e tamanho no mesmo lote: aplicamos em sequência sobre uma cópia, para que um não apague o outro.
 */
export function toMoves(changes: NodeChange[], nodes: FlowNodeLike[]): Move[] {
  const work = new Map(nodes.map((n) => [n.id, { ...n, position: { ...n.position } }]));
  const out = new Map<string, Move>();
  for (const c of changes) {
    const m = toMove(c, [...work.values()]);
    if (!m) continue;
    const node = work.get(m.nodeId)!;
    node.position = { x: m.box.x, y: m.box.y };
    if (m.box.width !== undefined && m.box.height !== undefined) {
      node.width = m.box.width;
      node.height = m.box.height;
    }
    const prev = out.get(m.nodeId);
    out.set(m.nodeId, { nodeId: m.nodeId, box: m.box, persist: !!prev?.persist || m.persist });
  }
  return [...out.values()];
}
