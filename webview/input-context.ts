import { createContext } from 'react';
import type { AttachedFile, SlashItem } from '../src/protocol';

/** O que os campos de mensagem precisam do App: seletor de arquivos e lista de skills/comandos do CLI. */
export interface InputCtx {
  requestFiles(requestId: string): void;
  picked: { requestId: string; files: AttachedFile[] } | null;
  consumePicked(): void;
  commands: SlashItem[];
  requestCommands(): void;
}

const noop = () => {};
export const InputContext = createContext<InputCtx>({ requestFiles: noop, picked: null, consumePicked: noop, commands: [], requestCommands: noop });
