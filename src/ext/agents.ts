import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentInfo } from '../protocol';

export const BUILTIN_AGENTS: AgentInfo[] = [
  { name: 'general-purpose', description: 'Agente genérico para pesquisa e tarefas de várias etapas.' },
  { name: 'Explore', description: 'Explora o código e responde perguntas sobre ele (somente leitura).' },
  { name: 'Plan', description: 'Planeja a implementação de uma tarefa.' },
];

const NAME = /^[\w.:-]{1,100}$/;
const MAX_DESCRIPTION = 300;
const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, '$2');

export function parseAgentFile(text: string): AgentInfo | null {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fields[kv[1]!] = unquote(kv[2]!.trim());
  }
  const name = fields.name ?? '';
  if (!NAME.test(name)) return null;
  const d = fields.description ?? '';
  return { name, description: d.length > MAX_DESCRIPTION ? d.slice(0, MAX_DESCRIPTION) + '…' : d };
}

/** Lê só `.claude/agents/*.md` do projeto aberto (nunca `~/.claude`). */
export async function listProjectAgents(cwd: string): Promise<AgentInfo[]> {
  const dir = path.join(cwd, '.claude', 'agents');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const out: AgentInfo[] = [];
  for (const f of files) {
    try {
      const a = parseAgentFile(await readFile(path.join(dir, f), 'utf8'));
      if (a) out.push(a);
    } catch {
      /* arquivo ilegível: ignorar */
    }
  }
  return out;
}

const byName = (a: AgentInfo, b: AgentInfo) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Agentes do projeto primeiro (ordem alfabética), depois os nativos que o projeto não substituiu. */
export function mergeAgents(project: AgentInfo[]): AgentInfo[] {
  const names = new Set(project.map((a) => a.name));
  return [...[...project].sort(byName), ...BUILTIN_AGENTS.filter((a) => !names.has(a.name))];
}
