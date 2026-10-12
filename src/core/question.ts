import type { Question } from './schema';

const MAX_TEXT = 1000;
const MAX_OPTIONS = 8;
const MAX_OPTION_CHARS = 200;
const MARKER = /```visor-question[^\S\n]*\n([\s\S]*?)\n?```/g;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function fromMarker(text: string): Question | null {
  const blocks = [...text.matchAll(MARKER)];
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  let json: unknown;
  try {
    json = JSON.parse(last[1]!);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { question, options } = json as { question?: unknown; options?: unknown };
  if (typeof question !== 'string' || !question.trim()) return null;
  const opts = Array.isArray(options)
    ? options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).map((o) => cut(o.trim(), MAX_OPTION_CHARS)).slice(0, MAX_OPTIONS)
    : [];
  return { text: cut(question.trim(), MAX_TEXT), options: opts, source: 'marker' };
}

function fromHeuristic(text: string): Question | null {
  const prose = text.replace(/```[\s\S]*?```/g, '').trim();
  const lines = prose.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const tail = last.replace(/[\s*_)"'”’»\]]+$/, '');
  if (!tail.endsWith('?') && !tail.endsWith('？')) return null;
  // Uma URL com "?" no fim (query vazia) não é uma pergunta.
  if (/\S+:\/\/\S*[?？]$/.test(tail)) return null;
  return { text: cut(last.replace(/^[*_\s]+|[*_\s]+$/g, ''), MAX_TEXT), options: [], source: 'heuristic' };
}

/** Procura uma pergunta no texto final do agente: bloco estruturado primeiro, depois a heurística do "?" final. */
export function detectQuestion(text: string): Question | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  return fromMarker(text) ?? fromHeuristic(text);
}
