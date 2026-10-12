import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SlashItem } from '../protocol';

export interface Capabilities {
  commands: SlashItem[];
  defaultModel: string | undefined;
}

/**
 * Argumentos para só LER o `init`: não grava sessão no histórico, desliga os hooks do projeto/plugins (nada
 * do projeto roda só por abrir um diálogo) e não força modelo (senão o "padrão" lido do init seria o forçado).
 */
export const CAPABILITIES_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--', 'hi'];

const NAME = /^[\w.:-]+$/;
const EMPTY: Capabilities = { commands: [], defaultModel: undefined };

/** Skills e comandos que o próprio CLI informa no evento `system/init` (só nomes). */
export function parseInit(init: unknown): Capabilities {
  if (!init || typeof init !== 'object') return { ...EMPTY };
  const i = init as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && NAME.test(x)) : []);
  const skills = new Set(list(i.skills));
  const names = [...new Set([...list(i.slash_commands), ...skills])].sort((a, b) => a.localeCompare(b));
  const commands = names.map((name): SlashItem => {
    const kind = skills.has(name) ? 'skill' : 'command';
    return { name, kind, group: name.includes(':') ? name.split(':')[0]! : kind === 'skill' ? 'skill' : 'comando' };
  });
  return { commands, defaultModel: typeof i.model === 'string' ? i.model : undefined };
}

/**
 * Inicia o CLI só até ele emitir o `init` (que acontece antes de qualquer chamada ao modelo) e o encerra:
 * assim a lista de skills/comandos e o modelo padrão saem do próprio CLI, sem gastar tokens.
 */
export function readCapabilities(o: { command: string; args: string[]; cwd: string; timeoutMs?: number }): Promise<Capabilities> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(o.command, o.args, { cwd: o.cwd, detached: !isWin, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let done = false;
    const stop = () => {
      if (child.pid === undefined) return;
      try {
        if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* já terminou */
      }
    };
    const finish = (value: Capabilities) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ...EMPTY }), o.timeoutMs ?? 15_000);
    child.on('error', () => finish({ ...EMPTY }));
    child.on('close', () => finish({ ...EMPTY }));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        const j = JSON.parse(line);
        if (j?.type === 'system' && j.subtype === 'init') finish(parseInit(j));
      } catch {
        /* linha que não é JSON: ignorar */
      }
    });
  });
}
