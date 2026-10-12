import { describe, it, expect } from 'vitest';
import { layoutTree, layoutForest } from '../../src/core/layout';

const n = (id: string, parentId: string | null = null) => ({ id, parentId });

describe('layoutTree', () => {
  it('um node fica na origem', () => {
    expect(layoutTree([n('r')]).get('r')).toEqual({ x: 0, y: 0 });
  });

  it('raiz centralizada sobre dois filhos', () => {
    const p = layoutTree([n('r'), n('a', 'r'), n('b', 'r')]);
    expect(p.get('a')).toEqual({ x: 0, y: 120 });
    expect(p.get('b')).toEqual({ x: 220, y: 120 });
    expect(p.get('r')).toEqual({ x: 110, y: 0 });
  });

  it('filhos em paralelo mantêm a ordem de inserção', () => {
    const p = layoutTree([n('r'), n('c', 'r'), n('a', 'r'), n('b', 'r')]);
    expect(['c', 'a', 'b'].map((id) => p.get(id)!.x)).toEqual([0, 220, 440]);
  });

  it('cadeia cresce para baixo no mesmo x', () => {
    const p = layoutTree([n('r'), n('a', 'r'), n('b', 'a')]);
    expect([p.get('r'), p.get('a'), p.get('b')]).toEqual([{ x: 0, y: 0 }, { x: 0, y: 120 }, { x: 0, y: 240 }]);
  });

  it('respeita hGap e vGap', () => {
    const p = layoutTree([n('r'), n('a', 'r'), n('b', 'r')], { hGap: 100, vGap: 50 });
    expect(p.get('b')).toEqual({ x: 100, y: 50 });
  });

  it('pai desconhecido vira raiz em vez de sumir', () => {
    const p = layoutTree([n('r'), n('x', 'nao-existe')]);
    expect(p.has('x')).toBe(true);
    expect(p.get('x')!.y).toBe(0);
  });

  it('ciclo e auto-referência não travam e posicionam todos', () => {
    const p = layoutTree([n('a', 'b'), n('b', 'a'), n('s', 's')]);
    expect(p.size).toBe(3);
  });

  it('lista vazia devolve mapa vazio', () => {
    expect(layoutTree([]).size).toBe(0);
  });

  it('100 filhos em paralelo: o último fica em 99 * hGap e a raiz no meio', () => {
    const nodes = [n('r'), ...Array.from({ length: 100 }, (_, i) => n(`c${i}`, 'r'))];
    const p = layoutTree(nodes);
    expect(p.get('c99')!.x).toBe(99 * 220);
    expect(p.get('r')!.x).toBe((99 * 220) / 2);
  });
});

describe('layoutForest', () => {
  it('uma árvore igual ao layoutTree, deslocada para x >= 0', () => {
    const f = layoutForest([[n('r'), n('a', 'r'), n('b', 'r')]]);
    expect(f.get('a')).toEqual({ x: 0, y: 120 });
    expect(f.get('b')).toEqual({ x: 220, y: 120 });
  });

  it('árvores ficam lado a lado, sem sobreposição, na ordem recebida', () => {
    const f = layoutForest([
      [n('r1'), n('a', 'r1'), n('b', 'r1')],
      [n('r2'), n('c', 'r2')],
    ]);
    const xs1 = ['r1', 'a', 'b'].map((id) => f.get(id)!.x);
    const xs2 = ['r2', 'c'].map((id) => f.get(id)!.x);
    expect(Math.min(...xs2)).toBeGreaterThan(Math.max(...xs1));
    expect(Math.min(...xs2) - Math.max(...xs1)).toBeGreaterThanOrEqual(220 + 100);
    expect(f.get('r1')!.y).toBe(0);
    expect(f.get('r2')!.y).toBe(0);
  });

  it('árvores vazias são ignoradas e todos os nodes são posicionados', () => {
    const f = layoutForest([[], [n('r')], [], [n('s')]]);
    expect(f.size).toBe(2);
    expect(f.get('s')!.x).toBeGreaterThan(f.get('r')!.x);
  });

  it('lista vazia devolve mapa vazio', () => {
    expect(layoutForest([]).size).toBe(0);
  });

  it('com rootHeight/rootGap os filhos ficam abaixo do cartão da raiz (y = altura + folga + níveis seguintes)', () => {
    const f = layoutForest([[n('r'), n('a', 'r'), n('b', 'r'), n('c', 'a')]], { rootHeight: 340, rootGap: 80 });
    expect(f.get('r')!.y).toBe(0);
    expect(f.get('a')!.y).toBe(420);
    expect(f.get('b')!.y).toBe(420);
    expect(f.get('c')!.y).toBe(420 + 120);
  });

  it('minTreeWidth garante largura mínima por árvore: raízes largas (cartões) nunca se sobrepõem', () => {
    const opts = { rootHeight: 340, rootGap: 80, minTreeWidth: 440 };
    const f = layoutForest([[n('r1'), n('a', 'r1')], [n('r2'), n('b', 'r2')], [n('r3')]], opts);
    const c = (id: string) => f.get(id)!.x;
    expect(c('r2') - c('r1')).toBeGreaterThanOrEqual(440);
    expect(c('r3') - c('r2')).toBeGreaterThanOrEqual(440);
    expect(c('r1')).toBe(c('a')); // a raiz fica centralizada sobre o único filho
  });

  it('sem opções o comportamento anterior é mantido', () => {
    const f = layoutForest([[n('r'), n('a', 'r')]]);
    expect(f.get('a')).toEqual({ x: 0, y: 120 });
  });
});
