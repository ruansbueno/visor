import { it, expect } from 'vitest';
import { buildClaudeArgs } from '../../src/cli/claude-args';

it('monta args mínimos do modo painel', () => {
  expect(buildClaudeArgs({ prompt: 'oi' })).toEqual([
    '-p', '--output-format', 'stream-json', '--verbose', '--', 'oi',
  ]);
});

it('inclui permissões, resume e settings antes do prompt', () => {
  expect(
    buildClaudeArgs({
      prompt: 'oi', permissionMode: 'acceptEdits',
      allowedTools: ['Bash(npm test:*)', 'Read'], disallowedTools: ['WebFetch'],
      resume: 'sess-1', settingsFile: '/tmp/s.json',
    }),
  ).toEqual([
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(npm test:*)', 'Read',
    '--disallowedTools', 'WebFetch',
    '--resume', 'sess-1',
    '--settings', '/tmp/s.json',
    '--', 'oi',
  ]);
});

it('o prompt vem depois de "--", então nunca é interpretado como flag', () => {
  const args = buildClaudeArgs({ prompt: '--dangerously-skip-permissions' });
  expect(args.slice(-2)).toEqual(['--', '--dangerously-skip-permissions']);
  expect(args).not.toContain('--permission-mode');
});

it('appendSystemPrompt vai antes do "--" e o prompt continua por último', () => {
  const args = buildClaudeArgs({ prompt: 'oi', appendSystemPrompt: 'instrução' });
  expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', 'instrução', '--', 'oi']);
});

it('model e effort entram antes do "--" e o prompt continua por último', () => {
  const args = buildClaudeArgs({ prompt: 'oi', model: 'opus', effort: 'high' });
  expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--effort', 'high', '--', 'oi']);
});

it('sem model/effort nada é acrescentado e --add-dir nunca é usado', () => {
  expect(buildClaudeArgs({ prompt: 'oi' })).not.toContain('--add-dir');
  expect(buildClaudeArgs({ prompt: 'oi' })).not.toContain('--model');
  expect(buildClaudeArgs({ prompt: 'oi' })).not.toContain('--effort');
});

it('cada regra de tool vai como argumento próprio (vírgula/espaço dentro de uma regra não a quebra)', () => {
  const args = buildClaudeArgs({ prompt: 'oi', allowedTools: ['Read(//a/b,c d.txt)', 'Bash(ls)'], disallowedTools: ['Edit(//x/y z)'] });
  expect(args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read(//a/b,c d.txt)', 'Bash(ls)', '--disallowedTools', 'Edit(//x/y z)', '--', 'oi']);
});
