import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { memo, useContext, useEffect, useRef, useState } from 'react';
import { ChatContext } from './chat-context';
import { Composer } from './Composer';
import { OptionPills } from './OptionPills';
import { buildOptions, summarizeOptions } from './option-lists';
import { STATUS_GLYPH, STATUS_LABEL } from './format';
import type { ChatNodeData } from './graph';
import { LogList } from './LogView';
import { PermissionCard } from './PermissionCard';
import { QuestionCard } from './QuestionCard';

/** O chat no canvas: cabeçalho, conversa ao vivo e campo de envio, sem precisar abrir nada. */
export const ChatCard = memo(function ChatCard({ data, selected }: NodeProps) {
  const d = data as unknown as ChatNodeData;
  const ctx = useContext(ChatContext);
  const log = d.log;
  const running = d.status === 'running' || d.status === 'pending';
  const idle = !running && !d.busy && !d.lingering;
  const waiting = d.status === 'waiting' && !!d.question;
  const pills = summarizeOptions(d.options);
  const isCodex = pills.cli === 'codex';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const skipCommit = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const startEdit = () => {
    skipCommit.current = false;
    setDraft(d.title);
    setEditing(true);
  };
  const commit = () => {
    if (skipCommit.current) return;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== d.title) ctx.onRename(d.runId, next);
  };

  // Acompanha o fim da conversa enquanto a pessoa não rolou para cima.
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log, d.status, waiting]);

  return (
    <div className={`chat-card status-${d.status}${selected ? ' is-selected' : ''}`}>
      <NodeResizer minWidth={420} minHeight={240} maxWidth={2000} maxHeight={2000} isVisible handleClassName="chat-resize-handle" lineClassName="chat-resize-line" />
      <div className="chat-head chat-drag">
        {running || d.status === 'waiting' ? (
          <span className={`spinner status-${d.status}`} aria-hidden="true" />
        ) : (
          <span className={`chat-glyph status-${d.status}`} aria-hidden="true">{STATUS_GLYPH[d.status]}</span>
        )}
        {editing ? (
          <input
            className="chat-title-input nodrag"
            value={draft}
            maxLength={200}
            autoFocus
            aria-label="Nome do chat"
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                skipCommit.current = true;
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="chat-title" title="Duplo clique para renomear" onDoubleClick={startEdit}>{d.title}</span>
        )}
        <span className="chat-cli" title="CLI deste chat (a sessão pertence a ela)">{isCodex ? 'Codex' : 'Claude Code'}</span>
        <span className={`chat-state status-${d.status}`}>{STATUS_LABEL[d.status]}</span>
        <div className="chat-actions nodrag">
          {!isCodex && (
            <button className="secondary small" aria-label="Chamar agente neste chat" title="Chamar agente neste chat" onClick={() => ctx.onAddAgent(d.runId)}>+ agente</button>
          )}
          {(running || d.busy || d.lingering) && <button className="secondary small" aria-label="Cancelar conversa" title="Cancelar esta conversa" onClick={() => ctx.onCancel(d.runId)}>✕</button>}
          {d.status === 'waiting' && !d.busy && <button className="secondary small" onClick={() => ctx.onMarkDone(d.runId)}>Marcar como concluído</button>}
          {idle && <button className="secondary small" aria-label="Remover conversa" title="Remover esta conversa do canvas" onClick={() => ctx.onRemove(d.runId)}>Remover</button>}
        </div>
      </div>
      <div
        className="chat-log nodrag nowheel"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <LogList events={log?.events ?? null} total={log?.total ?? 0} userLabel="Você" />
        {waiting && d.question && <QuestionCard question={d.question} canSend={!d.busy} failures={ctx.answerFailures(d.rootId)} onAnswer={(text) => ctx.onSend(d.rootId, text, [])} />}
        {d.stalled && (
          <div className="question-card stall-card" role="alert">
            <div className="question-title">O agente terminou de responder, mas uma tarefa em segundo plano não terminou.</div>
            <div className="question-options">
              <button className="option" onClick={() => ctx.onCancel(d.runId)}>Encerrar processo</button>
              <button className="option" onClick={() => ctx.onKeepWaiting(d.runId)}>Continuar esperando</button>
            </div>
          </div>
        )}
        {d.permission && (
          <PermissionCard prompt={d.permission} more={(d.permissionCount ?? 1) - 1} onAnswer={(choice) => ctx.onPermission(d.runId, d.permission!.requestId, choice)} />
        )}
        {(running || d.busy) && (
          <div className="chat-running"><span className="spinner" aria-hidden="true" /> Executando…</div>
        )}
      </div>
      <Composer
        placeholder={waiting ? 'Escreva sua resposta…' : 'Enviar uma mensagem a esta conversa…'}
        disabled={running || d.busy}
        allowSlash={!isCodex}
        onSend={(text, attachments) => ctx.onSend(d.rootId, text, attachments)}
        footer={<OptionPills values={pills} models={ctx.models(pills.cli)} onChange={(v) => ctx.onOptions(d.runId, buildOptions(v))} />}
      />
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});
