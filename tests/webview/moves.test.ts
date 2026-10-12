import { describe, it, expect } from 'vitest';
import { toMove, toMoves } from '../../webview/moves';
import type { NodeChange } from '@xyflow/react';

const nodes = [
  { id: 'c', position: { x: 10, y: 20 }, width: 400, height: 300, type: 'chat' },
  { id: 'a', position: { x: 5, y: 6 }, type: 'agent' },
] as any[];

describe('toMove (mudança do React Flow -> posição a guardar)', () => {
  it('arrastando: atualiza a posição na hora, mas só persiste ao soltar', () => {
    const mid = toMove({ type: 'position', id: 'a', position: { x: 50, y: 60 }, dragging: true } as NodeChange, nodes);
    expect(mid).toEqual({ nodeId: 'a', box: { x: 50, y: 60 }, persist: false });
    const end = toMove({ type: 'position', id: 'a', position: { x: 52, y: 61 }, dragging: false } as NodeChange, nodes);
    expect(end).toEqual({ nodeId: 'a', box: { x: 52, y: 61 }, persist: true });
  });

  it('mover o cartão preserva o tamanho atual', () => {
    const m = toMove({ type: 'position', id: 'c', position: { x: 0, y: 0 }, dragging: false } as NodeChange, nodes);
    expect(m).toEqual({ nodeId: 'c', box: { x: 0, y: 0, width: 400, height: 300 }, persist: true });
  });

  it('redimensionando: persiste só ao terminar; medições automáticas (sem resizing) são ignoradas', () => {
    const during = toMove({ type: 'dimensions', id: 'c', dimensions: { width: 500, height: 350 }, resizing: true } as NodeChange, nodes);
    expect(during).toEqual({ nodeId: 'c', box: { x: 10, y: 20, width: 500, height: 350 }, persist: false });
    const done = toMove({ type: 'dimensions', id: 'c', dimensions: { width: 520, height: 360 }, resizing: false } as NodeChange, nodes);
    expect(done!.persist).toBe(true);
    expect(toMove({ type: 'dimensions', id: 'c', dimensions: { width: 1, height: 1 } } as NodeChange, nodes)).toBeNull();
  });

  it('mudanças sem posição, de outro tipo ou de node desconhecido são ignoradas', () => {
    expect(toMove({ type: 'position', id: 'a', dragging: true } as NodeChange, nodes)).toBeNull();
    expect(toMove({ type: 'select', id: 'a', selected: true } as NodeChange, nodes)).toBeNull();
    expect(toMove({ type: 'position', id: 'zz', position: { x: 1, y: 1 }, dragging: false } as NodeChange, nodes)).toBeNull();
    expect(toMove({ type: 'dimensions', id: 'a', dimensions: { width: 9, height: 9 }, resizing: false } as NodeChange, nodes)).toEqual({
      nodeId: 'a', box: { x: 5, y: 6 }, persist: false, // agentes não são redimensionáveis: nada a guardar
    });
  });
});

describe('toMoves (lote de mudanças do React Flow)', () => {
  it('posição + tamanho no mesmo lote (alça de cima/esquerda) viram UMA mudança com os dois', () => {
    const out = toMoves(
      [
        { type: 'position', id: 'c', position: { x: -40, y: 20 } },
        { type: 'dimensions', id: 'c', dimensions: { width: 540, height: 300 }, resizing: true },
      ] as NodeChange[],
      nodes,
    );
    expect(out).toEqual([{ nodeId: 'c', box: { x: -40, y: 20, width: 540, height: 300 }, persist: false }]);
  });

  it('na ordem inversa (tamanho, depois posição) o resultado é o mesmo', () => {
    const out = toMoves(
      [
        { type: 'dimensions', id: 'c', dimensions: { width: 540, height: 300 }, resizing: true },
        { type: 'position', id: 'c', position: { x: -40, y: 20 } },
      ] as NodeChange[],
      nodes,
    );
    expect(out[0]!.box).toEqual({ x: -40, y: 20, width: 540, height: 300 });
  });

  it('persist vale se qualquer mudança do node no lote pedir; nodes diferentes ficam separados', () => {
    const out = toMoves(
      [
        { type: 'position', id: 'a', position: { x: 1, y: 2 }, dragging: false },
        { type: 'position', id: 'c', position: { x: 3, y: 4 }, dragging: true },
        { type: 'select', id: 'a', selected: true },
      ] as NodeChange[],
      nodes,
    );
    expect(out).toEqual([
      { nodeId: 'a', box: { x: 1, y: 2 }, persist: true },
      { nodeId: 'c', box: { x: 3, y: 4, width: 400, height: 300 }, persist: false },
    ]);
  });

  it('lote vazio ou só de seleção não gera movimentos', () => {
    expect(toMoves([], nodes)).toEqual([]);
    expect(toMoves([{ type: 'select', id: 'a', selected: true }] as NodeChange[], nodes)).toEqual([]);
  });
});
