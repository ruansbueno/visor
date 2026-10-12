import { useCallback, useEffect, useState } from 'react';
import type { ChatOptions } from '../src/core/options';
import type { CliInfo } from '../src/protocol';
import { MessageInput } from './MessageInput';
import { OptionPills, type CustomStatus } from './OptionPills';
import { buildOptions, type PillValues } from './option-lists';

export function NewChatDialog(props: {
  clis: CliInfo[];
  defaultModel?: string;
  /** CLI/modelo/esforço/permissões já escolhidos na barra de baixo */
  initial: PillValues;
  onCreate(prompt: string, options: ChatOptions | undefined, attachments: string[]): void;
  onClose(): void;
}) {
  const { clis, defaultModel, initial, onCreate, onClose } = props;
  const [values, setValues] = useState<PillValues>(initial);
  const [custom, setCustom] = useState<CustomStatus>('off');
  const onCustomStatus = useCallback((s: CustomStatus) => setCustom(s), []);

  // Quem abriu o diálogo: capturado ANTES de o autoFocus mexer no foco, para devolver o foco a ele ao fechar.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose, opener]);

  const cliList: CliInfo[] = clis.length ? clis : [{ id: 'claude', label: 'Claude Code', supported: true }];
  // Se a escolhida não é suportada (ou sumiu da lista), cai na primeira suportada.
  const firstSupported = cliList.find((c) => c.supported)?.id;
  const chosenCli = cliList.find((c) => c.id === values.cli && c.supported)?.id ?? firstSupported;
  const noCli = chosenCli === undefined;
  const effective: PillValues = { ...values, cli: chosenCli ?? 'claude' };

  const problem = noCli
    ? 'Nenhuma CLI suportada encontrada: instale o Claude Code ou o Codex.'
    : custom === 'invalid'
      ? 'Id de modelo inválido: use letras, números e . : - [ ].'
      : custom === 'empty'
        ? 'Informe o id do modelo.'
        : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal new-chat" role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2 id="new-chat-title">Novo chat</h2></div>
        <div className="modal-body">
          {problem && <div className="log-note warn-note">{problem}</div>}
          <MessageInput
            placeholder="Descreva a tarefa… (Enter cria o chat, Cmd/Ctrl+Enter quebra a linha, / para skills)"
            submitLabel="Criar chat"
            rows={3}
            maxHeight={320}
            autoFocus
            allowSlash={effective.cli === 'claude'}
            submitDisabled={!!problem}
            onSubmit={(prompt, attachments) => onCreate(prompt, buildOptions(effective), attachments)}
            footer={<OptionPills values={effective} models={cliList.find((c) => c.id === effective.cli)?.models} onChange={setValues} defaultModel={defaultModel} showDefaultModel clis={cliList} onCustomStatus={onCustomStatus} />}
          />
          <div className="log-note">O chat ganha o nome do começo da tarefa (dá para renomear depois) e roda em paralelo às outras conversas.</div>
          <div className="dialog-actions">
            <button className="secondary" onClick={onClose}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
