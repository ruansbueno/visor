import { ALL_EFFORTS, type Effort } from '../core/options';
import type { ModelInfo } from '../protocol';

/** Argumentos que o catálogo de modelos do próprio Codex usa (só lista; não toca em credenciais). */
export const CODEX_MODELS_ARGS = ['debug', 'models'];

/** `codex debug models` -> só os modelos listados (visibility "list"), com os esforços que cada um aceita. Entrada inválida = []. */
export function parseCodexModels(stdout: string): ModelInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const models = (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];
  const out: ModelInfo[] = [];
  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const { slug, display_name, visibility, supported_reasoning_levels } = m as Record<string, unknown>;
    if (typeof slug !== 'string' || visibility !== 'list') continue;
    const efforts = (Array.isArray(supported_reasoning_levels) ? supported_reasoning_levels : [])
      .map((e) => (e as { effort?: unknown } | null)?.effort)
      .filter((e): e is Effort => (ALL_EFFORTS as readonly unknown[]).includes(e));
    out.push({ id: slug, label: typeof display_name === 'string' && display_name ? display_name : slug, efforts });
  }
  return out;
}
