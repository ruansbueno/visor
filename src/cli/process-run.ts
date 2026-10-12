import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { NormalizedEvent } from '../core/schema';
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
  done: Promise<ProcessRunResult>;
}

const STDERR_TAIL_BYTES = 4096;

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
  const emit = (events: NormalizedEvent[]) => events.forEach(onEvent);

  let cancelled = false;
  let spawnError: string | undefined;
  let stderrTail = '';
  let killTimer: NodeJS.Timeout | undefined;

  // Em Unix o filho vira líder de grupo, para podermos matar a árvore inteira.
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  createInterface({ input: child.stdout }).on('line', (line) => emit(adapter.push(line)));
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  const done = new Promise<ProcessRunResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
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
    cancel() {
      if (cancelled || child.pid === undefined) return;
      cancelled = true;
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
