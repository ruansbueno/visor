import { describe, it, expect } from 'vitest';
import { stabilizeNodes } from '../../webview/stable';

const node = (id: string, over: Record<string, unknown> = {}, data: Record<string, unknown> = { a: 1 }) =>
  ({ id, type: 'agent', position: { x: 1, y: 2 }, data, ...over }) as any;

describe('stabilizeNodes (mantém a identidade dos nodes que não mudaram)', () => {
  it('reaproveita o mesmo objeto quando nada mudou, mesmo vindo de objetos novos', () => {
    const prev = new Map<string, any>();
    const first = stabilizeNodes(prev, [node('a'), node('b')]);
    const second = stabilizeNodes(prev, [node('a'), node('b')]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('só o node que mudou (posição, tamanho, selected ou dados) ganha objeto novo', () => {
    const prev = new Map<string, any>();
    const first = stabilizeNodes(prev, [node('a'), node('b'), node('c'), node('d')]);
    const second = stabilizeNodes(prev, [
      node('a', { position: { x: 9, y: 2 } }),
      node('b'),
      node('c', { selected: true }),
      node('d', {}, { a: 2 }),
    ]);
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[3]).not.toBe(first[3]);
  });

  it('compara dados por identidade das referências internas (ex.: o log do chat)', () => {
    const log = { events: [] };
    const prev = new Map<string, any>();
    const first = stabilizeNodes(prev, [node('a', {}, { log, t: 'x' })]);
    expect(stabilizeNodes(prev, [node('a', {}, { log, t: 'x' })])[0]).toBe(first[0]);
    expect(stabilizeNodes(prev, [node('a', {}, { log: { events: [] }, t: 'x' })])[0]).not.toBe(first[0]);
  });

  it('esquece nodes que sumiram e preserva a ordem recebida', () => {
    const prev = new Map<string, any>();
    stabilizeNodes(prev, [node('a'), node('b')]);
    const out = stabilizeNodes(prev, [node('b')]);
    expect(out.map((n: any) => n.id)).toEqual(['b']);
    expect([...prev.keys()]).toEqual(['b']);
  });
});
