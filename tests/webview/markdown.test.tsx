import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../../webview/markdown';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('negrito, itálico e código inline', () => {
    expect(html('um **forte**, um *leve* e `code`')).toBe('<p>um <strong>forte</strong>, um <em>leve</em> e <code>code</code></p>');
  });

  it('negrito dentro de itálico e vice-versa não quebram', () => {
    expect(html('**a *b* c**')).toContain('<strong>a <em>b</em> c</strong>');
  });

  it('HTML do agente é escapado, nunca interpretado', () => {
    const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script> **<b>x</b>**');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
    expect(out).toContain('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });

  it('links viram texto com a URL visível, sem <a> (nada clicável vindo do agente)', () => {
    const out = html('veja [a doc](https://exemplo.dev/x) e javascript:alert(1)');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
    expect(out).toContain('a doc (https://exemplo.dev/x)');
  });

  it('blocos de código preservam o conteúdo e ignoram markdown dentro', () => {
    const out = html('antes\n\n```ts\nconst a = **x**;\n```\n\ndepois');
    expect(out).toContain('<pre><code>const a = **x**;</code></pre>');
    expect(out).toContain('<p>antes</p>');
    expect(out).toContain('<p>depois</p>');
  });

  it('bloco de código sem fechamento vai até o fim sem lançar', () => {
    expect(html('```js\nabc')).toContain('<pre><code>abc</code></pre>');
  });

  it('o bloco visor-question é escondido (a pergunta aparece no cartão)', () => {
    const out = html('Qual cor?\n\n```visor-question\n{"question":"Qual cor?","options":["A"]}\n```');
    expect(out).toContain('Qual cor?');
    expect(out).not.toContain('visor-question');
    expect(out).not.toContain('options');
  });

  it('listas com marcadores e numeradas', () => {
    expect(html('- um\n- dois')).toBe('<ul><li>um</li><li>dois</li></ul>');
    expect(html('1. a\n2) b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('títulos viram elementos de destaque e citações blockquote', () => {
    expect(html('## Resumo')).toContain('class="md-h"');
    expect(html('> nota importante')).toContain('<blockquote>');
  });

  it('quebra de linha simples dentro do parágrafo vira <br>', () => {
    expect(html('linha 1\nlinha 2')).toBe('<p>linha 1<br/>linha 2</p>');
  });

  it('marcadores sem fechamento e entradas vazias ou estranhas não lançam', () => {
    for (const t of ['**aberto', '*só', '`sem fim', '[quebrado](', '', '   ', '\n\n', '***', '____', '`', '- ', '>']) {
      expect(() => html(t)).not.toThrow();
    }
    expect(html('')).toBe('');
    expect(html('2 * 3 * 4')).toContain('2 * 3 * 4');
  });

  it('texto grande é processado rápido', () => {
    const big = ('linha **negrito** e `código` e *itálico*\n').repeat(5000);
    const t0 = Date.now();
    html(big);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
