import { memo } from 'react';
import type { EventView } from '../src/protocol';
import { toLogItems, type LogItem } from './log';
import { Markdown } from './markdown';

function pretty(value: unknown): string {
  try {
    return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
  } catch {
    return '';
  }
}

function ItemView({ item, userLabel }: { item: LogItem; userLabel: string }) {
  switch (item.kind) {
    case 'text':
      return (
        <div className={`log-item log-${item.role}`}>
          <div className="log-role">{item.role === 'user' ? userLabel : 'Agente'}</div>
          {item.role === 'assistant' ? <div className="log-text md"><Markdown text={item.text} /></div> : item.text && <div className="log-text">{item.text}</div>}
          {item.attachments && (
            <div className="attach-chips">
              {item.attachments.map((a, i) => <span key={`${a}-${i}`} className="chip">{a}</span>)}
            </div>
          )}
        </div>
      );
    case 'tool':
      return (
        <div className={`log-item log-tool tool-${item.status}`}>
          <div className="tool-head">
            <span className="tool-glyph" aria-hidden="true">{item.status === 'done' ? '✓' : item.status === 'error' ? '✕' : '●'}</span>
            <strong>{item.name}</strong>
            {item.summary && <span className="tool-summary">{item.summary}</span>}
            <span className="tool-state">{item.status === 'running' ? 'executando' : item.status === 'error' ? 'erro' : 'concluído'}</span>
          </div>
          {item.result !== undefined && item.result !== '' && <details><summary>Resultado</summary><pre>{item.result}</pre></details>}
          {item.input !== undefined && <details><summary>Entrada</summary><pre>{pretty(item.input)}</pre></details>}
        </div>
      );
    case 'result':
      return (
        <div className="log-item log-result">
          <div className="log-role">Resultado final</div>
          <div className="log-text md"><Markdown text={item.text} /></div>
        </div>
      );
    case 'error':
      return (
        <div className="log-item log-error">
          <div className="log-role">Erro</div>
          <div className="log-text">{item.text}</div>
        </div>
      );
  }
}

/** Cada flush traz objetos novos; só re-renderiza (e refaz o markdown) o item cujo conteúdo mudou. */
const sameItem = (a: { item: LogItem; userLabel: string }, b: { item: LogItem; userLabel: string }): boolean => {
  if (a.userLabel !== b.userLabel || a.item.kind !== b.item.kind || a.item.key !== b.item.key) return false;
  const x = a.item as Record<string, unknown>;
  const y = b.item as Record<string, unknown>;
  return ['text', 'role', 'name', 'summary', 'status', 'result'].every((k) => x[k] === y[k]) &&
    (x.attachments as string[] | undefined)?.join('\0') === (y.attachments as string[] | undefined)?.join('\0');
};
const Item = memo(ItemView, sameItem);

/** A conversa de um node: texto, tool calls (resultado recolhido) e resultados. */
export const LogList = memo(function LogList({ events, total, userLabel = 'Prompt' }: { events: EventView[] | null; total: number; userLabel?: string }) {
  const items = events ? toLogItems(events) : [];
  return (
    <>
      {events && total > events.length && <div className="log-note">Mostrando os últimos {events.length} de {total} eventos.</div>}
      {items.length === 0 ? <div className="log-empty">Nenhum evento ainda.</div> : items.map((it) => <Item key={it.key} item={it} userLabel={userLabel} />)}
    </>
  );
});
