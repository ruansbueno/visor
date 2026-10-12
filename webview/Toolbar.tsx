import type { CliCheck } from '../src/cli/detect';
import type { CliId } from '../src/core/options';
import type { CliInfo } from '../src/protocol';
import { MessageInput } from './MessageInput';
import { OptionPills } from './OptionPills';
import type { PillValues } from './option-lists';

export function Toolbar(props: {
  /** diagnósticos por CLI (os que estão ok viram o rótulo discreto) */
  auth: Partial<Record<CliId, CliCheck>> | null;
  starting: number;
  usage?: { fiveHour?: number; sevenDay?: number; fiveHourResetsAt?: number } | null;
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
  const { auth, starting, usage, inert, onStart, onCancelPending, onNewChat, onNewAgent, quick, onQuick, clis, defaultModel } = props;
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
        {usage?.fiveHour !== undefined && (
          <span className="auth-chip" title={`Uso da sessão de 5h${usage.fiveHourResetsAt ? ` (renova às ${new Date(usage.fiveHourResetsAt * 1000).toLocaleTimeString()})` : ''}${usage.sevenDay !== undefined ? `; semana: ${Math.round(usage.sevenDay * 100)}%` : ''}. Informado pelo Claude Code.`}>
            Sessão 5h: {Math.round(usage.fiveHour * 100)}%
          </span>
        )}
        {(['claude', 'codex'] as const).map((id) => {
          const c = auth?.[id];
          return c?.state === 'ok' ? (
            <span key={id} className="auth-chip" title={`Autenticação via CLI ${id === 'codex' ? 'do Codex' : 'do Claude Code'} ${c.version}. A extensão não acessa suas credenciais.`}>
              {id === 'codex' ? `Codex: ${c.authMethod}` : `Auth: ${c.authMethod}`}
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
}
