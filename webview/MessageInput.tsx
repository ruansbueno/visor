import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MAX_ATTACHMENTS } from '../src/core/options';
import type { AttachedFile, SlashItem } from '../src/protocol';
import { InputContext } from './input-context';
import { handleSendKey } from './keys';
import { SendButton } from './SendButton';

const SLASH = /^\/([\w.:-]*)$/;
const MAX_ITEMS = 60;

export function filterCommands(commands: SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  const hits = commands.filter((c) => c.name.toLowerCase().includes(q));
  const starts = hits.filter((c) => c.name.toLowerCase().startsWith(q));
  return [...starts, ...hits.filter((c) => !starts.includes(c))].slice(0, MAX_ITEMS);
}

function mergeFiles(prev: AttachedFile[], next: AttachedFile[]): AttachedFile[] {
  const out = [...prev];
  for (const f of next) if (out.length < MAX_ATTACHMENTS && !out.some((o) => o.path === f.path)) out.push(f);
  return out;
}

/**
 * Campo de mensagem: Enter envia (Cmd/Ctrl/Shift+Enter quebra a linha), clipe para anexar arquivos
 * e menu "/" com as skills e comandos que o próprio CLI informa.
 */
export function MessageInput(props: {
  placeholder: string;
  submitLabel: string;
  onSubmit(text: string, attachments: string[]): void;
  disabled?: boolean;
  /** só desabilita o botão de enviar (o campo continua editável) */
  submitDisabled?: boolean;
  allowAttach?: boolean;
  allowSlash?: boolean;
  /** altura mínima, em linhas (o campo cresce sozinho até `maxHeight`) */
  rows?: number;
  maxHeight?: number;
  autoFocus?: boolean;
  className?: string;
  /** controles extras no rodapé da caixa (ex.: seletores em forma de pílula), antes do botão de enviar */
  footer?: ReactNode;
}) {
  const {
    placeholder, submitLabel, onSubmit, disabled, submitDisabled, allowAttach = true, allowSlash = true,
    rows = 1, maxHeight = 200, autoFocus, className = '', footer,
  } = props;
  const ctx = useContext(InputContext);
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Arquivos escolhidos no seletor para ESTE campo.
  const { picked, consumePicked } = ctx;
  useEffect(() => {
    if (picked && picked.requestId === id) {
      setFiles((prev) => mergeFiles(prev, picked.files));
      consumePicked();
    }
  }, [picked, id, consumePicked]);

  const query = allowSlash ? SLASH.exec(text)?.[1] : undefined;
  const slashActive = query !== undefined;
  const { requestCommands } = ctx;
  useEffect(() => {
    if (slashActive) requestCommands();
  }, [slashActive, requestCommands]);

  const items = useMemo(() => (query === undefined ? [] : filterCommands(ctx.commands, query)), [query, ctx.commands]);
  const open = items.length > 0 && !dismissed;
  const active = Math.min(index, Math.max(0, items.length - 1));

  // O campo cresce com o texto até maxHeight e depois rola; a pessoa não redimensiona à mão.
  // Medimos de novo quando o texto, o placeholder, o estado ou a LARGURA mudam (o texto quebra em outras linhas).
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    let full = el.scrollHeight;
    if (el.value === '' && el.placeholder) {
      // O navegador não conta o placeholder no scrollHeight: medimos com ele como valor, sem disparar eventos.
      el.value = el.placeholder;
      try {
        full = Math.max(full, el.scrollHeight);
      } finally {
        el.value = '';
      }
    }
    if (!full) {
      el.style.height = ''; // ainda sem layout
      return;
    }
    el.style.height = `${Math.min(full, maxHeight)}px`;
    el.style.overflowY = full > maxHeight ? 'auto' : 'hidden';
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = -1;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w !== lastWidth) {
        lastWidth = w;
        measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxHeight]);

  // O botão só faz sentido com o campo vazio ou já começando por uma barra (comando).
  const slashUsable = text === '' || SLASH.test(text);
  const hasContent = text.trim().length > 0 || files.length > 0;
  const canSubmit = !disabled && !submitDisabled && hasContent;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(text, files.map((f) => f.path));
    setText('');
    setFiles([]);
  };

  const choose = (item: SlashItem) => {
    setText(`/${item.name} `);
    setDismissed(false);
    setIndex(0);
    ref.current?.focus();
  };

  return (
    <div className={`msg-input ${className}`.trim()}>
      {open && (
        <div className="slash-menu nodrag nowheel" role="listbox" aria-label="Lista de skills e comandos">
          {items.map((it, i) => (
            <div
              key={it.name}
              role="option"
              aria-selected={i === active}
              className={`slash-item${i === active ? ' active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // não tira o foco do campo
                choose(it);
              }}
              onMouseEnter={() => setIndex(i)}
            >
              <span className="slash-name">/{it.name}</span>
              <span className="slash-group">{it.group}</span>
            </div>
          ))}
        </div>
      )}
      <div className="composer-box">
        {files.length > 0 && (
          <div className="attach-chips nodrag">
            {files.map((f) => (
              <span key={f.path} className="chip" title={f.path}>
                <span>{f.name}</span>
                <button className="chip-x" aria-label={`Remover anexo ${f.name}`} onClick={() => setFiles((prev) => prev.filter((x) => x.path !== f.path))}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={rows}
          data-autogrow="true"
          autoFocus={autoFocus}
          aria-label="Mensagem"
          placeholder={disabled ? 'Aguarde o agente terminar para enviar…' : placeholder}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (open && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
                return;
              }
              if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') {
                e.preventDefault();
                choose(items[active]!);
                return;
              }
              if (e.key === 'Escape') {
                e.stopPropagation(); // fecha só o menu, não o diálogo em volta
                setDismissed(true);
                return;
              }
            }
            handleSendKey(e, submit);
          }}
        />
        <div className="composer-footer">
          <div className="footer-left">
            {allowAttach && (
              <button className="icon-btn attach-btn" aria-label="Anexar arquivos" title="Anexar arquivos" disabled={disabled || files.length >= MAX_ATTACHMENTS} onClick={() => ctx.requestFiles(id)}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6z" />
                </svg>
              </button>
            )}
            {allowSlash && (
              <button
                className="icon-btn slash-btn"
                aria-label="Skills e comandos"
                title={slashUsable ? 'Skills e comandos' : 'Skills e comandos só no começo de uma mensagem (digite / antes do texto)'}
                disabled={disabled || !slashUsable}
                onClick={() => {
                  if (!text) setText('/');
                  setDismissed(false); // reabre o menu se tinha sido dispensado com Esc
                  setIndex(0);
                  ref.current?.focus();
                }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                  <rect x="3.5" y="3.5" width="17" height="17" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M14.5 7 9.5 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
          <div className="footer-mid">{footer}</div>
          <SendButton label={submitLabel} disabled={!canSubmit} onClick={submit} />
        </div>
      </div>
    </div>
  );
}
