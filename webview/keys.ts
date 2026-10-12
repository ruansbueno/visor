import type { KeyboardEvent } from 'react';

/** Insere "\n" no cursor (ou no lugar da seleção) e avisa o React com um evento `input`. */
function insertNewline(el: HTMLTextAreaElement): void {
  el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Teclas de envio dos campos de conversa: Enter envia; Cmd/Ctrl/Shift+Enter insere uma nova linha.
 * Durante composição de IME (acentos, CJK) o Enter pertence ao IME e nada é feito.
 */
export function handleSendKey(e: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  // keyCode 229: o Enter que confirma uma composição de IME chega assim em alguns navegadores.
  if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
  e.preventDefault();
  if (e.metaKey || e.ctrlKey || e.shiftKey) insertNewline(e.currentTarget);
  else submit();
}
