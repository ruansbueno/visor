import type { Effort, SandboxMode } from '../core/options';

export interface CodexArgsInput {
  prompt: string;
  sandbox: SandboxMode;
  model?: string;
  effort?: Effort;
  /** id da sessão (`thread_id`) a retomar */
  resume?: string;
}

/**
 * Argumentos do `codex exec`. O prompt (e o id da sessão) vêm depois de "--", então nunca viram flag.
 * O `exec resume` não tem `-s`: o sandbox vai por `-c sandbox_mode=...` (verificado: ele é aplicado).
 */
export function buildCodexArgs(i: CodexArgsInput): string[] {
  const args = i.resume
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${i.sandbox}"`]
    : ['exec', '--json', '--skip-git-repo-check', '-s', i.sandbox];
  if (i.model) args.push('-m', i.model);
  if (i.effort) args.push('-c', `model_reasoning_effort="${i.effort}"`);
  args.push('--');
  if (i.resume) args.push(i.resume);
  args.push(i.prompt);
  return args;
}
