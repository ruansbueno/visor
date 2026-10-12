import type { EventView, RunView } from '../protocol';
import type { AgentEvent } from './schema';
import type { RunStore } from './store';

export function toRunView(store: RunStore, busy = false): RunView {
  return {
    id: store.run.id,
    title: store.run.title,
    ...(store.run.options ? { options: store.run.options } : {}),
    busy,
    status: store.run.status,
    startedAt: store.run.startedAt,
    endedAt: store.run.endedAt,
    nodes: [...store.nodes.values()].map((n) => ({
      id: n.id,
      parentId: n.parentId,
      agentType: n.agentType,
      status: n.status,
      startedAt: n.startedAt,
      endedAt: n.endedAt,
      eventCount: n.eventCount,
      ...(n.question ? { question: n.question } : {}),
    })),
    edges: store.edges(),
  };
}

const TRUNCATED = '… (truncado)';

function clip(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + TRUNCATED : value;
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) return TRUNCATED;
  if (Array.isArray(value)) return value.map((v) => clip(v, max, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = clip(v, max, depth + 1);
  return out;
}

/** Converte eventos do store em dados seguros para postMessage: JSON puro, com strings e tamanho total limitados. */
export function toEventViews(events: AgentEvent[], maxChars = 20_000): EventView[] {
  return events.map((e) => {
    let payload: unknown;
    try {
      payload = clip(e.payload, maxChars);
      const size = JSON.stringify(payload)?.length ?? 0;
      if (size > maxChars * 4) payload = { truncated: true, preview: JSON.stringify(payload).slice(0, maxChars) + TRUNCATED };
    } catch {
      payload = { truncated: true, preview: '(conteúdo não serializável)' };
    }
    return { id: e.id, seq: e.seq, ts: e.ts, kind: e.kind, payload };
  });
}
