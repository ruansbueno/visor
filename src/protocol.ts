import type { NodeStatus, PermissionPrompt, Question } from './core/schema';
import type { CliCheck } from './cli/detect';
import { CLI_IDS, parseAttachments, parseChatOptions, type ChatOptions, type CliId, type Effort } from './core/options';

export type { ChatOptions, CliId };

export interface NodeView {
  id: string;
  parentId: string | null;
  agentType: string;
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
  question?: Question;
  /** pedidos de permissão pendentes, do mais antigo ao mais novo */
  permissions?: PermissionPrompt[];
}

/** Posição (e tamanho, nos cartões de chat) de um node no canvas, escolhidos pela pessoa. */
export interface NodeBox {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** Modelo que o CLI informa (Codex: `codex debug models`), com os esforços que ele aceita. */
export interface ModelInfo {
  id: string;
  label: string;
  efforts: Effort[];
}

export interface CliInfo {
  id: CliId;
  label: string;
  version?: string;
  /** false = detectada na máquina, mas o adaptador ainda não existe ("em breve") */
  supported: boolean;
  /** modelos que o CLI informa (ausente = só os aliases fixos / id livre) */
  models?: ModelInfo[];
}

/** Skill ou comando que o CLI informa (só o nome; o grupo é o plugin de origem ou "skill"/"comando"). */
export interface SlashItem {
  name: string;
  kind: 'skill' | 'command';
  group: string;
}

export interface AttachedFile {
  path: string;
  name: string;
  isDir: boolean;
}

export interface AgentInfo {
  name: string;
  description: string;
}

export interface RunView {
  id: string;
  title: string;
  options?: ChatOptions;
  /** O host está processando um turno deste chat (inclui a fase antes de o processo existir). */
  busy: boolean;
  /** O agente terminou o turno, mas o processo segue vivo (tarefas em segundo plano): dá para responder (vai pelo stdin). */
  lingering?: boolean;
  /** Watchdog: com o turno encerrado, o processo vivo ficou sem dar sinal por `visor.lingerTimeoutMinutes`. */
  stalled?: boolean;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
  nodes: NodeView[];
  edges: { from: string; to: string }[];
}

export interface EventView {
  id: string;
  seq: number;
  ts: number;
  kind: 'message' | 'tool_call' | 'tool_result' | 'error';
  payload: unknown;
}

export type HostMessage =
  | { type: 'snapshot'; runs: RunView[] }
  | { type: 'cli'; check: CliCheck; /** de qual CLI é o diagnóstico (ausente = claude) */ cli?: CliId }
  | { type: 'prefs'; authBannerDismissed: boolean }
  | { type: 'starting'; count: number }
  | { type: 'usage'; fiveHour?: number; sevenDay?: number; /** epoch em segundos */ fiveHourResetsAt?: number; sevenDayResetsAt?: number }
  | { type: 'clis'; clis: CliInfo[] }
  | { type: 'capabilities'; commands: SlashItem[]; defaultModel?: string }
  | { type: 'files'; requestId: string; files: AttachedFile[] }
  | { type: 'agents'; agents: AgentInfo[] }
  | { type: 'node_log'; nodeId: string; events: EventView[]; total: number }
  | { type: 'chat_log'; runId: string; events: EventView[]; total: number }
  | { type: 'layout'; boxes: Record<string, NodeBox> }
  /** resultado de um `send`: ok = a mensagem foi entregue a um processo (novo ou vivo) */
  | { type: 'answer_ack'; nodeId: string; ok: boolean }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'start'; prompt: string; title?: string; options?: ChatOptions; attachments?: string[] }
  | { type: 'cancel'; runId: string }
  | { type: 'inspect'; nodeId: string | null }
  | { type: 'dismissAuth' }
  | { type: 'send'; nodeId: string; text: string; attachments?: string[] }
  | { type: 'spawn'; agentType: string; task: string; runId: string | null }
  | { type: 'markDone'; runId: string }
  | { type: 'removeChat'; runId: string }
  | { type: 'rename'; runId: string; title: string }
  | ({ type: 'moveNode'; nodeId: string } & NodeBox)
  | { type: 'cancelPending' }
  | { type: 'setOptions'; runId: string; options: ChatOptions }
  | { type: 'pickFiles'; requestId: string }
  | { type: 'permission'; runId: string; requestId: string; decision: 'allow' | 'allow_always' | 'deny' }
  /** o watchdog avisou que o processo parou; a pessoa prefere esperar mais */
  | { type: 'keepWaiting'; runId: string }
  /** imagem colada no campo (Cmd/Ctrl+V): o host grava num arquivo temporário e devolve como anexo */
  | { type: 'pasteImage'; requestId: string; mime: string; data: string }
  | { type: 'listClis' }
  | { type: 'listCapabilities' }
  | { type: 'listAgents' }
  /** configuração inicial: refaz a detecção (sem cli = os dois, sem incomodar com um Codex ausente) */
  | { type: 'recheckCli'; cli?: CliId }
  | { type: 'installCli'; cli: CliId }
  | { type: 'loginCli'; cli: CliId }
  | { type: 'pickCliPath'; cli: CliId };

