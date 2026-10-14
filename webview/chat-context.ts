import { createContext } from 'react';
import type { ChatOptions, ModelInfo } from '../src/protocol';
/** Ações que os cartões de chat (nodes do React Flow) disparam no App. A conversa ao vivo vai em `data.log`. */
export interface ChatCtx {
  onRename(runId: string, title: string): void;
  onCancel(runId: string): void;
  onMarkDone(runId: string): void;
  onRemove(runId: string): void;
  onAddAgent(runId: string): void;
  onSend(nodeId: string, text: string, attachments: string[]): void;
  onPermission(runId: string, requestId: string, decision: 'allow' | 'allow_always' | 'deny'): void;
  onOptions(runId: string, options: ChatOptions | undefined): void;
  onKeepWaiting(runId: string): void;
  /** quantas respostas deste node falharam (muda = mostrar "Tentar de novo") */
  answerFailures(nodeId: string): number;
  /** modelos que a CLI informa (vazio = aliases fixos) */
  models(cli: string): ModelInfo[] | undefined;
}

const noop = () => {};
export const ChatContext = createContext<ChatCtx>({
  onRename: noop, onCancel: noop, onMarkDone: noop, onRemove: noop, onAddAgent: noop, onSend: noop, onPermission: noop, onOptions: noop,
  onKeepWaiting: noop, answerFailures: () => 0, models: () => undefined,
});
