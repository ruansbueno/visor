import type { CliCheck } from '../src/cli/detect';
import type { CliId } from '../src/core/options';
import type { AgentInfo, AttachedFile, CliInfo, EventView, HostMessage, NodeBox, RunView, SlashItem } from '../src/protocol';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}
export interface ViewState {
  /** diagnóstico (instalação/login) por CLI */
  checks: Partial<Record<CliId, CliCheck>>;
  runs: RunView[];
  notices: Notice[];
  nextNoticeId: number;
  authDismissed: boolean;
  /** inícios de conversa em andamento no host (detecção do CLI, confirmação) */
  starting: number;
  agents: AgentInfo[];
  clis: CliInfo[];
  /** skills/comandos e modelo padrão informados pelo CLI */
  caps: { commands: SlashItem[]; defaultModel?: string };
  /** arquivos escolhidos no seletor, aguardando o campo que os pediu (requestId) */
  picked: { requestId: string; files: AttachedFile[] } | null;
  /** conversa ao vivo de cada chat (cartão no canvas) */
  chatLogs: Record<string, { events: EventView[]; total: number }>;
  /** posições/tamanhos escolhidos pela pessoa */
  layout: Record<string, NodeBox>;
  inspectedId: string | null;
  log: { nodeId: string; events: EventView[]; total: number } | null;
}
export type Action =
  | HostMessage
  | { type: 'dismiss'; id: number }
  | { type: 'select'; nodeId: string | null }
  | { type: 'moved'; nodeId: string; box: NodeBox }
  | { type: 'files_consumed' };

export const initialState: ViewState = { checks: {}, runs: [], notices: [], nextNoticeId: 1, authDismissed: false, starting: 0, agents: [], clis: [], caps: { commands: [] }, picked: null, chatLogs: {}, layout: {}, inspectedId: null, log: null };
const MAX_NOTICES = 5;

/** Mantém a referência anterior de cada run cujo conteúdo não mudou (evita re-render em cascata). */
function reconcileRuns(prev: RunView[], next: RunView[]): RunView[] {
  const old = new Map(prev.map((r) => [r.id, r]));
  let same = prev.length === next.length;
  const out = next.map((r, i) => {
    const p = old.get(r.id);
    const reuse = p && JSON.stringify(p) === JSON.stringify(r) ? p : r;
    if (reuse !== prev[i]) same = false;
    return reuse;
  });
  return same ? prev : out;
}

/** Remove as chaves que não passam no filtro; devolve o MESMO objeto se nada foi removido. */
function keepKeys<T>(obj: Record<string, T>, keep: (key: string) => boolean): Record<string, T> {
  const keys = Object.keys(obj);
  return keys.every(keep) ? obj : Object.fromEntries(keys.filter(keep).map((k) => [k, obj[k]!]));
}

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case 'snapshot': {
      // Se o node inspecionado não existe mais em nenhum chat, fecha a inspeção.
      const gone = state.inspectedId !== null && !runOfNode(action.runs, state.inspectedId);
      // Descarta logs e posições de chats que não existem mais.
      const ids = new Set(action.runs.map((r) => r.id));
      const chatLogs = keepKeys(state.chatLogs, (id) => ids.has(id));
      const nodeIds = new Set(action.runs.flatMap((r) => r.nodes.map((n) => n.id)));
      const layout = keepKeys(state.layout, (id) => nodeIds.has(id));
      const next = { ...state, runs: reconcileRuns(state.runs, action.runs), chatLogs, layout };
      return gone ? { ...next, inspectedId: null, log: null } : next;
    }
    case 'chat_log':
      return { ...state, chatLogs: { ...state.chatLogs, [action.runId]: { events: action.events, total: action.total } } };
    case 'layout':
      return { ...state, layout: { ...state.layout, ...action.boxes } };
    case 'moved':
      return { ...state, layout: { ...state.layout, [action.nodeId]: action.box } };
    case 'starting':
      return { ...state, starting: action.count };
    case 'clis':
      return { ...state, clis: action.clis };
    case 'capabilities': {
      const caps = { commands: action.commands, ...(action.defaultModel ? { defaultModel: action.defaultModel } : {}) };
      return JSON.stringify(caps) === JSON.stringify(state.caps) ? state : { ...state, caps };
    }
    case 'files':
      return { ...state, picked: { requestId: action.requestId, files: action.files } };
    case 'files_consumed':
      return { ...state, picked: null };
    case 'agents':
      return { ...state, agents: action.agents };
    case 'prefs':
      return { ...state, authDismissed: action.authBannerDismissed };
    case 'select':
      return { ...state, inspectedId: action.nodeId, log: null };
    case 'node_log':
      return action.nodeId === state.inspectedId ? { ...state, log: { nodeId: action.nodeId, events: action.events, total: action.total } } : state;
    case 'cli':
      return { ...state, checks: { ...state.checks, [action.cli ?? 'claude']: action.check } };
    case 'notice': {
      const notice: Notice = { id: state.nextNoticeId, level: action.level, text: action.text };
      return { ...state, notices: [...state.notices, notice].slice(-MAX_NOTICES), nextNoticeId: state.nextNoticeId + 1 };
    }
    case 'dismiss':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
  }
}

/** Executando de fato (aguardando a pessoa não conta). */
/** O host está ocupado com este chat (inclui a fase antes de o processo existir). */
export const isBusy = (run: RunView | undefined | null): boolean => !!run?.busy || isRunning(run);

export function isRunning(run: RunView | undefined | null): boolean {
  return run?.status === 'running' || run?.status === 'pending';
}

export function runOfNode(runs: RunView[], nodeId: string | null): RunView | undefined {
  if (!nodeId) return undefined;
  return runs.find((r) => r.nodes.some((n) => n.id === nodeId));
}
