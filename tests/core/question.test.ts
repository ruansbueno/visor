import { describe, it, expect } from 'vitest';
import { detectQuestion } from '../../src/core/question';

const marker = (json: string, before = 'Antes de seguir:') => `${before}\n\n\`\`\`visor-question\n${json}\n\`\`\``;

describe('detectQuestion', () => {
  it('bloco visor-question vira pergunta estruturada com opções', () => {
    const q = detectQuestion(marker('{"question":"Qual cor?","options":["Vermelho","Azul"]}'));
    expect(q).toEqual({ text: 'Qual cor?', options: ['Vermelho', 'Azul'], source: 'marker' });
  });

  it('options é opcional', () => {
    expect(detectQuestion(marker('{"question":"Posso continuar?"}'))).toEqual({ text: 'Posso continuar?', options: [], source: 'marker' });
  });

  it('usa o ÚLTIMO bloco quando há mais de um', () => {
    const t = marker('{"question":"antiga?"}') + '\n\n' + marker('{"question":"nova?"}');
    expect(detectQuestion(t)?.text).toBe('nova?');
  });

  it('JSON inválido, pergunta vazia ou tipos errados caem na heurística (ou null)', () => {
    expect(detectQuestion(marker('{não é json'))).toBeNull();
    expect(detectQuestion(marker('{"question":""}'))).toBeNull();
    expect(detectQuestion(marker('{"question":5}'))).toBeNull();
    expect(detectQuestion(marker('{"question":"ok?"}\n', 'texto sem pergunta.').replace('{"question":"ok?"}', '[1]'))).toBeNull();
  });

  it('opções inválidas são filtradas, limitadas a 8 e truncadas', () => {
    const opts = JSON.stringify(['a', '', 5, null, ...Array.from({ length: 12 }, (_, i) => `o${i}`), 'x'.repeat(500)]);
    const q = detectQuestion(marker(`{"question":"q?","options":${opts}}`))!;
    expect(q.options.length).toBe(8);
    expect(q.options.every((o) => o.length <= 200 && o.length > 0)).toBe(true);
  });

  it('heurística: última linha terminando em ? vira pergunta sem opções', () => {
    expect(detectQuestion('Analisei o código.\n\n**Qual cor você prefere, vermelho ou azul?**')).toEqual({
      text: 'Qual cor você prefere, vermelho ou azul?', options: [], source: 'heuristic',
    });
  });

  it('heurística aceita ? seguido de aspas, parênteses ou ponto de markdown e a variante ？', () => {
    expect(detectQuestion('Tudo certo. Quer que eu continue (sim/não)?)')?.source).toBe('heuristic');
    expect(detectQuestion('Pode ser "assim"?"')?.source).toBe('heuristic');
    expect(detectQuestion('これでいいですか？')?.source).toBe('heuristic');
  });

  it('? no meio do texto ou dentro de bloco de código não conta', () => {
    expect(detectQuestion('Isso é uma dúvida? Não, é uma afirmação. Feito.')).toBeNull();
    expect(detectQuestion('Resultado:\n```js\nconst x = a ? b : c;\nfoo()?\n```\nPronto.')).toBeNull();
  });

  it('texto vazio, só espaços ou não-string devolve null', () => {
    expect(detectQuestion('')).toBeNull();
    expect(detectQuestion('   \n ')).toBeNull();
    expect(detectQuestion(undefined as unknown as string)).toBeNull();
  });

  it('pergunta muito longa é truncada', () => {
    const q = detectQuestion('x'.repeat(5000) + '?')!;
    expect(q.text.length).toBeLessThanOrEqual(1001);
  });

  it('URL terminando em "?" não é pergunta', () => {
    expect(detectQuestion('Veja a documentação em https://exemplo.dev/busca?')).toBeNull();
    expect(detectQuestion('Quer que eu abra https://exemplo.dev/a por você?')?.source).toBe('heuristic');
  });
});
