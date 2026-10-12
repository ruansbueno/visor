import { useEffect, useState } from 'react';
import type { AgentInfo, RunView } from '../src/protocol';
import { MessageInput } from './MessageInput';
import { OptionSelect } from './OptionSelect';
import { isBusy } from './state';

export function NewNodeDialog(props: {
  agents: AgentInfo[];
  runs: RunView[];
  /** conversa pré-selecionada (ex.: o botão "+ agente" do cartão) */
  initialRunId?: string;
  onCreate(agentType: string, task: string, runId: string | null): void;
  onClose(): void;
}) {
  // Só chats do Claude Code: o Codex não tem subagentes.
  const runs = props.runs.filter((r) => r.options?.cli !== 'codex');
  const { agents, initialRunId, onCreate, onClose } = props;
  const [type, setType] = useState('');
  const [runId, setRunId] = useState(initialRunId ?? '');
  const chosen = agents.find((a) => a.name === type) ?? agents[0];
  // Padrão: a conversa mais recente que não esteja ocupada (senão, a mais recente).
  const freeRuns = runs.filter((r) => !isBusy(r));
  const targetRun = runs.find((r) => r.id === runId) ?? freeRuns[freeRuns.length - 1] ?? runs[runs.length - 1];
  const targetBusy = isBusy(targetRun);

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal new-node" role="dialog" aria-modal="true" aria-labelledby="new-node-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2 id="new-node-title">Novo agente</h2></div>
        <div className="modal-body">
          {chosen?.description && <div className="log-note">{chosen.description}</div>}
          {agents.length === 0 && <div className="log-note">Carregando agentes…</div>}
          <MessageInput
            placeholder="Descreva a tarefa específica para este agente… (Enter cria, Cmd/Ctrl+Enter quebra a linha)"
            submitLabel="Criar node"
            rows={3}
            maxHeight={320}
            allowAttach={false}
            allowSlash={false}
            autoFocus
            submitDisabled={!chosen || targetBusy}
            onSubmit={(text) => chosen && onCreate(chosen.name, text, targetRun?.id ?? null)}
            footer={
              <>
                {runs.length > 1 && (
                  <OptionSelect label="Conversa" value={targetRun?.id ?? ''} onChange={setRunId}>
                    {runs.map((r) => <option key={r.id} value={r.id}>{(r.title || 'Chat') + (isBusy(r) ? ' (ocupado)' : '')}</option>)}
                  </OptionSelect>
                )}
                <OptionSelect label="Agente" value={chosen?.name ?? ''} onChange={setType} disabled={agents.length === 0}>
                  {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                </OptionSelect>
              </>
            }
          />
          {targetBusy && <div className="log-note warn-note">Esta conversa está executando agora: escolha outra, ou espere ela terminar para criar o node.</div>}
          <div className="log-note">
            {runs.length === 0
              ? 'Ainda não há conversas: será criada uma nova conversa para esta tarefa.'
              : 'O orquestrador dessa conversa receberá o pedido e delegará a tarefa a este agente; o node aparece ligado a ele (depende de o modelo obedecer).'}
          </div>
          <div className="dialog-actions">
            <button className="secondary" onClick={onClose}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