const MAX_NODE_ID_CHARS = 300;
const MAX_TITLE_CHARS = 200;
const MAX_COORD = 1_000_000;
const MIN_SIZE = 120;
const MAX_SIZE = 5000;
const AGENT_TYPE = /^[\w.:-]{1,100}$/;

function validPrompt(v: unknown): v is string {
  return typeof v === 'string' && !!v.trim() && !v.includes('\0') && new TextEncoder().encode(v).length <= MAX_PROMPT_BYTES;
}
/** Título opcional: undefined se ausente ou vazio; null se inválido; senão texto de uma linha. */
function cleanTitle(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > MAX_TITLE_CHARS) return null;
  // Controles, largura zero e marcas de direção (bidi) podem enganar a leitura do título nos avisos.
  const t = v.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
  return t || undefined;
}
/** Texto de uma mensagem: obrigatório, a menos que haja anexos (aí pode ficar vazio). */
function validText(v: unknown, hasAttachments: boolean): v is string {
  if (typeof v !== 'string' || v.includes('\0')) return false;
  if (new TextEncoder().encode(v).length > MAX_PROMPT_BYTES) return false;
  return !!v.trim() || hasAttachments;
}

const coord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
const size = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= MIN_SIZE && v <= MAX_SIZE;

const isCliId = (v: unknown): v is CliId => (CLI_IDS as readonly unknown[]).includes(v);

function validNodeId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_NODE_ID_CHARS;
}

