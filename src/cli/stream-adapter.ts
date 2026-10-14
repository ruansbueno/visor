import { detectQuestion } from '../core/question';
import type { RunAdapter } from './run-adapter';
import { type FinalStatus, type NormalizedEvent, rootNodeId, subagentNodeId } from '../core/schema';

// Nomes de tool que abrem um subagente (a versão 2.1.267 do claude usa "Agent").
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

/** Texto do `result` de erro quando o CLI está sem login ou com o token recusado (visto no 2.1.287). */
const AUTH_LOST_TEXT = /not logged in|please run \/login|failed to authenticate|oauth (access )?token (is invalid|has expired)|invalid api key/i;

type Json = Record<string, any>;

/** Estado de turnos anteriores da mesma sessão, para o adapter reconhecer subagentes já existentes. */
export interface ResumeSeed {
  /** ids das chamadas (tool_use_id) dos subagentes que já existem no grafo */
  subagents: string[];
  /** task_id (id do agente no Claude Code) -> tool_use_id da chamada original */
  tasks: Record<string, string>;
}

export interface StreamAdapterOptions {
  resume?: ResumeSeed;
}

function taskStatus(s: unknown): FinalStatus {
  if (s === 'failed' || s === 'error') return 'error';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled') return 'cancelled';
  return 'done';
}

export class StreamAdapter implements RunAdapter {
  malformedLines = 0;
  private started = false;
  private finished = false;
  private readonly subagents = new Set<string>();
  private readonly tasks = new Map<string, string>(); // task_id -> tool_use_id
  private readonly root: string;
  private readonly resuming: boolean;
  private backgroundTasks = 0;
  private authLostSent = false;

