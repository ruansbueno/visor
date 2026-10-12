import type { CliId } from '../core/options';
import type { CliInfo } from '../protocol';
import { CODEX_MODELS_ARGS, parseCodexModels } from './codex-models';
import type { ExecFn } from './detect';

const LABELS: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex' };
const SUPPORTED: Record<CliId, boolean> = { claude: true, codex: true };

/** Quais CLIs existem nesta máquina (pela saída de `--version`, nunca lendo credenciais). */
export async function detectClis(exec: ExecFn, paths: Record<CliId, string>): Promise<CliInfo[]> {
  const ids = Object.keys(LABELS) as CliId[];
  const results = await Promise.all(ids.map((id) => exec(paths[id], ['--version'])));
  const out: CliInfo[] = [];
  for (const [i, id] of ids.entries()) {
    const r = results[i]!;
    if (r.spawnError) continue;
    const version = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1];
    // O Codex informa o próprio catálogo de modelos (e os esforços de cada um).
    const models = id === 'codex' ? parseCodexModels((await exec(paths[id], CODEX_MODELS_ARGS)).stdout) : [];
    out.push({ id, label: LABELS[id], ...(version ? { version } : {}), supported: SUPPORTED[id], ...(models.length ? { models } : {}) });
  }
  return out;
}
