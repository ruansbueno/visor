import { describe, it, expect } from 'vitest';
import { detectClis } from '../../src/cli/clis';
import type { ExecFn } from '../../src/cli/detect';

const exec = (table: Record<string, string | 'missing'>): ExecFn => async (command) => {
  const v = table[command];
  if (v === undefined || v === 'missing') return { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' };
  return { code: 0, stdout: v, stderr: '' };
};

describe('detectClis', () => {
  it('lista só as CLIs instaladas, com versão; claude e codex são suportados', async () => {
    const out = await detectClis(exec({ claude: '2.1.287 (Claude Code)\n', codex: 'codex-cli 0.157.1\n' }), { claude: 'claude', codex: 'codex' });
    expect(out).toEqual([
      { id: 'claude', label: 'Claude Code', version: '2.1.287', supported: true },
      { id: 'codex', label: 'Codex', version: '0.157.1', supported: true },
    ]);
  });
  it('CLI ausente não aparece; nenhuma instalada devolve lista vazia', async () => {
    expect((await detectClis(exec({ claude: '2.0.0 (Claude Code)', codex: 'missing' }), { claude: 'claude', codex: 'codex' })).map((c) => c.id)).toEqual(['claude']);
    expect(await detectClis(exec({}), { claude: 'claude', codex: 'codex' })).toEqual([]);
  });
  it('usa os caminhos configurados', async () => {
    const out = await detectClis(exec({ '/opt/claude': '2.1.0 (Claude Code)' }), { claude: '/opt/claude', codex: '/nao/existe' });
    expect(out.map((c) => c.id)).toEqual(['claude']);
  });
  it('o Codex traz o catálogo de modelos que o próprio CLI informa', async () => {
    const catalog = JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] });
    const ex: ExecFn = async (command, args) =>
      args[0] === 'debug' ? { code: 0, stdout: catalog, stderr: '' } : { code: 0, stdout: command === 'codex' ? 'codex-cli 0.157.1' : '2.1.0 (Claude Code)', stderr: '' };
    const out = await detectClis(ex, { claude: 'claude', codex: 'codex' });
    expect(out.find((c) => c.id === 'codex')!.models).toEqual([{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low'] }]);
    expect(out.find((c) => c.id === 'claude')!.models).toBeUndefined();
  });
});
