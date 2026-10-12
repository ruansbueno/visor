import { describe, it, expect } from 'vitest';
import { parseChatOptions, parseAttachments, PERMISSION_MODES, EFFORT_LEVELS } from '../../src/core/options';

describe('parseChatOptions', () => {
  it('aceita campos válidos e descarta chaves desconhecidas', () => {
    expect(parseChatOptions({ cli: 'claude', model: 'opus', effort: 'high', permissionMode: 'plan', evil: 1 })).toEqual({ cli: 'claude', model: 'opus', effort: 'high', permissionMode: 'plan' });
  });
  it('objeto vazio ou ausente significa "padrões" (undefined)', () => {
    expect(parseChatOptions(undefined)).toBeUndefined();
    expect(parseChatOptions({})).toBeUndefined();
    expect(parseChatOptions({ model: '' })).toBeUndefined();
  });
  it('modelo: alias ou id completo, com caracteres seguros', () => {
    for (const m of ['opus', 'claude-opus-5-5', 'claude-sonnet-5-5[1m]', 'us.anthropic.claude-x:1']) expect(parseChatOptions({ model: m })).toEqual({ model: m });
  });
  it.each([
    [{ model: '--dangerously-skip-permissions' }], [{ model: 'a b' }], [{ model: 'a;rm' }], [{ model: 'x'.repeat(101) }], [{ model: 5 }],
    [{ effort: 'bogus' }], [{ effort: 3 }], [{ permissionMode: 'god' }], [{ cli: 'rm' }], ['x'], [[]], [5],
  ])('rejeita valores inválidos %j', (raw) => {
    expect(parseChatOptions(raw)).toBeNull();
  });
  it('cobre os modos e esforços do CLI', () => {
    expect([...PERMISSION_MODES].sort()).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan']);
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('parseAttachments', () => {
  it('ausente vira lista vazia; caminhos absolutos (unix e windows) são aceitos', () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments(['/a/b.txt', 'C:\\x\\y.png', 'D:/z'])).toEqual(['/a/b.txt', 'C:\\x\\y.png', 'D:/z']);
  });
  it.each([
    [['relativo/a.txt']], [['']], [['/a\0b']], [['/a\nb']], [[5]], ['/a'], [Array.from({ length: 11 }, (_, i) => `/f${i}`)], [['/' + 'x'.repeat(1001)]],
  ])('rejeita %j', (raw) => {
    expect(parseAttachments(raw)).toBeNull();
  });
  it('remove duplicatas mantendo a ordem', () => {
    expect(parseAttachments(['/a', '/b', '/a'])).toEqual(['/a', '/b']);
  });
});
