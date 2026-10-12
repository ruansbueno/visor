import type { ModelInfo } from '../src/protocol';
import { CLI_EFFORTS, EFFORT_LEVELS, MODEL_ALIASES, PERMISSION_MODES, SANDBOX_MODES, type ChatOptions, type CliId, type Effort, type PermissionMode, type SandboxMode } from '../src/core/options';

export interface Choice {
  value: string;
  label: string;
}

/** Valor da lista de modelos que abre o campo de id livre. */
export const MODEL_CUSTOM = '__custom';

/** O que as pílulas guardam: tudo como texto ('' = padrão do CLI). */
export interface PillValues {
  cli: CliId;
  model: string;
  effort: string;
  /** permissionMode (Claude) ou sandbox (Codex), conforme a CLI */
  perm: string;
}

const SANDBOX_LABELS: Record<SandboxMode, string> = {
  'read-only': 'Somente leitura',
  'workspace-write': 'Editar o projeto',
  'danger-full-access': 'Acesso total',
};

/** Claude: aliases fixos. Codex: o catálogo que o próprio CLI informa (sem lista inventada). */
export function modelChoices(cli: CliId, defaultModel?: string, models?: ModelInfo[]): Choice[] {
  const first = { value: '', label: defaultModel ? `Padrão (${defaultModel})` : 'Padrão' };
  const listed = models?.length ? models.map((m) => ({ value: m.id, label: m.label })) : cli === 'claude' ? MODEL_ALIASES.map((m) => ({ value: m, label: m })) : [];
  return [first, ...listed, { value: MODEL_CUSTOM, label: 'Outro…' }];
}

/** Esforços da CLI; se o modelo escolhido está no catálogo, só os que ele aceita. */
export function effortChoices(cli: CliId, model?: string, models?: ModelInfo[]): Choice[] {
  const known = model ? models?.find((m) => m.id === model)?.efforts : undefined;
  const levels: readonly string[] = known?.length ? known : CLI_EFFORTS[cli];
  return [{ value: '', label: 'Padrão' }, ...levels.map((l) => ({ value: l, label: l }))];
}

export function permissionChoices(cli: CliId): Choice[] {
  const rest =
    cli === 'codex'
      ? SANDBOX_MODES.map((m) => ({ value: m, label: SANDBOX_LABELS[m] }))
      : PERMISSION_MODES.map((m) => ({ value: m, label: m === 'bypassPermissions' ? 'bypassPermissions' : m }));
  return [{ value: '', label: 'Padrão' }, ...rest];
}

/** Escolhas das pílulas -> opções enviadas ao host (undefined = tudo no padrão). Descarta o que não existe na CLI. */
export function buildOptions(v: PillValues): ChatOptions | undefined {
  const out: ChatOptions = {};
  if (v.cli !== 'claude') out.cli = v.cli;
  if (v.model) out.model = v.model;
  if (v.effort && (CLI_EFFORTS[v.cli] as readonly string[]).includes(v.effort)) out.effort = v.effort as Effort;
  if (v.perm) {
    if (v.cli === 'codex' && (SANDBOX_MODES as readonly string[]).includes(v.perm)) out.sandbox = v.perm as SandboxMode;
    if (v.cli === 'claude' && (PERMISSION_MODES as readonly string[]).includes(v.perm)) out.permissionMode = v.perm as PermissionMode;
  }
  return Object.keys(out).length ? out : undefined;
}

export function summarizeOptions(o: ChatOptions | undefined): PillValues {
  return { cli: o?.cli ?? 'claude', model: o?.model ?? '', effort: o?.effort ?? '', perm: o?.sandbox ?? o?.permissionMode ?? '' };
}

export { EFFORT_LEVELS };
