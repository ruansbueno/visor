import { useEffect, useState } from 'react';
import { MODEL_ID_PATTERN, MODEL_ALIASES, type CliId } from '../src/core/options';
import type { CliInfo, ModelInfo } from '../src/protocol';
import { OptionSelect } from './OptionSelect';
import { MODEL_CUSTOM, effortChoices, modelChoices, permissionChoices, type PillValues } from './option-lists';

export type CustomStatus = 'off' | 'empty' | 'invalid' | 'ok';


/**
 * Pílulas de CLI / modelo / esforço / permissões (como no campo do Claude Code).
 * As listas mudam com a CLI; trocar de CLI zera o resto. O "Outro…" do modelo abre um campo de id livre
 * (só um id válido é enviado).
 */
export function OptionPills(props: {
  values: PillValues;
  onChange(next: PillValues): void;
  defaultModel?: string;
  /** o "Padrão" do modelo mostra o modelo real (nos diálogos) em vez de só uma dica */
  showDefaultModel?: boolean;
  /** CLIs instaladas: o seletor de CLI aparece (a CLI é fixa nos cartões, então não passam clis) */
  clis?: CliInfo[];
  /** modelos que a CLI atual informa (Codex); sem isso, os aliases fixos */
  models?: ModelInfo[];
  onCustomStatus?(status: CustomStatus): void;
}) {
  const { values, onChange, defaultModel, showDefaultModel, clis, models, onCustomStatus } = props;
  const known = (m: string) => (MODEL_ALIASES as readonly string[]).includes(m) || !!models?.some((x) => x.id === m);
  const customId = values.model !== '' && !known(values.model) ? values.model : '';
  const [customOpen, setCustomOpen] = useState(customId !== '' || values.model === MODEL_CUSTOM);
  const [customText, setCustomText] = useState(customId);

  // Trocar de CLI fecha o campo de id (as listas de modelo são outras).
  useEffect(() => {
    setCustomOpen(false);
    setCustomText('');
  }, [values.cli]);

  const text = customText.trim();
  const valid = MODEL_ID_PATTERN.test(text);
  const status: CustomStatus = !customOpen ? 'off' : text === '' ? 'empty' : valid ? 'ok' : 'invalid';
  useEffect(() => {
    onCustomStatus?.(status);
  }, [status, onCustomStatus]);

  const selectValue = customOpen ? MODEL_CUSTOM : values.model;
  const choices = modelChoices(values.cli, showDefaultModel ? defaultModel : undefined, models);
  const set = (patch: Partial<PillValues>) => onChange({ ...values, ...patch });

  return (
    <>
      {clis && clis.length > 0 && (
        <OptionSelect label="CLI" value={values.cli} onChange={(v) => onChange({ cli: v as CliId, model: '', effort: '', perm: '' })}>
          {clis.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.supported}>
              {c.label}{c.version ? ` ${c.version}` : ''}{c.supported ? '' : ' — em breve'}
            </option>
          ))}
        </OptionSelect>
      )}
      <OptionSelect
        label="Modelo"
        value={selectValue}
        title={!showDefaultModel && defaultModel ? `Padrão do CLI: ${defaultModel}` : 'Modelo'}
        onChange={(v) => {
          if (v === MODEL_CUSTOM) {
            setCustomOpen(true);
            set({ model: valid ? text : '' });
          } else {
            setCustomOpen(false);
            set({ model: v });
          }
        }}
      >
        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </OptionSelect>
      {customOpen && (
        <input
          className="pill pill-input"
          type="text"
          aria-label="Id do modelo"
          aria-invalid={status === 'invalid'}
          value={customText}
          maxLength={100}
          placeholder="id do modelo"
          onChange={(e) => {
            const v = e.target.value;
            setCustomText(v);
            set({ model: MODEL_ID_PATTERN.test(v.trim()) ? v.trim() : '' });
          }}
        />
      )}
      <OptionSelect label="Esforço" value={values.effort} onChange={(v) => set({ effort: v })}>
        {effortChoices(values.cli, values.model, models).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </OptionSelect>
      <OptionSelect label="Permissões" value={values.perm} onChange={(v) => set({ perm: v })}>
        {permissionChoices(values.cli).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </OptionSelect>
    </>
  );
}
