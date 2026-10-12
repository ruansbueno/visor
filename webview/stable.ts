interface StableNode {
  id: string;
  type?: string;
  dragHandle?: string;
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  selected?: boolean;
  data: Record<string, unknown>;
}

const sameData = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]));
};

const sameNode = (a: StableNode, b: StableNode): boolean =>
  a.type === b.type && a.dragHandle === b.dragHandle && a.position.x === b.position.x && a.position.y === b.position.y &&
  a.width === b.width && a.height === b.height && !!a.selected === !!b.selected && sameData(a.data, b.data);

/**
 * O React Flow compara nodes por referência: devolver objetos novos a cada render re-renderiza todos os cartões
 * (com markdown) a cada flush. Aqui só o node que realmente mudou ganha um objeto novo.
 */
export function stabilizeNodes<T extends StableNode>(prev: Map<string, T>, next: T[]): T[] {
  const out = next.map((n) => {
    const p = prev.get(n.id);
    return p && sameNode(p, n) ? p : n;
  });
  prev.clear();
  for (const n of out) prev.set(n.id, n);
  return out;
}
