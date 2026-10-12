// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { KeyboardEvent } from 'react';
import { handleSendKey } from '../../webview/keys';

function fake(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; isComposing?: boolean }, value = 'ola mundo', caret = 3) {
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.value = value;
  ta.setSelectionRange(caret, caret);
  const onInput = vi.fn();
  ta.addEventListener('input', onInput);
  const preventDefault = vi.fn();
  const e = { key: init.key, metaKey: !!init.metaKey, ctrlKey: !!init.ctrlKey, shiftKey: !!init.shiftKey, nativeEvent: { isComposing: !!init.isComposing }, currentTarget: ta, preventDefault } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { ta, e, preventDefault, onInput };
}

describe('handleSendKey', () => {
  it('Enter envia e não insere quebra de linha', () => {
    const submit = vi.fn();
    const { e, ta, preventDefault } = fake({ key: 'Enter' });
    handleSendKey(e, submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(ta.value).toBe('ola mundo');
  });

  it.each([['metaKey'], ['ctrlKey'], ['shiftKey']] as const)('%s+Enter insere nova linha no cursor, dispara input e não envia', (mod) => {
    const submit = vi.fn();
    const { e, ta, onInput, preventDefault } = fake({ key: 'Enter', [mod]: true });
    handleSendKey(e, submit);
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(ta.value).toBe('ola\n mundo');
    expect(ta.selectionStart).toBe(4);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('nova linha substitui o trecho selecionado', () => {
    const { e, ta } = fake({ key: 'Enter', metaKey: true });
    ta.setSelectionRange(1, 5);
    handleSendKey(e, vi.fn());
    expect(ta.value).toBe('o\nundo');
  });

  it('Enter durante composição de IME não envia nem intercepta', () => {
    const submit = vi.fn();
    const { e, preventDefault } = fake({ key: 'Enter', isComposing: true });
    handleSendKey(e, submit);
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('Enter com keyCode 229 (confirmação de composição em alguns navegadores) não envia', () => {
    const submit = vi.fn();
    const { e, preventDefault } = fake({ key: 'Enter' });
    (e.nativeEvent as any).keyCode = 229;
    handleSendKey(e, submit);
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('outras teclas são ignoradas', () => {
    const submit = vi.fn();
    const { e, preventDefault } = fake({ key: 'a' });
    handleSendKey(e, submit);
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
