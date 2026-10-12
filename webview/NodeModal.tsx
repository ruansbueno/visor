import { useEffect, useRef } from 'react';
import type { NodeStatus } from '../src/core/schema';
import type { EventView } from '../src/protocol';
import { Composer } from './Composer';
import { STATUS_GLYPH, STATUS_LABEL } from './format';
import { LogList } from './LogView';

/** Inspetor de um node de AGENTE (os chats têm cartão próprio no canvas). */
export function NodeModal(props: {
  title: string;
  subtitle?: string;
  status: NodeStatus;
  canSend: boolean;
  events: EventView[] | null;
  total: number;
  onSend(text: string, attachments: string[]): void;
  onClose(): void;
}) {
  const { title, subtitle, status, canSend, events, total, onSend, onClose } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  // Acompanha o fim do log enquanto a pessoa não rolou para cima.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          {subtitle && <span className="modal-sub">em {subtitle}</span>}
          <span className={`status-${status}`}>
            <span className="status-badge"><span aria-hidden="true">{STATUS_GLYPH[status]}</span> {STATUS_LABEL[status]}</span>
          </span>
          <button ref={closeRef} className="link" onClick={onClose} aria-label="Fechar detalhes">×</button>
        </div>
        <div
          className="modal-body"
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          <LogList events={events} total={total} />
        </div>
        <Composer placeholder="Enviar ao subagente (a mensagem passa pelo orquestrador)…" disabled={!canSend} maxHeight={160} onSend={onSend} />
      </div>
    </div>
  );
}
