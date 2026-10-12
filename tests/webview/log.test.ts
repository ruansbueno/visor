import { describe, it, expect } from 'vitest';
import { toLogItems, resultText, summarizeInput } from '../../webview/log';
import type { EventView } from '../../src/protocol';

let n = 0;
const ev = (kind: EventView['kind'], payload: unknown): EventView => ({ id: `e${++n}`, seq: n, ts: n, kind, payload });
const call = (id: string, name: string, input: unknown) => ev('tool_call', { id, name, input });
const res = (id: string, content: unknown, is_error = false) => ev('tool_result', { tool_use_id: id, content, is_error });

describe('toLogItems', () => {
  it('mensagens de texto mantêm o papel, na ordem', () => {
    const items = toLogItems([ev('message', { role: 'user', text: 'faça X' }), ev('message', { role: 'assistant', text: 'ok' })]);
    expect(items.map((i) => (i.kind === 'text' ? [i.role, i.text] : null))).toEqual([['user', 'faça X'], ['assistant', 'ok']]);
  });

  it('payload de mensagem antigo (string) vira texto do assistente', () => {
    expect(toLogItems([ev('message', 'oi')])).toMatchObject([{ kind: 'text', role: 'assistant', text: 'oi' }]);
  });

  it('tool call pareada com o resultado vira um item "done" com o texto', () => {
    const items = toLogItems([call('t1', 'Read', { file_path: 'notes.txt' }), res('t1', [{ type: 'text', text: 'hello' }])]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', name: 'Read', summary: 'notes.txt', status: 'done', result: 'hello' });
  });

  it('resultado com is_error vira status error', () => {
    expect(toLogItems([call('t1', 'Bash', { command: 'x' }), res('t1', 'boom', true)])[0]).toMatchObject({ status: 'error', result: 'boom' });
  });

  it('tool call sem resultado fica running', () => {
    expect(toLogItems([call('t1', 'Bash', { command: 'sleep 9' })])[0]).toMatchObject({ kind: 'tool', status: 'running' });
  });

  it('o resultado pode chegar fora de ordem entre chamadas paralelas', () => {
    const items = toLogItems([call('a', 'Read', { file_path: 'a' }), call('b', 'Read', { file_path: 'b' }), res('b', 'B'), res('a', 'A')]);
    expect(items.map((i) => (i.kind === 'tool' ? [i.summary, i.result] : null))).toEqual([['a', 'A'], ['b', 'B']]);
  });

  it('resultado sem chamada correspondente aparece como item "result" (resultado final do subagente)', () => {
    const items = toLogItems([ev('tool_result', [{ type: 'text', text: 'alpha' }])]);
    expect(items).toMatchObject([{ kind: 'result', text: 'alpha' }]);
  });

  it('tool_result órfão com id desconhecido não some', () => {
    expect(toLogItems([res('zzz', 'x')])).toMatchObject([{ kind: 'result', text: 'x' }]);
  });

  it('evento de erro vira item "error"', () => {
    expect(toLogItems([ev('error', 'falhou')])).toMatchObject([{ kind: 'error', text: 'falhou' }]);
  });

  it('payloads de hooks (sem id) e formas estranhas não lançam', () => {
    expect(() => toLogItems([ev('tool_call', { name: 'Read', input: {} }), ev('tool_result', { name: 'Read', response: 'x' }), ev('message', null), ev('tool_call', 5), ev('tool_result', undefined)])).not.toThrow();
  });

  it('as chaves dos itens são únicas e estáveis', () => {
    const evs = [ev('message', { role: 'user', text: 'a' }), call('t', 'Read', {}), res('t', 'x')];
    const k1 = toLogItems(evs).map((i) => i.key);
    expect(new Set(k1).size).toBe(k1.length);
    expect(toLogItems(evs).map((i) => i.key)).toEqual(k1);
  });
});

describe('anexos na mensagem do usuário', () => {
  it('a mensagem leva os nomes dos arquivos anexados', () => {
    const items = toLogItems([ev('message', { role: 'user', text: 'olhe', attachments: ['a.ts', 'b.png'] })]);
    expect(items).toMatchObject([{ kind: 'text', role: 'user', text: 'olhe', attachments: ['a.ts', 'b.png'] }]);
  });
  it('só anexos, sem texto, ainda aparece; anexos inválidos são ignorados', () => {
    expect(toLogItems([ev('message', { role: 'user', text: '', attachments: ['x.txt'] })])).toHaveLength(1);
    const bad = toLogItems([ev('message', { role: 'user', text: 'oi', attachments: [1, null, 'ok.txt'] })]);
    expect((bad[0] as any).attachments).toEqual(['ok.txt']);
  });
});

describe('resultText', () => {
  it('string, lista de blocos de texto, outros blocos e objetos', () => {
    expect(resultText('abc')).toBe('abc');
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(resultText([{ type: 'image' }])).toBe('[{"type":"image"}]');
    expect(resultText({ a: 1 })).toBe('{"a":1}');
    expect(resultText(null)).toBe('');
    expect(resultText(undefined)).toBe('');
  });
});

describe('summarizeInput', () => {
  it.each([
    ['Read', { file_path: 'a/b.ts' }, 'a/b.ts'],
    ['Bash', { command: 'npm test' }, 'npm test'],
    ['Grep', { pattern: 'foo', path: 'src' }, 'foo'],
    ['Agent', { description: 'Echo alpha', subagent_type: 'echo' }, 'Echo alpha'],
    ['WebFetch', { url: 'https://x.dev' }, 'https://x.dev'],
  ])('%s', (name, input, out) => expect(summarizeInput(name, input)).toBe(out));

  it('trunca resumos longos e cai em JSON quando não há campo conhecido', () => {
    expect(summarizeInput('Bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(81);
    expect(summarizeInput('Custom', { foo: 1 })).toBe('{"foo":1}');
    expect(summarizeInput('Custom', undefined)).toBe('');
  });
});
