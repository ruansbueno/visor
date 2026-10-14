import { PERMISSION_MODES, SANDBOX_MODES, type PermissionMode, type SandboxMode } from '../core/options';

export { PERMISSION_MODES };
export type { PermissionMode };

export interface VisorSettings {
  claudePath: string;
  codexPath: string;
  /** sandbox padrão dos chats do Codex */
  codexSandbox: SandboxMode;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  /** Avisa a partir deste número de conversas executando ao mesmo tempo (0 desliga). */
  parallelWarningThreshold: number;
  /** Log de diagnóstico detalhado no canal "Visor" (spawn/exit sempre vão; isto liga os eventos de debug). */
  debugLog: boolean;
  /** Minutos sem eventos, com o turno encerrado e o processo vivo, até avisar que travou (0 desliga). */
  lingerTimeoutMinutes: number;
}

export const DEFAULT_SETTINGS: VisorSettings = {
  claudePath: 'claude',
  codexPath: 'codex',
  codexSandbox: 'workspace-write',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  disallowedTools: [],
  parallelWarningThreshold: 4,
  debugLog: false,
  lingerTimeoutMinutes: 10,
};

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];

const threshold = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_SETTINGS.parallelWarningThreshold;

const minutes = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.lingerTimeoutMinutes;

export function parseSettings(get: (key: string) => unknown): VisorSettings {
  const path = get('claudePath');
  const codex = get('codexPath');
  const sandbox = get('codexSandbox');
  const mode = get('permissionMode');
  return {
    claudePath: typeof path === 'string' && path.trim() ? path.trim() : DEFAULT_SETTINGS.claudePath,
    codexSandbox: (SANDBOX_MODES as readonly unknown[]).includes(sandbox) ? (sandbox as SandboxMode) : DEFAULT_SETTINGS.codexSandbox,
    codexPath: typeof codex === 'string' && codex.trim() ? codex.trim() : DEFAULT_SETTINGS.codexPath,
    permissionMode: (PERMISSION_MODES as readonly unknown[]).includes(mode) ? (mode as PermissionMode) : DEFAULT_SETTINGS.permissionMode,
    allowedTools: list(get('allowedTools')),
    disallowedTools: list(get('disallowedTools')),
    parallelWarningThreshold: threshold(get('parallelWarningThreshold')),
    debugLog: get('debugLog') === true,
    lingerTimeoutMinutes: minutes(get('lingerTimeoutMinutes')),
  };
}
