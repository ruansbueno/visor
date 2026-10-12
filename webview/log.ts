import type { EventView } from '../src/protocol';

export type LogItem =
  | { kind: 'text'; key: string; role: 'user' | 'assistant'; text: string; attachments?: string[] }
  | { kind: 'tool'; key: string; id?: string; name: string; summary: string; input: unknown; status: 'running' | 'done' | 'error'; result?: string }
  | { kind: 'result'; key: string; text: string }
  | { kind: 'error'; key: string; text: string };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

const SUMMARY_MAX = 80;
const SUMMARY_KEYS = ['command', 'pattern', 'file_path', 'url', 'query', 'path', 'description', 'subagent_type', 'prompt'];
// Para a tool de subagente o mais informativo é a descrição, antes do caminho/pattern.
const KEY_ORDER: Record<string, string[]> = { Agent: ['description', 'subagent_type', 'prompt'], Task: ['description', 'subagent_type', 'prompt'] };

const clip = (s: string) => (s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + '…' : s);

export function summarizeInput(name: string, input: unknown): string {
  if (input === undefined || input === null) return '';
  if (isObj(input)) {
    for (const k of KEY_ORDER[name] ?? SUMMARY_KEYS) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return clip(v.trim().split('\n')[0]!);
    }
  }
  try {
    return clip(JSON.stringify(input) ?? '');
  } catch {
    return '';
  }
}

export function resultText(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.length > 0 && content.every((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string')) {
    return content.map((b) => (b as { text: string }).text).join('\n');
  }
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}

export function toLogItems(events: EventView[]): LogItem[] {
  const items: LogItem[] = [];
  const toolById = new Map<string, Extract<LogItem, { kind: 'tool' }>>();

  for (const e of events) {
    const p = e.payload;
    switch (e.kind) {
      case 'message': {
        if (typeof p === 'string') items.push({ kind: 'text', key: e.id, role: 'assistant', text: p });
        else if (isObj(p) && typeof p.text === 'string') {
          const attachments = Array.isArray(p.attachments) ? p.attachments.filter((a): a is string => typeof a === 'string') : [];
          items.push({ kind: 'text', key: e.id, role: p.role === 'user' ? 'user' : 'assistant', text: p.text, ...(attachments.length ? { attachments } : {}) });
        }
        break;
      }
      case 'tool_call': {
        if (!isObj(p) || typeof p.name !== 'string') break;
        const id = typeof p.id === 'string' ? p.id : undefined;
        const item: Extract<LogItem, { kind: 'tool' }> = {
          kind: 'tool', key: e.id, id, name: p.name, summary: summarizeInput(p.name, p.input), input: p.input,
          status: id ? 'running' : 'done', // sem id (hooks) não há como parear o resultado
        };
        items.push(item);
        if (id) toolById.set(id, item);
        break;
      }
      case 'tool_result': {
        if (isObj(p) && typeof p.tool_use_id === 'string') {
          const text = resultText(p.content);
          const tool = toolById.get(p.tool_use_id);
          if (tool) {
            tool.result = text;
            tool.status = p.is_error ? 'error' : 'done';
          } else {
            items.push({ kind: 'result', key: e.id, text });
          }
        } else {
          items.push({ kind: 'result', key: e.id, text: resultText(isObj(p) && 'response' in p ? p.response : p) });
        }
        break;
      }
      case 'error':
        items.push({ kind: 'error', key: e.id, text: resultText(p) });
        break;
    }
  }
  return items;
}
