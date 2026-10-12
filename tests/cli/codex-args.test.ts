import { describe, it, expect } from 'vitest';
import { buildCodexArgs } from '../../src/cli/codex-args';

describe('buildCodexArgs', () => {
  it('primeiro turno: exec --json, sandbox, modelo e esforço antes do "--"; o prompt vai por último', () => {
    expect(buildCodexArgs({ prompt: 'oi', sandbox: 'workspace-write', model: 'gpt-x', effort: 'high' })).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-m', 'gpt-x', '-c', 'model_reasoning_effort="high"', '--', 'oi',
    ]);
  });

  it('sem modelo/esforço nada é acrescentado', () => {
    expect(buildCodexArgs({ prompt: 'oi', sandbox: 'read-only' })).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '--', 'oi']);
  });

  it('retomada: `exec resume`, sandbox via -c (o resume não tem -s), e "--" antes do id da sessão e do prompt', () => {
    expect(buildCodexArgs({ prompt: 'segue', sandbox: 'read-only', resume: 'thread-1', model: 'm', effort: 'low' })).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'm', '-c', 'model_reasoning_effort="low"', '--', 'thread-1', 'segue',
    ]);
  });

  it('um prompt que começa com traço nunca vira flag', () => {
    const args = buildCodexArgs({ prompt: '--dangerously-bypass-approvals-and-sandbox', sandbox: 'read-only' });
    expect(args.slice(-2)).toEqual(['--', '--dangerously-bypass-approvals-and-sandbox']);
    const resumed = buildCodexArgs({ prompt: '-x', sandbox: 'read-only', resume: 'id' });
    expect(resumed.slice(-3)).toEqual(['--', 'id', '-x']);
  });
});
