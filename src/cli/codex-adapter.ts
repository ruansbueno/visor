import { detectQuestion } from '../core/question';
import { type NormalizedEvent, rootNodeId } from '../core/schema';
import type { RunAdapter } from './run-adapter';

type Json = Record<string, any>;

export interface CodexAdapterOptions {
  /** este processo continua uma sessão existente (`codex exec resume`) */
  resume?: boolean;
}

/** Mensagens de erro do Codex às vezes chegam como JSON dentro de string: extrai o texto útil. */
function errorText(message: unknown): string {
  if (typeof message !== 'string') return 'Erro desconhecido do Codex.';
  try {
    const j = JSON.parse(message);
    const inner = j?.error?.message ?? j?.message;
    if (typeof inner === 'string') return inner;
  } catch {
    /* já é texto puro */
  }
  return message;
}

/**
 * Converte o `codex exec --json` nos eventos do grafo. O Codex não tem subagentes: tudo acontece no nó raiz
 * (o cartão do chat), com cada comando/ferramenta como tool call e a saída como resultado.
 */
export class CodexAdapter implements RunAdapter {
  malformedLines = 0;
  private started = false;
  private finished = false;
  private lastText = '';
  private readonly called = new Set<string>();
  private readonly root: string;
  private readonly resuming: boolean;

  constructor(private readonly runId: string, opts: CodexAdapterOptions = {}) {
    this.root = rootNodeId(runId);
    this.resuming = !!opts.resume;
  }

  push(line: string): NormalizedEvent[] {
    if (!line.trim()) return [];
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.malformedLines += 1;
      return [];
    }
    if (!msg || typeof msg !== 'object') return [];
    const m = msg as Json;
    const ts = Date.now();
    const out: NormalizedEvent[] = [];

    switch (m.type) {
      case 'thread.started':
        out.push(...this.start(typeof m.thread_id === 'string' ? m.thread_id : undefined, ts));
        break;
      case 'item.started':
      case 'item.completed':
        out.push(...this.start(undefined, ts), ...this.item(m.type === 'item.completed', m.item, ts));
        break;
      case 'error':
        out.push(...this.start(undefined, ts), this.event('error', errorText(m.message), ts));
        break;
      case 'turn.completed':
        out.push(...this.start(undefined, ts), ...this.finish('done', ts));
        break;
      case 'turn.failed':
        out.push(...this.start(undefined, ts), this.event('error', errorText(m.error?.message), ts), ...this.finish('error', ts));
        break;
      default:
        break; // turn.started e eventos desconhecidos não mudam o grafo
    }
    return out;
  }

  end(cancelled: boolean): NormalizedEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const ts = Date.now();
    return [...this.start(undefined, ts), { type: 'run_finished', runId: this.runId, status: cancelled ? 'cancelled' : 'error', ts }];
  }

  private start(sessionId: string | undefined, ts: number): NormalizedEvent[] {
    if (this.started) return [];
    this.started = true;
    if (this.resuming) return [{ type: 'run_resumed', runId: this.runId, ...(sessionId ? { sessionId } : {}), ts }];
    return [{ type: 'run_started', runId: this.runId, ...(sessionId ? { sessionId } : {}), ts }];
  }

  private event(kind: 'message' | 'tool_call' | 'tool_result' | 'error', payload: unknown, ts: number): NormalizedEvent {
    return { type: 'node_event', runId: this.runId, nodeId: this.root, kind, payload, ts };
  }

  private finish(status: 'done' | 'error', ts: number): NormalizedEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const question = status === 'done' ? detectQuestion(this.lastText) : null;
    return [{ type: 'run_finished', runId: this.runId, status, ...(question ? { question } : {}), ts }];
  }

  private item(completed: boolean, raw: unknown, ts: number): NormalizedEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Json;
    const id = typeof item.id === 'string' ? item.id : undefined;
    const type = typeof item.type === 'string' ? item.type : undefined;
    if (!id || !type) return [];

    if (type === 'agent_message') {
      if (!completed || typeof item.text !== 'string') return [];
      this.lastText = item.text;
      return [this.event('message', { role: 'assistant', text: item.text }, ts)];
    }
    if (type === 'error') {
      return completed ? [this.event('error', errorText(item.message), ts)] : [];
    }
    if (type === 'reasoning') return [];

    const isCommand = type === 'command_execution';
    const { id: _id, type: _type, status, ...rest } = item;
    const out: NormalizedEvent[] = [];
    if (!this.called.has(id)) {
      this.called.add(id);
      out.push(this.event('tool_call', { id, name: isCommand ? 'Shell' : type, input: isCommand ? { command: item.command } : rest }, ts));
    }
    if (completed) {
      const failed = isCommand ? (typeof item.exit_code === 'number' && item.exit_code !== 0) || status === 'failed' : status === 'failed';
      const content = isCommand ? String(item.aggregated_output ?? '') : JSON.stringify(rest);
      out.push(this.event('tool_result', { tool_use_id: id, content, is_error: failed }, ts));
    }
    return out;
  }
}