  constructor(private readonly runId: string, opts: StreamAdapterOptions = {}) {
    this.root = rootNodeId(runId);
    this.resuming = !!opts.resume;
    for (const id of opts.resume?.subagents ?? []) this.subagents.add(id);
    for (const [task, id] of Object.entries(opts.resume?.tasks ?? {})) this.tasks.set(task, id);
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

    if (m.type === 'system' && m.subtype === 'init') {
      if (this.started && this.finished) {
        // Segundo turno no mesmo processo (ex.: notificação de tarefa em segundo plano): reabre o run.
        this.finished = false;
        out.push({ type: 'run_resumed', runId: this.runId, ...(typeof m.session_id === 'string' ? { sessionId: m.session_id } : {}), ts });
      }
      out.push(...this.start(m.session_id, ts));
    } else if (m.type === 'system' && (m.subtype === 'task_started' || m.subtype === 'task_notification')) {
      out.push(...this.start(m.session_id, ts));
      out.push(...this.task(m, ts));
    } else if (m.type === 'rate_limit_event') {
      const w = m.rate_limit_info?.unifiedWindows;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const fiveHour = num(w?.five_hour?.utilization);
      const sevenDay = num(w?.seven_day?.utilization);
      const resets = num(w?.five_hour?.resetsAt);
      const weekResets = num(w?.seven_day?.resetsAt);
      if (fiveHour !== undefined || sevenDay !== undefined) {
        out.push({
          type: 'usage', runId: this.runId,
          ...(fiveHour !== undefined ? { fiveHour } : {}),
          ...(sevenDay !== undefined ? { sevenDay } : {}),
          ...(resets !== undefined ? { fiveHourResetsAt: resets } : {}),
          ...(weekResets !== undefined ? { sevenDayResetsAt: weekResets } : {}),
          ts,
        });
      }
    } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
      if (Array.isArray(m.tasks)) this.backgroundTasks = m.tasks.length;
    } else if (m.type === 'control_request') {
      const r = m.request;
      if (r?.subtype === 'can_use_tool') {
        if (typeof m.request_id !== 'string' || typeof r.tool_name !== 'string') {
          this.malformedLines += 1;
        } else {
          out.push(...this.start(m.session_id, ts));
          out.push({
            type: 'permission_request', runId: this.runId, nodeId: this.root, requestId: m.request_id, tool: r.tool_name,
            input: r.input && typeof r.input === 'object' && !Array.isArray(r.input) ? r.input : {},
            ...(typeof r.description === 'string' ? { description: r.description } : {}),
            suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
            ts,
          });
        }
      }
    } else if (m.type === 'assistant' || m.type === 'user') {
      out.push(...this.start(m.session_id, ts));
      if (m.type === 'assistant' && m.error === 'authentication_failed') out.push(...this.authLost(ts));
      out.push(...this.content(m, ts));
    } else if (m.type === 'result') {
      out.push(...this.start(m.session_id, ts));
      if (m.is_error && typeof m.result === 'string' && AUTH_LOST_TEXT.test(m.result)) out.push(...this.authLost(ts));
      if (!this.finished) {
        this.finished = true;
        const question = m.is_error ? null : detectQuestion(typeof m.result === 'string' ? m.result : '');
        out.push({
          type: 'run_finished', runId: this.runId, status: m.is_error ? 'error' : 'done',
          ...(question ? { question } : {}), ts,
        });
      }
    }
    return out;
  }

  /** O CLI informou tarefas em segundo plano ainda pendentes (o processo precisa continuar vivo para elas). */
  hasBackgroundTasks(): boolean {
    return this.backgroundTasks > 0;
  }

  /** Uma vez por processo: o host reverifica o login e mostra o aviso. */
  private authLost(ts: number): NormalizedEvent[] {
    if (this.authLostSent) return [];
    this.authLostSent = true;
    return [{ type: 'auth_lost', runId: this.runId, ts }];
  }

  end(cancelled: boolean): NormalizedEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const ts = Date.now();
    return [
      ...this.start(undefined, ts),
      { type: 'run_finished', runId: this.runId, status: cancelled ? 'cancelled' : 'error', ts },
    ];
  }

  private start(sessionId: unknown, ts: number): NormalizedEvent[] {
    if (this.started) return [];
    this.started = true;
    if (this.resuming) {
      return [{ type: 'run_resumed', runId: this.runId, ...(typeof sessionId === 'string' ? { sessionId } : {}), ts }];
    }
    return [{
      type: 'run_started', runId: this.runId,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined, ts,
    }];
  }

  /** task_started/task_notification: liga o id do agente ao node e acompanha continuações (SendMessage). */
  private task(m: Json, ts: number): NormalizedEvent[] {
    const taskId = typeof m.task_id === 'string' ? m.task_id : undefined;
    if (!taskId) return [];
    if (m.subtype === 'task_started') {
      const toolUseId = typeof m.tool_use_id === 'string' ? m.tool_use_id : undefined;
      if (toolUseId && this.subagents.has(toolUseId) && !this.tasks.has(taskId)) {
        this.tasks.set(taskId, toolUseId);
        return [{ type: 'node_meta', runId: this.runId, nodeId: subagentNodeId(this.runId, toolUseId), agentId: taskId, ts }];
      }
      const original = this.tasks.get(taskId);
      if (original) return [{ type: 'node_resumed', runId: this.runId, nodeId: subagentNodeId(this.runId, original), ts }];
      return [];
    }
    const original = this.tasks.get(taskId);
    if (!original) return [];
    return [{ type: 'node_finished', runId: this.runId, nodeId: subagentNodeId(this.runId, original), status: taskStatus(m.status), ts }];
  }

  private owner(m: Json): string {
    const p = m.parent_tool_use_id;
    return typeof p === 'string' && this.subagents.has(p) ? subagentNodeId(this.runId, p) : this.root;
  }

  private content(m: Json, ts: number): NormalizedEvent[] {
    const blocks = m.message?.content;
    if (!Array.isArray(blocks)) return [];
    const out: NormalizedEvent[] = [];
    const owner = this.owner(m);

    for (const b of blocks as Json[]) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({
          type: 'node_event', runId: this.runId, nodeId: owner, kind: 'message',
          payload: { role: m.type === 'user' ? 'user' : 'assistant', text: b.text }, ts,
        });
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        out.push({
          type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_call',
          payload: { id: b.id, name: b.name, input: b.input }, ts,
        });
        if (SUBAGENT_TOOLS.has(b.name)) {
          this.subagents.add(b.id);
          out.push({
            type: 'node_started', runId: this.runId, nodeId: subagentNodeId(this.runId, b.id),
            parentId: owner, agentType: String(b.input?.subagent_type ?? 'general-purpose'),
            invocationId: b.id, ts,
          });
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (this.subagents.has(b.tool_use_id)) {
          const child = subagentNodeId(this.runId, b.tool_use_id);
          out.push({ type: 'node_event', runId: this.runId, nodeId: child, kind: 'tool_result', payload: b.content, ts });
          // Também no log de quem fez a chamada, para a tool "Agent" poder ser pareada com o resultado.
          out.push({
            type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_result',
            payload: { tool_use_id: b.tool_use_id, content: b.content, is_error: !!b.is_error }, ts,
          });
          out.push({ type: 'node_finished', runId: this.runId, nodeId: child, status: b.is_error ? 'error' : 'done', ts });
        } else {
          out.push({
            type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_result',
            payload: { tool_use_id: b.tool_use_id, content: b.content, is_error: !!b.is_error }, ts,
          });
        }
      }
    }
    return out;
  }
}
