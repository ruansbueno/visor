import type { CliCheck } from '../src/cli/detect';
import type { CliId } from '../src/core/options';
import type { CliInfo } from '../src/protocol';
import { AccountMenu, type SetupAction } from './AccountMenu';
import { MessageInput } from './MessageInput';
import { OptionPills } from './OptionPills';
import type { PillValues } from './option-lists';
import type { Usage } from './state';

export function Toolbar(props: {
  /** diagnósticos por CLI (instalação/login) */
  checks: Partial<Record<CliId, CliCheck>>;
  starting: number;
  usage?: Usage | null;
  onSetup(action: SetupAction): void;
  inert?: boolean;
  onStart(prompt: string, attachments: string[]): void;
  onCancelPending(): void;
  onNewChat(): void;
  onNewAgent(): void;
  /** CLI/modelo/esforço/permissões do PRÓXIMO chat ('' = padrão) */
  quick: PillValues;
  onQuick(next: PillValues): void;
  clis: CliInfo[];
  defaultModel?: string;
}) {
  const { checks, starting, usage, onSetup, inert, onStart, onCancelPending, onNewChat, onNewAgent, quick, onQuick, clis, defaultModel } = props;
  return (
    <div className="toolbar" {...(inert ? { inert: '' } : {})}>
      <MessageInput
        className="toolbar-row"
        placeholder="Descreva a tarefa para um novo chat… (Enter envia, Cmd/Ctrl+Enter quebra a linha, / para skills)"
        submitLabel="Executar"
        allowSlash={quick.cli === 'claude'}
        onSubmit={onStart}
      />
      <div className="toolbar-meta">
        <button className="secondary small" onClick={onNewChat}>+ Novo chat</button>
        <button className="secondary small" onClick={onNewAgent}>+ Novo agente</button>
        <OptionPills values={quick} onChange={onQuick} models={clis.find((c) => c.id === quick.cli)?.models} defaultModel={defaultModel} clis={clis.length >= 2 ? clis : undefined} />
        {starting > 0 && (
          <span className="starting" role="status">
            <span className="spinner" aria-hidden="true" /> Iniciando conversa…{' '}
            <button className="secondary small" onClick={onCancelPending}>Cancelar início</button>
          </span>
        )}
        <AccountMenu checks={checks} usage={usage ?? null} onSetup={onSetup} />
      </div>
    </div>
  );
}
