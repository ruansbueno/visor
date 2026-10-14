export type NodeStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';
export type FinalStatus = 'done' | 'error' | 'cancelled';
export type EventKind = 'message' | 'tool_call' | 'tool_result' | 'error';

/** Pergunta do agente que aguarda resposta da pessoa. */
export interface Question {
  text: string;
  options: string[];
  source: 'marker' | 'heuristic';
}

/** Pedido de permissão de ferramenta aguardando a pessoa (só o que a tela precisa). */
export interface PermissionPrompt {
  requestId: string;
  tool: string;
  summary: string;
  /** o CLI sugeriu uma regra "permitir sempre" */
  hasAlways: boolean;
}

export interface Run {
  id: string;
  /** Opções escolhidas ao criar o chat (CLI, modelo, esforço, permissões). */
  options?: import('./options').ChatOptions;
  /** Título do chat (também usado como rótulo do orquestrador). */
  title: string;
  source: 'panel' | 'terminal';
  sessionId?: string;
  cwd: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
}

export interface AgentNode {
  id: string;
  runId: string;
  parentId: string | null;
  agentType: string;
  invocationId?: string;
  /** Id do agente no Claude Code (usado para continuar um subagente). */
  agentId?: string;
  question?: Question;
  permissions?: PermissionPrompt[];
  /** Fechado à força pelo fim do run (ex.: tarefa em segundo plano); a conclusão real ainda pode corrigir o status. */
  closedByRun?: boolean;
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
}

export interface AgentEvent {
  id: string;
  nodeId: string;
  seq: number;
  ts: number;
  kind: EventKind;
  payload: unknown;
}

export type NormalizedEvent =
  | { type: 'run_started'; runId: string; sessionId?: string; ts: number }
  | {
      type: 'node_started'; runId: string; nodeId: string; parentId: string | null;
      agentType: string; invocationId?: string; ts: number;
    }
  | { type: 'node_event'; runId: string; nodeId: string; kind: EventKind; payload: unknown; ts: number }
  | { type: 'node_finished'; runId: string; nodeId: string; status: FinalStatus; ts: number }
  | { type: 'run_finished'; runId: string; status: FinalStatus; question?: Question; ts: number }
  | { type: 'run_resumed'; runId: string; sessionId?: string; ts: number }
  | { type: 'node_resumed'; runId: string; nodeId: string; ts: number }
  | { type: 'node_meta'; runId: string; nodeId: string; agentId: string; ts: number }
  /** o CLI pede permissão para usar uma ferramenta (controle por stdin); a decisão volta pelo processo */
  | {
      type: 'permission_request'; runId: string; nodeId: string; requestId: string; tool: string;
      input: Record<string, unknown>; description?: string; suggestions: unknown[]; ts: number;
    }
  | { type: 'permission_resolved'; runId: string; requestId: string; ts: number }
  /** o CLI respondeu que está sem login (ou com o token recusado) neste processo; não pertence ao grafo do run */
  | { type: 'auth_lost'; runId: string; ts: number }
  /** limites da assinatura informados pelo CLI (fração 0..1); não pertence ao grafo do run */
  | { type: 'usage'; runId: string; fiveHour?: number; sevenDay?: number; fiveHourResetsAt?: number; sevenDayResetsAt?: number; ts: number };

export const rootNodeId = (runId: string) => `${runId}:root`;
export const subagentNodeId = (runId: string, invocationId: string) => `${runId}:${invocationId}`;
