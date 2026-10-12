import { describe, it, expect } from 'vitest';
import { formatDuration, STATUS_LABEL, STATUS_GLYPH } from '../../webview/format';

describe('formatDuration', () => {
  it.each([
    [0, '0ms'], [850, '850ms'], [1200, '1.2s'], [59_900, '59.9s'],
    [60_000, '1m 00s'], [65_000, '1m 05s'], [3_720_000, '1h 02m'],
  ])('%i -> %s', (ms, out) => expect(formatDuration(ms)).toBe(out));

  it('valores negativos ou inválidos viram 0ms', () => {
    expect(formatDuration(-5)).toBe('0ms');
    expect(formatDuration(NaN)).toBe('0ms');
  });
});

describe('rótulos de status', () => {
  it('todo status tem rótulo e glifo, e os glifos são distintos (não só cor)', () => {
    const keys = ['pending', 'running', 'waiting', 'done', 'error', 'cancelled'] as const;
    for (const k of keys) { expect(STATUS_LABEL[k]).toBeTruthy(); expect(STATUS_GLYPH[k]).toBeTruthy(); }
    expect(new Set(keys.map((k) => STATUS_GLYPH[k])).size).toBe(6);
  });
});
