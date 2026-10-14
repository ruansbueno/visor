import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { NormalizedEvent } from '../core/schema';
import { permissionResponseLine, userMessageLine, type PermissionDecision } from './claude-input';
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
  /** Fim do turno com as tarefas em segundo plano já zeradas e nenhum turno novo: fecha o stdin depois deste tempo (padrão 30000 ms). */
  lingerCloseMs?: number;
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
  /** pid do processo (undefined se o spawn falhou) */
  readonly pid?: number;
  /** `immediate`: SIGKILL junto com o SIGTERM, sem esperar (fechamento do VS Code, quando não há tempo para o timer). */
  cancel(how?: { immediate?: boolean }): void;
  /** Responde a um pedido de permissão pelo stdin. false se o stdin já não está disponível. */
  respond(requestId: string, decision: PermissionDecision): boolean;
  /** Novo turno no MESMO processo (o CLI segue em --input-format stream-json). false se o stdin já fechou. */
  sendUserMessage(text: string): boolean;
  /** O CLI informou tarefas em segundo plano pendentes. */
  hasBackgroundTasks(): boolean;
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
  /** o turno atual já emitiu run_finished (o processo pode seguir vivo por tarefas em segundo plano) */
  let turnOver = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const clearIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const emit = (events: NormalizedEvent[]) => {
    events.forEach(onEvent);
    if (events.some((e) => e.type === 'run_resumed')) {
      turnOver = false;
      clearIdle();
    }
    // O turno acabou e não há tarefa em segundo plano esperando: sem mais o que responder, fechar o stdin deixa o CLI sair.
    // Com tarefa pendente o processo precisa seguir vivo; o run_finished do turno seguinte fecha.
    if (events.some((e) => e.type === 'run_finished')) {
      turnOver = true;
      if (!adapter.hasBackgroundTasks?.()) closeStdin();
    }
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

  createInterface({ input: child.stdout! }).on('line', (line) => {
    emit(adapter.push(line));
    // As tarefas zeraram depois do fim do turno, mas o CLI não abriu turno novo: não deixar o processo vivo para sempre.
    if (turnOver && stdinOpen && !adapter.hasBackgroundTasks?.() && !idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (turnOver) closeStdin();
      }, opts.lingerCloseMs ?? 30_000);
    }
  });
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
      clearIdle();
      resolve({ exitCode, signal, spawnError, stderrTail, malformedLines: adapter.malformedLines, cancelled });
    };
    child.on('error', (err) => {
      spawnError = err.message;
      if (child.pid === undefined) finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });

  return {
    pid: child.pid,
    done,
    respond(requestId, decision) {
      if (!stdinOpen || !child.stdin || child.stdin.destroyed) return false;
      child.stdin.write(permissionResponseLine(requestId, decision));
      return true;
    },
    sendUserMessage(text) {
      if (!stdinOpen || !child.stdin || child.stdin.destroyed) return false;
      clearIdle();
      turnOver = false;
      child.stdin.write(userMessageLine(text));
      return true;
    },
    hasBackgroundTasks: () => adapter.hasBackgroundTasks?.() ?? false,
    cancel(how) {
      if (child.pid === undefined) return;
      if (cancelled && !how?.immediate) return;
      cancelled = true;
      closeStdin();
      if (isWin) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        return;
      }
      const pid = child.pid;
      const kill = (signal: NodeJS.Signals) => {
        try {
          process.kill(-pid, signal);
        } catch {
          /* já terminou */
        }
      };
      kill('SIGTERM');
      if (how?.immediate) {
        kill('SIGKILL');
        return;
      }
      // Se o CLI ignorar o SIGTERM, não deixamos o run pendurado.
      clearTimeout(killTimer);
      killTimer = setTimeout(() => kill('SIGKILL'), opts.cancelGraceMs ?? 3000);
    },
  };
}
