export interface LayoutInput {
  id: string;
  parentId: string | null;
}
export interface LayoutOptions {
  hGap?: number;
  vGap?: number;
}

export function layoutTree(nodes: LayoutInput[], opts: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const hGap = opts.hGap ?? 220;
  const vGap = opts.vGap ?? 120;
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const n of nodes) {
    if (n.parentId && n.parentId !== n.id && ids.has(n.parentId)) {
      const list = children.get(n.parentId) ?? [];
      list.push(n.id);
      children.set(n.parentId, list);
    } else {
      roots.push(n.id);
    }
  }

  const pos = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  let nextLeaf = 0;

  const place = (id: string, depth: number): number => {
    visited.add(id);
    const kids = (children.get(id) ?? []).filter((k) => !visited.has(k));
    let x: number;
    if (kids.length === 0) {
      x = nextLeaf * hGap;
      nextLeaf += 1;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    pos.set(id, { x, y: depth * vGap });
    return x;
  };

  for (const r of roots) if (!visited.has(r)) place(r, 0);
  // Ciclos sem raiz: posiciona o que sobrou.
  for (const n of nodes) if (!visited.has(n.id)) place(n.id, 0);
  return pos;
}

export interface ForestOptions extends LayoutOptions {
  /** espaço horizontal extra entre árvores */
  treeGap?: number;
  /** altura do node raiz (cartão de chat); os filhos ficam abaixo dela */
  rootHeight?: number;
  /** folga vertical entre a raiz e o primeiro nível de filhos (com rootHeight) */
  rootGap?: number;
  /** largura mínima que cada árvore ocupa (o cartão da raiz é mais largo que um agente) */
  minTreeWidth?: number;
}

/** Posiciona várias árvores (uma por chat) lado a lado, na ordem recebida, sem sobreposição. Coordenadas são centros. */
export function layoutForest(trees: LayoutInput[][], opts: ForestOptions = {}): Map<string, { x: number; y: number }> {
  const hGap = opts.hGap ?? 220;
  const vGap = opts.vGap ?? 120;
  const treeGap = opts.treeGap ?? 120;
  const out = new Map<string, { x: number; y: number }>();
  let offset = 0;
  for (const tree of trees) {
    if (tree.length === 0) continue;
    const pos = layoutTree(tree, opts);
    const xs = [...pos.values()].map((p) => p.x);
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    // Árvores estreitas ganham folga dos dois lados até a largura mínima (a raiz larga fica centralizada).
    const extra = Math.max(0, ((opts.minTreeWidth ?? 0) - hGap - (max - min)) / 2);
    for (const [id, p] of pos) {
      const depth = Math.round(p.y / vGap);
      const y = opts.rootHeight === undefined || depth === 0 ? p.y : opts.rootHeight + (opts.rootGap ?? 80) + (depth - 1) * vGap;
      out.set(id, { x: p.x - min + offset + extra, y });
    }
    offset += max - min + 2 * extra + hGap + treeGap;
  }
  return out;
}
