import { describe, it, expect } from 'vitest';
import { alwaysSuggestion, cleanLabel, summarizeToolInput } from '../../src/core/permission';

describe('summarizeToolInput', () => {
  it('Bash mostra o comando', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test', description: 'Roda os testes' })).toBe('npm test');
  });
  it('Edit/Write/Read mostram o caminho', () => {
    expect(summarizeToolInput('Edit', { file_path: '/p/a.ts', old_string: 'x' })).toBe('/p/a.ts');
    expect(summarizeToolInput('Read', { file_path: '/p/b.ts' })).toBe('/p/b.ts');
  });
  it('outras ferramentas mostram o JSON da entrada', () => {
    expect(summarizeToolInput('WebFetch', { url: 'https://x.dev' })).toBe('{"url":"https://x.dev"}');
  });
  it('sem entrada útil usa a descrição', () => {
    expect(summarizeToolInput('Foo', {}, 'faz algo')).toBe('faz algo');
  });
  it('limita o tamanho mas mostra o começo E o fim (o fim do comando não pode ficar escondido)', () => {
    const cmd = 'ls ' + ' '.repeat(5000) + '; rm -rf ~';
    const s = summarizeToolInput('Bash', { command: cmd });
    expect(s.length).toBeLessThanOrEqual(2003);
    expect(s.startsWith('ls ')).toBe(true);
    expect(s.endsWith('; rm -rf ~')).toBe(true);
    expect(s).toContain('…');
  });
  it('texto curto não é alterado', () => {
    expect(summarizeToolInput('Bash', { command: 'a'.repeat(2000) })).toBe('a'.repeat(2000));
  });
  it('remove controles, largura zero e marcas bidi', () => {
    expect(summarizeToolInput('Bash', { command: 'ls\u0000\u202e -la\u200b' })).toBe('ls -la');
  });
  it('remove também controles C1, marca de letra árabe, separadores de linha/parágrafo e word joiner', () => {
    expect(summarizeToolInput('Bash', { command: 'a\u009bb\u0085c\u061cd\u2028e\u2029f\u2060g' })).toBe('abcdefg');
  });
});

describe('alwaysSuggestion', () => {
  const add = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' };
  it('devolve a primeira addRules de allow', () => {
    expect(alwaysSuggestion([{ type: 'addDirectories', directories: ['/p'] }, add])).toBe(add);
  });
  it('ignora regras que não são allow e entradas inválidas', () => {
    expect(alwaysSuggestion([{ type: 'addRules', behavior: 'deny' }, null, 7, 'x'])).toBeUndefined();
    expect(alwaysSuggestion([])).toBeUndefined();
  });
});

describe('cleanLabel', () => {
  it('limpa o nome da ferramenta e limita o tamanho', () => {
    expect(cleanLabel('Ba\u202esh\u0000')).toBe('Bash');
    expect(cleanLabel('x'.repeat(500)).length).toBeLessThanOrEqual(101);
  });
});
