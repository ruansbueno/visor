export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Todos os esforços que alguma CLI aceita (o Codex acrescenta `ultra`). */
export const ALL_EFFORTS = [...EFFORT_LEVELS, 'ultra'] as const;
export type Effort = (typeof ALL_EFFORTS)[number];

export const CLI_IDS = ['claude', 'codex'] as const;
export type CliId = (typeof CLI_IDS)[number];

/** Esforços que cada CLI aceita (o catálogo do Codex, `codex debug models`, vai de low a ultra). */
export const CLI_EFFORTS: Record<CliId, readonly Effort[]> = {
  claude: EFFORT_LEVELS,
  codex: ALL_EFFORTS,
};

/** Sandboxes do Codex (o equivalente das permissões do Claude). */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** Aliases aceitos pelo `--model` do claude (além de qualquer id completo). */
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/** Opções de um chat; valem para todos os turnos dele. Campo ausente = padrão do CLI/das settings. */
export interface ChatOptions {
  cli?: CliId;
  model?: string;
  effort?: Effort;
  /** modos de permissão do Claude Code (não vale para o Codex) */
  permissionMode?: PermissionMode;
  /** sandbox do Codex (não vale para o Claude) */
  sandbox?: SandboxMode;
}

// Começa com letra/dígito (nunca vira flag) e só tem caracteres de ids de modelo (ex.: claude-sonnet-5-5[1m]).
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:[\]-]{0,99}$/;
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;
export const MAX_ATTACHMENTS = 10;
const MAX_PATH_CHARS = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** undefined = sem opções (padrões); null = inválido. */
export function parseChatOptions(raw: unknown): ChatOptions | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const out: ChatOptions = {};
  if (raw.cli !== undefined) {
    if (!(CLI_IDS as readonly unknown[]).includes(raw.cli)) return null;
    out.cli = raw.cli as CliId;
  }
  if (raw.model !== undefined && raw.model !== '') {
    if (typeof raw.model !== 'string' || !MODEL_ID_PATTERN.test(raw.model)) return null;
    out.model = raw.model;
  }
  if (raw.effort !== undefined) {
    if (!(ALL_EFFORTS as readonly unknown[]).includes(raw.effort)) return null;
    out.effort = raw.effort as Effort;
  }
  if (raw.permissionMode !== undefined) {
    if (!(PERMISSION_MODES as readonly unknown[]).includes(raw.permissionMode)) return null;
    out.permissionMode = raw.permissionMode as PermissionMode;
  }
  if (raw.sandbox !== undefined) {
    if (!(SANDBOX_MODES as readonly unknown[]).includes(raw.sandbox)) return null;
    out.sandbox = raw.sandbox as SandboxMode;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Opções que não combinam com a CLI do chat (texto para a pessoa) ou null se estão ok. */
export function optionsError(o: ChatOptions | undefined): string | null {
  if (!o) return null;
  const cli: CliId = o.cli ?? 'claude';
  const label = cli === 'codex' ? 'Codex' : 'Claude Code';
  if (o.effort && !(CLI_EFFORTS[cli] as readonly Effort[]).includes(o.effort)) return `O esforço "${o.effort}" não existe no ${label}.`;
  if (cli === 'codex' && o.permissionMode) return 'As permissões do Claude Code não valem para o Codex: use o sandbox dele.';
  if (cli === 'claude' && o.sandbox) return 'O sandbox é do Codex: no Claude Code use as permissões.';
  return null;
}

/** Caminhos absolutos de anexos: [] se ausente; null se inválido. */
export function parseAttachments(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) return null;
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_CHARS) return null;
    // Sem quebras de linha (inclusive unicode) nem marcas de direção: o caminho vai escrito no prompt do agente.
    if (/[\0\r\n\u2028\u2029\u0085\u202a-\u202e\u2066-\u2069]/.test(p) || !ABSOLUTE.test(p)) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
