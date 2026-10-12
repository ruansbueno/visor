import { describe, it, expect } from 'vitest';
import { permissionResponseLine, userMessageLine } from '../../src/cli/claude-input';

describe('userMessageLine', () => {
  it('é uma linha JSON de mensagem de usuário terminada em \\n', () => {
    const line = userMessageLine('oi');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: 'oi' } });
  });

  it('preserva aspas, quebras de linha e Unicode', () => {
    const text = 'linha 1\n"aspas" \\ barra\n日本語 🎉';
    expect(JSON.parse(userMessageLine(text)).message.content).toBe(text);
    expect(userMessageLine(text).slice(0, -1).includes('\n')).toBe(false);
  });
});

describe('permissionResponseLine', () => {
  it('allow leva updatedInput e, se houver, updatedPermissions', () => {
    const line = permissionResponseLine('req-1', { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ type: 'addRules' }] });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ type: 'addRules' }] } },
    });
  });

  it('deny leva a mensagem', () => {
    expect(JSON.parse(permissionResponseLine('req-2', { behavior: 'deny', message: 'não' })).response.response).toEqual({ behavior: 'deny', message: 'não' });
  });
});
