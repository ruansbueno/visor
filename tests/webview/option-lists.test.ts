import { describe, it, expect } from 'vitest';
import { modelChoices, effortChoices, permissionChoices, buildOptions, summarizeOptions, MODEL_CUSTOM } from '../../webview/option-lists';

const values = (c: { value: string }[]) => c.map((x) => x.value);

describe('listas por CLI', () => {
  it('Claude: aliases de modelo + outro; esforço até max; modos de permissão', () => {
    expect(values(modelChoices('claude'))).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku', MODEL_CUSTOM]);
    expect(values(effortChoices('claude'))).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(values(permissionChoices('claude'))).toEqual(['', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  });
  it('Codex: sem alias inventado (só padrão + outro); esforço low..ultra; sandbox com rótulos em português', () => {
    expect(values(modelChoices('codex'))).toEqual(['', MODEL_CUSTOM]);
    expect(values(effortChoices('codex'))).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    const p = permissionChoices('codex');
    expect(values(p)).toEqual(['', 'read-only', 'workspace-write', 'danger-full-access']);
    expect(p.find((x) => x.value === 'read-only')!.label).toMatch(/leitura/i);
    expect(p.find((x) => x.value === 'danger-full-access')!.label).toMatch(/confirma/i);
  });
  it('o "Padrão" mostra o modelo real quando conhecido', () => {
    expect(modelChoices('claude', 'claude-sonnet-5-5')[0]!.label).toContain('claude-sonnet-5-5');
    expect(modelChoices('claude')[0]!.label).toBe('Padrão');
  });
});

describe('buildOptions (escolhas das pílulas -> ChatOptions enviadas ao host)', () => {
  it('tudo no padrão devolve undefined', () => {
    expect(buildOptions({ cli: 'claude', model: '', effort: '', perm: '' })).toBeUndefined();
  });
  it('Claude: permissão vira permissionMode; cli claude não é enviado', () => {
    expect(buildOptions({ cli: 'claude', model: 'opus', effort: 'high', perm: 'plan' })).toEqual({ model: 'opus', effort: 'high', permissionMode: 'plan' });
  });
  it('Codex: o cli vai junto e a permissão vira sandbox', () => {
    expect(buildOptions({ cli: 'codex', model: '', effort: 'low', perm: 'read-only' })).toEqual({ cli: 'codex', effort: 'low', sandbox: 'read-only' });
    expect(buildOptions({ cli: 'codex', model: '', effort: '', perm: '' })).toEqual({ cli: 'codex' });
  });
  it('valores que não existem na CLI escolhida são descartados (troca de CLI sem limpar)', () => {
    expect(buildOptions({ cli: 'codex', model: '', effort: 'low', perm: 'plan' })).toEqual({ cli: 'codex', effort: 'low' });
    expect(buildOptions({ cli: 'claude', model: '', effort: '', perm: 'read-only' })).toBeUndefined();
  });
});

describe('summarizeOptions (valores atuais do chat para as pílulas)', () => {
  it('Claude e Codex devolvem model/effort/perm', () => {
    expect(summarizeOptions({ model: 'opus', effort: 'high', permissionMode: 'plan' })).toEqual({ cli: 'claude', model: 'opus', effort: 'high', perm: 'plan' });
    expect(summarizeOptions({ cli: 'codex', sandbox: 'read-only' })).toEqual({ cli: 'codex', model: '', effort: '', perm: 'read-only' });
    expect(summarizeOptions(undefined)).toEqual({ cli: 'claude', model: '', effort: '', perm: '' });
  });
});

describe('catálogo de modelos do Codex', () => {
  const models = [
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] as const },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: ['low', 'ultra'] as const },
  ].map((m) => ({ ...m, efforts: [...m.efforts] }));
  it('lista os modelos do CLI entre o padrão e "Outro…"', () => {
    expect(values(modelChoices('codex', undefined, models))).toEqual(['', 'gpt-5.5', 'gpt-6-sol', MODEL_CUSTOM]);
    expect(modelChoices('codex', undefined, models)[1]!.label).toBe('GPT-5.5');
  });
  it('o esforço segue o modelo escolhido; sem modelo conhecido, a lista da CLI', () => {
    expect(values(effortChoices('codex', 'gpt-6-sol', models))).toEqual(['', 'low', 'ultra']);
    expect(values(effortChoices('codex', 'outro', models))).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });
});
