import { describe, it, expect } from 'vitest';
import { parseCodexModels } from '../../src/cli/codex-models';

const lv = (...e: string[]) => e.map((effort) => ({ effort }));

describe('parseCodexModels', () => {
  it('mantém só os listados, com nome e esforços', () => {
    const json = JSON.stringify({
      models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_reasoning_levels: lv('low', 'high', 'bogus') },
        { slug: 'escondido', visibility: 'hide', supported_reasoning_levels: lv('low') },
        { slug: 'sem-nome', visibility: 'list' },
      ],
    });
    expect(parseCodexModels(json)).toEqual([
      { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'high'] },
      { id: 'sem-nome', label: 'sem-nome', efforts: [] },
    ]);
  });
  it('entrada inválida devolve lista vazia', () => {
    expect(parseCodexModels('')).toEqual([]);
    expect(parseCodexModels('{"models":3}')).toEqual([]);
    expect(parseCodexModels('null')).toEqual([]);
  });
});
