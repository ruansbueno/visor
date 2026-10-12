import { execFile } from 'node:child_process';

export type CliCheck =
  | { state: 'ok'; version: string; authMethod: string }
  | { state: 'not_installed'; message: string }
  | { state: 'not_authenticated'; version: string; message: string }
  | { state: 'unknown'; version: string; message: string };

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

export const execText: ExecFn = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code === 'string' && code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return resolve({ code: null, stdout: '', stderr: '', spawnError: err.message });
      }
      resolve({ code: typeof code === 'number' ? code : null, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export async function detectClaude(exec: ExecFn, command = 'claude'): Promise<CliCheck> {
  const v = await exec(command, ['--version']);
  if (v.spawnError) {
    return {
      state: 'not_installed',
      message:
        `Não encontrei o CLI "${command}". Instale o Claude Code (no Windows, use o instalador nativo) ` +
        'e rode `claude` no terminal para fazer login, ou configure `visor.claudePath`.',
    };
  }
  const version = v.stdout.trim().split(/\s+/)[0] ?? '';

  const a = await exec(command, ['auth', 'status', '--json']);
  let parsed: any;
  try {
    parsed = JSON.parse(a.stdout);
  } catch {
    parsed = undefined;
  }
  // Só loggedIn e authMethod são lidos; o resto da saída (inclusive e-mail) é descartado.
  if (parsed?.loggedIn === true) {
    return { state: 'ok', version, authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : 'desconhecido' };
  }
  if (parsed?.loggedIn === false) {
    return {
      state: 'not_authenticated',
      version,
      message: 'O CLI não está autenticado. Rode `claude` no terminal e faça login; a extensão não faz login por você.',
    };
  }
  return {
    state: 'unknown',
    version,
    message: 'Não consegui confirmar a autenticação (esta versão do CLI pode não ter `auth status`). Vou tentar executar mesmo assim.',
  };
}

/** Codex: instalado (`--version`) e logado (`login status`), só pela saída do próprio CLI (nunca por arquivos de credencial). */
export async function detectCodex(exec: ExecFn, command = 'codex'): Promise<CliCheck> {
  const v = await exec(command, ['--version']);
  if (v.spawnError) {
    return {
      state: 'not_installed',
      message: `Não encontrei o CLI "${command}". Instale o Codex e rode \`codex login\` no terminal, ou configure \`visor.codexPath\`.`,
    };
  }
  const version = /(\d+\.\d+\.\d+\S*)/.exec(v.stdout)?.[1] ?? '';
  const l = await exec(command, ['login', 'status']);
  const text = `${l.stdout}\n${l.stderr}`;
  // Só o método ("Logged in using ChatGPT") é lido; o resto da saída é descartado.
  const m = /Logged in using ([^\n]+)/i.exec(text);
  if (m && l.code === 0) return { state: 'ok', version, authMethod: m[1]!.trim() };
  if (/not logged in|logged out/i.test(text) || (l.code !== 0 && l.code !== null)) {
    return { state: 'not_authenticated', version, message: 'O Codex não está autenticado. Rode `codex login` no terminal; a extensão não faz login por você.' };
  }
  return { state: 'unknown', version, message: 'Não consegui confirmar a autenticação do Codex. Vou tentar executar mesmo assim.' };
}
