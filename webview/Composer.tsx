import type { ReactNode } from 'react';
import { MessageInput } from './MessageInput';

/** Campo de mensagem dos cartões e do inspetor: Enter envia, Cmd/Ctrl+Enter quebra a linha. */
/** `maxHeight`: até onde o campo cresce (no cartão é pouco, para não engolir a conversa). */
export function Composer(props: {
  placeholder: string;
  disabled: boolean;
  onSend(text: string, attachments: string[]): void;
  maxHeight?: number;
  /** pílulas de opções no rodapé da caixa (cartão do chat) */
  footer?: ReactNode;
  /** o menu "/" é do Claude Code: no Codex fica desligado */
  allowSlash?: boolean;
}) {
  const { placeholder, disabled, onSend, maxHeight = 72, footer, allowSlash = true } = props;
  return (
    <MessageInput
      className="composer nodrag nowheel"
      placeholder={placeholder}
      submitLabel="Enviar"
      disabled={disabled}
      maxHeight={maxHeight}
      allowSlash={allowSlash}
      footer={footer}
      onSubmit={onSend}
    />
  );
}
