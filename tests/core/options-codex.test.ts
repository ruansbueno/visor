import { describe, it, expect } from 'vitest';
import { parseChatOptions, optionsError, CLI_EFFORTS, SANDBOX_MODES } from '../../src/core/options';

describe('opções por CLI', () => {
  it('esforços por CLI: o Claude vai até max; o Codex só low/medium/high', () => {
    expect([...CLI_EFFORTS.claude]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect([...CLI_EFFORTS.codex]).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect([...SANDBOX_MODES]).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
  });

  it('sandbox é aceito e validado; valores desconhecidos são rejeitados', () => {
    expect(parseChatOptions({ cli: 'codex', sandbox: 'read-only', model: 'gpt-x' })).toEqual({ cli: 'codex', sandbox: 'read-only', model: 'gpt-x' });
    for (const bad of ['rm', 5, '', 'workspace_write']) expect(parseChatOptions({ sandbox: bad })).toBeNull();
  });

  describe('optionsError (opções que não combinam com a CLI)', () => {
    it('opções válidas ou vazias não têm erro', () => {
      expect(optionsError(undefined)).toBeNull();
      expect(optionsError({ model: 'opus', effort: 'max', permissionMode: 'plan' })).toBeNull();
      expect(optionsError({ cli: 'codex', effort: 'high', sandbox: 'workspace-write' })).toBeNull();
    });
    it('esforço que a CLI não tem', () => {
      expect(optionsError({ effort: 'ultra' })).toMatch(/esforço.*claude/i); // ultra é só do Codex
      expect(optionsError({ cli: 'codex', effort: 'ultra' })).toBeNull();
    });
    it('permissões de uma CLI na outra', () => {
      expect(optionsError({ cli: 'codex', permissionMode: 'plan' })).toMatch(/permiss/i);
      expect(optionsError({ cli: 'claude', sandbox: 'read-only' })).toMatch(/sandbox|permiss/i);
      expect(optionsError({ sandbox: 'read-only' })).toMatch(/sandbox|permiss/i); // sem cli = claude
    });
  });
});
