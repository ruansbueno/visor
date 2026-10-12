import { type NormalizedEvent, rootNodeId, subagentNodeId } from '../core/schema';

type Json = Record<string, any>;

export class HookAdapter {
  private started = false;
  private finished = false;
  private readonly subagents = new Set<string>();
  private readonly root: string;

  constructor(private readonly runId: string) {
    this.root = rootNodeId(runId);
  }

  push(payload: Json): NormalizedEvent[] {
    if (!payload || typeof payload !== 'object') return [];
    const ev = payload.hook_event_name;
    if (typeof ev !== 'string') return [];
    const ts = Date.now();
    const out: NormalizedEvent[] = [];

    if (!this.started) {
      this.started = true;
      out.push({
        type: 'run_started', runId: this.runId,
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined, ts,
      });
    }

    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : undefined;
    const owner = agentId && this.subagents.has(agentId) ? subagentNodeId(this.runId, agentId) : this.root;

    switch (ev) {
      case 'SubagentStart':
        if (agentId && !this.subagents.has(agentId)) {
          this.subagents.add(agentId);
          out.push({
            type: 'node_started', runId: this.runId, nodeId: subagentNodeId(this.runId, agentId),
            parentId: this.root, agentType: String(payload.agent_type ?? 'unknown'),
            invocationId: agentId, ts,
          });
        }
        break;
      case 'SubagentStop':
        if (agentId && this.subagents.has(agentId)) {
          const nodeId = subagentNodeId(this.runId, agentId);
          if (typeof payload.last_assistant_message === 'string') {
            out.push({ type: 'node_event', runId: this.runId, nodeId, kind: 'tool_result', payload: payload.last_assistant_message, ts });
          }
          out.push({ type: 'node_finished', runId: this.runId, nodeId, status: 'done', ts });
        }
        break;
      case 'PreToolUse':
        out.push({
          type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_call',
          payload: { name: payload.tool_name, input: payload.tool_input }, ts,
        });
        break;
      case 'PostToolUse':
        out.push({
          type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_result',
          payload: { name: payload.tool_name, response: payload.tool_response }, ts,
        });
        break;
      case 'UserPromptSubmit':
        out.push({
          type: 'node_event', runId: this.runId, nodeId: this.root, kind: 'message',
          payload: { role: 'user', text: payload.prompt }, ts,
        });
        break;
      case 'SessionEnd':
        // "/clear" dispara SessionEnd mas a sessão continua.
        if (payload.reason !== 'clear' && !this.finished) {
          this.finished = true;
          out.push({ type: 'run_finished', runId: this.runId, status: 'done', ts });
        }
        break;
      default:
        break; // SessionStart (tratado acima), Stop e eventos desconhecidos não alteram o grafo
    }
    return out;
  }

  /** Chamado quando o processo/terminal termina sem SessionEnd (crash, kill, cancelamento). */
  end(cancelled: boolean): NormalizedEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const ts = Date.now();
    const out: NormalizedEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({ type: 'run_started', runId: this.runId, ts });
    }
    out.push({ type: 'run_finished', runId: this.runId, status: cancelled ? 'cancelled' : 'error', ts });
    return out;
  }
}
