import { alwaysSuggestion, cleanLabel, summarizeToolInput } from './permission';
import {
  type AgentEvent, type AgentNode, type NormalizedEvent, type Run,
  rootNodeId,
} from './schema';

export interface RunStoreInit {
  runId: string;
  source: Run['source'];
  cwd: string;
  title?: string;
  options?: Run['options'];
  maxEventsPerNode?: number;
}

export class RunStore {
  readonly run: Run;
  readonly nodes = new Map<string, AgentNode>();
  private readonly log = new Map<string, AgentEvent[]>();
  private readonly maxEvents: number;

  constructor(init: RunStoreInit) {
    this.run = { id: init.runId, title: init.title ?? '', ...(init.options ? { options: init.options } : {}), source: init.source, cwd: init.cwd, status: 'pending', startedAt: Date.now() };
    this.maxEvents = init.maxEventsPerNode ?? 500;
  }

  get rootId(): string {
    return rootNodeId(this.run.id);
  }

  apply(e: NormalizedEvent): void {
    // Depois de run_finished o grafo está fechado: o run não pode ser reaberto nem ganhar nodes por eventos tardios.
    // Eventos de nodes já existentes (conclusão e log de tarefas em segundo plano) ainda são aceitos.
    const lateOk = e.type === 'run_resumed' || e.type === 'node_finished' || e.type === 'node_event' || e.type === 'node_meta' || e.type === 'node_resumed'
      // Tarefa em segundo plano pode pedir permissão com o processo ainda vivo, depois do fim do turno principal.
      || e.type === 'permission_request' || e.type === 'permission_resolved';
    if (this.run.endedAt !== undefined && !lateOk) return;
    switch (e.type) {
      case 'run_started': {
        if (this.nodes.has(this.rootId)) {
          // O host cria o run na hora; o init do CLI chega depois só para informar a sessão.
          if (e.sessionId && !this.run.sessionId) this.run.sessionId = e.sessionId;
          return;
        }
        this.run.status = 'running';
        this.run.startedAt = e.ts;
        if (e.sessionId) this.run.sessionId = e.sessionId;
        this.nodes.set(this.rootId, {
          id: this.rootId, runId: this.run.id, parentId: null, agentType: 'root',
          status: 'running', startedAt: e.ts, eventCount: 0,
        });
        return;
      }
      case 'node_started': {
        if (this.nodes.has(e.nodeId)) return;
        const parentId = e.parentId && this.nodes.has(e.parentId) ? e.parentId : this.rootId;
        this.nodes.set(e.nodeId, {
          id: e.nodeId, runId: this.run.id, parentId, agentType: e.agentType,
          invocationId: e.invocationId, status: 'running', startedAt: e.ts, eventCount: 0,
        });
        return;
      }
      case 'node_event': {
        const node = this.nodes.get(e.nodeId);
        if (!node) return;
        node.eventCount += 1;
        const list = this.log.get(e.nodeId) ?? [];
        list.push({
          id: `${e.nodeId}#${node.eventCount}`, nodeId: e.nodeId, seq: node.eventCount,
          ts: e.ts, kind: e.kind, payload: e.payload,
        });
        if (list.length > this.maxEvents) list.shift();
        this.log.set(e.nodeId, list);
        return;
      }
      case 'node_finished': {
        const node = this.nodes.get(e.nodeId);
        if (!node || (!isActive(node) && !node.closedByRun)) return;
        node.status = e.status;
        node.endedAt = e.ts;
        delete node.closedByRun;
        return;
      }
      case 'run_resumed': {
        const root = this.nodes.get(this.rootId);
        if (!root) return;
        this.run.status = 'running';
        if (e.sessionId) this.run.sessionId = e.sessionId;
        delete this.run.endedAt;
        root.status = 'running';
        delete root.endedAt;
        delete root.question;
        return;
      }
      case 'node_resumed': {
        const node = this.nodes.get(e.nodeId);
        if (!node) return;
        node.status = 'running';
        delete node.endedAt;
        delete node.closedByRun;
        return;
      }
      case 'permission_request': {
        const node = this.nodes.get(e.nodeId) ?? this.nodes.get(this.rootId);
        if (!node) return;
        (node.permissions ??= []).push({
          requestId: e.requestId, tool: cleanLabel(e.tool),
          summary: summarizeToolInput(e.tool, e.input, e.description),
          hasAlways: alwaysSuggestion(e.suggestions) !== undefined,
        });
        return;
      }
      case 'permission_resolved': {
        for (const node of this.nodes.values()) {
          if (node.permissions) node.permissions = node.permissions.filter((p) => p.requestId !== e.requestId);
        }
        return;
      }
      case 'usage':
        return;
      case 'node_meta': {
        const node = this.nodes.get(e.nodeId);
        if (node) node.agentId = e.agentId;
        return;
      }
      case 'run_finished': {
        const root = this.nodes.get(this.rootId);
        if (e.question && e.status === 'done' && root) {
          // Terminou, mas a pessoa precisa responder: o run fica aberto, esperando.
          this.run.status = 'waiting';
          root.status = 'waiting';
          root.question = e.question;
          return;
        }
        this.run.status = e.status;
        this.run.endedAt = e.ts;
        if (root) delete root.question;
        for (const node of this.nodes.values()) {
          if (!isActive(node)) continue;
          // Run "done" com filho ainda ativo é inconsistente: o filho conta como erro.
          node.status =
            e.status === 'cancelled' ? 'cancelled'
            : e.status === 'done' && node.id === this.rootId ? 'done'
            : 'error';
          node.endedAt = e.ts;
          if (node.id !== this.rootId) node.closedByRun = true;
        }
        return;
      }
    }
  }

  eventsOf(nodeId: string): AgentEvent[] {
    return [...(this.log.get(nodeId) ?? [])];
  }

  edges(): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const n of this.nodes.values()) if (n.parentId) out.push({ from: n.parentId, to: n.id });
    return out;
  }
}

function isActive(n: AgentNode): boolean {
  return n.status === 'running' || n.status === 'pending' || n.status === 'waiting';
}

export function formatTree(store: RunStore): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = store.nodes.get(id);
    if (!n) return;
    const label = n.id === store.rootId ? 'root' : `${n.agentType} (${n.invocationId ?? n.id})`;
    lines.push(`${'  '.repeat(depth)}${label} [${n.status}]`);
    for (const c of store.nodes.values()) if (c.parentId === id) walk(c.id, depth + 1);
  };
  walk(store.rootId, 0);
  return lines.join('\n');
}
