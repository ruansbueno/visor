import fs from 'node:fs';
import path from 'node:path';
import type { CliId } from '../core/options';
import type { ExecFn } from './detect';

export type Platform = NodeJS.Platform;

export interface LocateOptions {
  platform: Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** nomes dentro de uma pasta ([] se não existir) */
  listDir: (dir: string) => string[];
}

export const defaultLocateOptions = (): LocateOptions => ({
  platform: process.platform,
  home: process.env.HOME ?? process.env.USERPROFILE ?? '',
  env: process.env,
  listDir: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
});

/** Onde o CLI costuma ficar quando o PATH do VS Code não é o do terminal. */
export function candidatePaths(cli: CliId, o: LocateOptions): string[] {
  if (o.platform === 'win32') {
    // execFile não executa .cmd (shims do npm): só .exe.
    const dirs = [path.win32.join(o.env.USERPROFILE ?? o.home, '.local', 'bin'), ...(o.env.LOCALAPPDATA ? [path.win32.join(o.env.LOCALAPPDATA, 'Programs', cli)] : [])];
    return dirs.map((d) => path.win32.join(d, `${cli}.exe`));
  }
  const join = path.posix.join;
  const dirs = [
    join(o.home, '.local/bin'),
    ...(cli === 'claude' ? [join(o.home, '.claude/local')] : []),
    join(o.home, '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  const nvm = join(o.env.NVM_DIR ?? join(o.home, '.nvm'), 'versions/node');
  for (const v of o.listDir(nvm).sort().reverse()) dirs.push(join(nvm, v, 'bin'));
  return dirs.map((d) => join(d, cli));
}

/** Primeiro caminho em que o CLI responde a `--version` (shell de login primeiro, depois a lista conhecida). */
export async function findCli(cli: CliId, exec: ExecFn, o: LocateOptions = defaultLocateOptions()): Promise<string | undefined> {
  const tried = new Set<string>();
  const works = async (p: string) => {
    if (tried.has(p)) return false;
    tried.add(p);
    return !(await exec(p, ['--version'])).spawnError;
  };
  if (o.platform !== 'win32' && o.env.SHELL) {
    // O shell interativo de login enxerga nvm, asdf etc., que o VS Code aberto pelo Dock não herda.
    const r = await exec(o.env.SHELL, ['-ilc', `command -v ${cli}`]);
    const last = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!r.spawnError && path.posix.isAbsolute(last) && (await works(last))) return last;
  }
  for (const p of candidatePaths(cli, o)) if (await works(p)) return p;
  return undefined;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function installCommand(cli: CliId, platform: Platform): string {
  if (cli === 'codex') return 'npm i -g @openai/codex';
  return platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
}

/** Comando do terminal que leva à tela de login (a extensão não faz login nem lê credenciais). */
export function loginCommand(cli: CliId, command: string, platform: Platform): string {
  const quote = /[\s'"]/.test(command);
  const exe = !quote ? command : platform === 'win32' ? `& "${command}"` : shellQuote(command);
  return cli === 'codex' ? `${exe} login` : exe;
}
