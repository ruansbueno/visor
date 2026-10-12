import { it, expect } from 'vitest';
import { buildClaudeArgs } from '../../src/cli/claude-args';

const BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool=stdio'];

it('monta args mínimos do modo painel (a mensagem vai pelo stdin, não pelos argumentos)', () => {
  expect(buildClaudeArgs({})).toEqual(BASE);
});

it('inclui permissões, resume e settings', () => {
  expect(
    buildClaudeArgs({
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash(npm test:*)', 'Read'], disallowedTools: ['WebFetch'],
      resume: 'sess-1', settingsFile: '/tmp/s.json',
    }),
  ).toEqual([
    ...BASE,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(npm test:*)', 'Read',
    '--disallowedTools', 'WebFetch',
    '--resume', 'sess-1',
    '--settings', '/tmp/s.json',
  ]);
});

it('nunca coloca prompt nos argumentos', () => {
  expect(buildClaudeArgs({ appendSystemPrompt: 'regra' })).not.toContain('--');
});

it('appendSystemPrompt entra nos argumentos', () => {
  expect(buildClaudeArgs({ appendSystemPrompt: 'instrução' })).toEqual([...BASE, '--append-system-prompt', 'instrução']);
});

it('model e effort entram nos argumentos', () => {
  expect(buildClaudeArgs({ model: 'opus', effort: 'high' })).toEqual([...BASE, '--model', 'opus', '--effort', 'high']);
});

it('sem model/effort nada é acrescentado e --add-dir nunca é usado', () => {
  const args = buildClaudeArgs({});
  expect(args).not.toContain('--add-dir');
  expect(args).not.toContain('--model');
  expect(args).not.toContain('--effort');
  expect(args).not.toContain('--permission-mode');
});

it('cada regra de tool vai como argumento próprio (vírgula/espaço dentro de uma regra não a quebra)', () => {
  expect(buildClaudeArgs({ allowedTools: ['Read(//a/b,c d.txt)', 'Bash(ls)'], disallowedTools: ['Edit(//x/y z)'] })).toEqual([
    ...BASE, '--allowedTools', 'Read(//a/b,c d.txt)', 'Bash(ls)', '--disallowedTools', 'Edit(//x/y z)',
  ]);
});
