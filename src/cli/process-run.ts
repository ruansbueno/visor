import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { NormalizedEvent } from '../core/schema';
import { permissionResponseLine, type PermissionDecision } from './claude-input';
import { CodexAdapter } from './codex-adapter';
import type { RunAdapter } from './run-adapter';
import { StreamAdapter, type ResumeSeed } from './stream-adapter';

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Tempo até escalar de SIGTERM para SIGKILL no cancelamento (padrão 3000 ms). */
  cancelGraceMs?: number;
  /** Qual CLI gera a saída (padrão: claude). */
  adapter?: 'claude' | 'codex';
  /** Linhas (já com \n) escritas no stdin ao iniciar; só então o stdin é um pipe. O Claude manda a mensagem do turno por aqui. */
  input?: string;
  /** Presente quando este processo continua uma sessão existente (--resume / exec resume). */
  resume?: ResumeSeed;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  stderrTail: string;
  malformedLines: number;
  cancelled: boolean;
}

export interface ProcessRun {
  cancel(): void;
  /** Responde a um pedido de permissão pelo stdin. false se o stdin já não está disponível. */
  respond(requestId: string, decision: PermissionDecision): boolean;
  done: Promise<ProcessRunResult>;
}

const STDERR_TAIL_BYTES = 4096;

/**
 * Ambiente do filho. Para o Claude, imita o que a extensão oficial do VS Code faz: sem CLAUDE_CODE_ENTRYPOINT o
 * `-p` marca a sessão como "sdk-cli" (não interativa); com ele a sessão aparece como a do VS Code. Também remove
 * as variáveis que marcam "sou um filho de outra sessão do Claude Code" (se o VS Code foi aberto de dentro de uma).
 */
function childEnv(opts: ProcessRunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (opts.adapter !== 'codex') {
    env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_CHILD_SESSION;
  }
  return env;
}

export function startProcessRun(
  runId: string,
  opts: ProcessRunOptions,
  onEvent: (e: NormalizedEvent) => void,
): ProcessRun {
  const adapter: RunAdapter =
    opts.adapter === 'codex'
      ? new CodexAdapter(runId, opts.resume ? { resume: true } : undefined)
      : new StreamAdapter(runId, opts.resume ? { resume: opts.resume } : undefined);
  const isWin = process.platform === 'win32';
  let closeStdin: () => void = () => {};
  const emit = (events: NormalizedEvent[]) => {
    events.forEach(onEvent);
    // O turno acabou e não há tarefa em segundo plano esperando: sem mais o que responder, fechar o stdin deixa o CLI sair.
    // Com tarefa pendente o processo precisa seguir vivo; o run_finished do turno seguinte fecha.
    if (events.some((e) => e.type === 'run_finished') && !adapter.hasBackgroundTasks?.()) closeStdin();
  };

  let cancelled = false;
  let spawnError: string | undefined;
  let stderrTail = '';
  let killTimer: NodeJS.Timeout | undefined;

  // Em Unix o filho vira líder de grupo, para podermos matar a árvore inteira.
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: childEnv(opts),
    detached: !isWin,
    stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  let stdinOpen = false;
  closeStdin = () => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin?.end();
  };
  if (opts.input !== undefined && child.stdin) {
    stdinOpen = true;
    // O CLI pode sair antes de ler tudo (EPIPE): não é erro do Visor.
    child.stdin.on('error', () => { stdinOpen = false; });
    child.stdin.write(opts.input);
  }

  createInterface({ input: child.stdout! }).on('line', (line) => emit(adapter.push(line)));
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  const done = new Promise<ProcessRunResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      closeStdin();
      emit(adapter.end(cancelled));
      clearTimeout(killTimer);
      resolve({ exitCode, signal, spawnError, stderrTail, malformedLines: adapter.malformedLines, cancelled });
    };
    child.on('error', (err) => {
      spawnError = err.message;
      if (child.pid === undefined) finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });

  return {
    done,
    respond(requestId, decision) {
      if (!stdinOpen || !child.stdin || child.stdin.destroyed) return false;
      child.stdin.write(permissionResponseLine(requestId, decision));
      return true;
    },
    cancel() {
      if (cancelled || child.pid === undefined) return;
      cancelled = true;
      closeStdin();
      if (isWin) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        const pid = child.pid;
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          /* já terminou */
        }
        // Se o CLI ignorar o SIGTERM, não deixamos o run pendurado.
        killTimer = setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* já terminou */
          }
        }, opts.cancelGraceMs ?? 3000);
      }
    },
  };
}