// Em bytes UTF-8 (o prompt vira um único argumento de processo; Linux limita cada argumento a 128 KiB).
export const MAX_PROMPT_BYTES = 100_000;
/** Imagem colada: até ~10 MB (em base64) e só formatos que os CLIs leem. */
export const MAX_PASTE_BASE64 = 14_000_000;
export const PASTE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'cancel':
      return validNodeId(m.runId) ? { type: 'cancel', runId: m.runId } : null;
    case 'dismissAuth':
      return { type: 'dismissAuth' };
    case 'inspect':
      if (m.nodeId === null) return { type: 'inspect', nodeId: null };
      return validNodeId(m.nodeId) ? { type: 'inspect', nodeId: m.nodeId } : null;
    case 'start':
    {
      const title = cleanTitle(m.title);
      const options = parseChatOptions(m.options);
      const attachments = parseAttachments(m.attachments);
      if (title === null || options === null || attachments === null || !validText(m.prompt, attachments.length > 0)) return null;
      return {
        type: 'start', prompt: m.prompt as string,
        ...(title !== undefined ? { title } : {}),
        ...(options ? { options } : {}),
        ...(attachments.length ? { attachments } : {}),
      };
    }
    case 'send':
    {
      const attachments = parseAttachments(m.attachments);
      if (!validNodeId(m.nodeId) || attachments === null || !validText(m.text, attachments.length > 0)) return null;
      return { type: 'send', nodeId: m.nodeId, text: m.text as string, ...(attachments.length ? { attachments } : {}) };
    }
    case 'spawn':
      if (m.runId !== undefined && m.runId !== null && !validNodeId(m.runId)) return null;
      return typeof m.agentType === 'string' && AGENT_TYPE.test(m.agentType) && validPrompt(m.task)
        ? { type: 'spawn', agentType: m.agentType, task: m.task, runId: (m.runId as string | null | undefined) ?? null }
        : null;
    case 'markDone':
      return validNodeId(m.runId) ? { type: 'markDone', runId: m.runId } : null;
    case 'keepWaiting':
      return validNodeId(m.runId) ? { type: 'keepWaiting', runId: m.runId } : null;
    case 'removeChat':
      return validNodeId(m.runId) ? { type: 'removeChat', runId: m.runId } : null;
    case 'cancelPending':
      return { type: 'cancelPending' };
    case 'setOptions': {
      const options = parseChatOptions(m.options);
      return validNodeId(m.runId) && options !== null ? { type: 'setOptions', runId: m.runId, options: options ?? {} } : null;
    }
    case 'pickFiles':
      return typeof m.requestId === 'string' && m.requestId.length > 0 && m.requestId.length <= 100 ? { type: 'pickFiles', requestId: m.requestId } : null;
    case 'pasteImage': {
      const ok = typeof m.requestId === 'string' && m.requestId.length > 0 && m.requestId.length <= 100
        && typeof m.mime === 'string' && (PASTE_MIMES as readonly string[]).includes(m.mime)
        && typeof m.data === 'string' && m.data.length > 0 && m.data.length <= MAX_PASTE_BASE64 && /^[A-Za-z0-9+/]+={0,2}$/.test(m.data);
      return ok ? { type: 'pasteImage', requestId: m.requestId as string, mime: m.mime as string, data: m.data as string } : null;
    }
    case 'permission':
      return validNodeId(m.runId) && validNodeId(m.requestId) && (m.decision === 'allow' || m.decision === 'allow_always' || m.decision === 'deny')
        ? { type: 'permission', runId: m.runId, requestId: m.requestId, decision: m.decision }
        : null;
    case 'listClis':
      return { type: 'listClis' };
    case 'listCapabilities':
      return { type: 'listCapabilities' };
    case 'rename': {
      const title = cleanTitle(m.title);
      return validNodeId(m.runId) && typeof title === 'string' ? { type: 'rename', runId: m.runId, title } : null;
    }
    case 'moveNode': {
      if (!validNodeId(m.nodeId) || !coord(m.x) || !coord(m.y)) return null;
      if ((m.width !== undefined && !size(m.width)) || (m.height !== undefined && !size(m.height))) return null;
      return {
        type: 'moveNode', nodeId: m.nodeId, x: m.x, y: m.y,
        ...(m.width !== undefined ? { width: m.width as number } : {}),
        ...(m.height !== undefined ? { height: m.height as number } : {}),
      };
    }
    case 'listAgents':
      return { type: 'listAgents' };
    case 'recheckCli':
      if (m.cli === undefined) return { type: 'recheckCli' };
      return isCliId(m.cli) ? { type: 'recheckCli', cli: m.cli } : null;
    case 'installCli':
    case 'loginCli':
    case 'pickCliPath':
      return isCliId(m.cli) ? { type: m.type, cli: m.cli } : null;
    default:
      return null;
  }
}

/** Aviso para quando o host descarta uma mensagem da Webview que a pessoa já viu "enviada" (null = nada a avisar). */
export function describeRejected(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'start' && m.type !== 'send' && m.type !== 'spawn' && m.type !== 'rename') return null;
  if (m.attachments !== undefined && parseAttachments(m.attachments) === null) {
    return 'A mensagem não foi enviada: algum anexo tem um caminho inválido (ou são mais de 10).';
  }
  return 'A mensagem não foi enviada: o conteúdo é inválido (vazio, grande demais ou com caracteres não permitidos).';
}
