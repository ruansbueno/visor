import { describe, it, expect } from 'vitest';
import { parseSettings, DEFAULT_SETTINGS, PERMISSION_MODES } from '../../src/ext/settings';

const from = (o: Record<string, unknown>) => parseSettings((k) => o[k]);

describe('parseSettings', () => {
  it('sem nada configurado devolve os padrões conservadores', () => {
    expect(from({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ claudePath: 'claude', permissionMode: 'acceptEdits', allowedTools: [], disallowedTools: [], parallelWarningThreshold: 4, codexPath: 'codex', codexSandbox: 'workspace-write', debugLog: false, lingerTimeoutMinutes: 10 });
  });

  it('aceita valores válidos', () => {
    expect(from({ claudePath: '/opt/claude', permissionMode: 'plan', allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: ['WebFetch'], parallelWarningThreshold: 6, codexPath: '/opt/codex' }))
      .toEqual({ claudePath: '/opt/claude', permissionMode: 'plan', allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: ['WebFetch'], parallelWarningThreshold: 6, codexPath: '/opt/codex', codexSandbox: 'workspace-write', debugLog: false, lingerTimeoutMinutes: 10 });
  });

  it('modo inválido volta ao padrão, nunca vira bypass por acidente', () => {
    expect(from({ permissionMode: 'bypass' }).permissionMode).toBe('acceptEdits');
    expect(from({ permissionMode: 42 }).permissionMode).toBe('acceptEdits');
  });

  it('claudePath vazio ou não-string volta ao padrão', () => {
    expect(from({ claudePath: '   ' }).claudePath).toBe('claude');
    expect(from({ claudePath: 3 }).claudePath).toBe('claude');
  });

  it('listas descartam itens que não são strings não vazias', () => {
    expect(from({ allowedTools: ['Read', '', 5, null, ' Edit '] }).allowedTools).toEqual(['Read', 'Edit']);
    expect(from({ allowedTools: 'Read' }).allowedTools).toEqual([]);
  });

  it('PERMISSION_MODES cobre os modos do CLI 2.1.267', () => {
    expect([...PERMISSION_MODES].sort()).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan']);
  });

  it('parallelWarningThreshold: inteiro >= 0 (0 desliga); inválido volta ao padrão', () => {
    expect(from({ parallelWarningThreshold: 0 }).parallelWarningThreshold).toBe(0);
    expect(from({ parallelWarningThreshold: 2.7 }).parallelWarningThreshold).toBe(2);
    for (const v of [-1, 'x', null, NaN, Infinity]) expect(from({ parallelWarningThreshold: v }).parallelWarningThreshold).toBe(4);
  });

  it('codexPath vazio ou inválido volta ao padrão', () => {
    expect(from({ codexPath: '  ' }).codexPath).toBe('codex');
    expect(from({ codexPath: 3 }).codexPath).toBe('codex');
  });

  it('debugLog só liga com true de verdade', () => {
    expect(from({ debugLog: true }).debugLog).toBe(true);
    expect(from({ debugLog: 'true' }).debugLog).toBe(false);
    expect(from({ debugLog: 1 }).debugLog).toBe(false);
  });

  it('lingerTimeoutMinutes aceita 0 (desliga) e frações; inválido volta a 10', () => {
    expect(from({ lingerTimeoutMinutes: 0 }).lingerTimeoutMinutes).toBe(0);
    expect(from({ lingerTimeoutMinutes: 2.5 }).lingerTimeoutMinutes).toBe(2.5);
    expect(from({ lingerTimeoutMinutes: -1 }).lingerTimeoutMinutes).toBe(10);
    expect(from({ lingerTimeoutMinutes: Number.NaN }).lingerTimeoutMinutes).toBe(10);
    expect(from({ lingerTimeoutMinutes: '5' }).lingerTimeoutMinutes).toBe(10);
  });
});

describe('codexSandbox', () => {
  it('padrão workspace-write; aceita os três modos; inválido volta ao padrão', () => {
    const from = (o: Record<string, unknown>) => parseSettings((k) => o[k]);
    expect(from({}).codexSandbox).toBe('workspace-write');
    expect(from({ codexSandbox: 'read-only' }).codexSandbox).toBe('read-only');
    expect(from({ codexSandbox: 'danger-full-access' }).codexSandbox).toBe('danger-full-access');
    for (const v of ['x', 3, null]) expect(from({ codexSandbox: v }).codexSandbox).toBe('workspace-write');
  });
});
