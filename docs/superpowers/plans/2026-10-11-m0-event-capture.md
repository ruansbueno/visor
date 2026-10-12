# M0 — Captura e normalização de eventos: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo TypeScript sem UI que (a) spawna o `claude` e normaliza o stream `stream-json` e (b) captura eventos de uma sessão de terminal via hooks injetados por `--settings`, ambos produzindo o mesmo grafo (nodes, vínculo pai→filho, conclusão), validado com eventos reais gravados.

**Architecture:** Dois adapters (`StreamAdapter`, `HookAdapter`) convertem a fonte em `NormalizedEvent`; um `RunStore` aplica esses eventos e mantém o grafo. O modo painel usa `child_process.spawn`; o modo terminal usa um relay Node (script de hook) que envia cada payload a um canal local (socket Unix / named pipe). Os formatos reais do CLI são **gravados primeiro** (Tasks 3 e 7) e os adapters são ajustados contra essas fixtures.

**Tech Stack:** Node ≥ 20, TypeScript, vitest, tsx. Sem dependência de runtime além da stdlib do Node.

**Spec:** `spec-harness-multiagentes-v0.4.md` (seções 3, 5, 7.1, 8, 11, 12 e 14/M0)

## Global Constraints

- Nunca ler `~/.claude/.credentials.json`, Keychain ou qualquer armazenamento de token (spec §3.1).
- Nunca abrir arquivos de transcript em `~/.claude`, mesmo que o payload dos hooks traga o caminho (spec §5).
- Autenticação detectada só pela saída/erro do próprio CLI (spec §7).
- Hooks injetados por `claude --settings <arquivo temporário>`; nunca editar `.claude/settings.json` nem `settings.local.json` do projeto (spec §5). O arquivo temporário é removido ao fim do run.
- Script de hook em Node, não em shell; canal local por socket Unix / named pipe no Windows (spec §12).
- Cancelar encerra a **árvore** de processos (spec §12, RF-09).
- Estados de node: `pending | running | done | error | cancelled` (spec §11).
- Aresta derivada de `parentId`; não existe tipo `Edge` (spec §11).
- Eventos ficam fora do `AgentNode`, com retenção limitada por node (spec §11).
- Nomes de campos, tipos de evento e flags **não são assumidos**: validar contra a versão atual do CLI (spec §8).
- Tolerar linhas malformadas, processo morrendo e CLI ausente (spec §12).
- Licença MIT.

## Review Focus

1. Linha de stream malformada ou truncada no meio do JSON: ignorada e contada, sem derrubar o run.
2. Dois subagentes do mesmo tipo em paralelo: dois nodes distintos, cada um com seu próprio fechamento.
3. Processo termina (crash, kill, CLI ausente) sem evento `result`: run e nodes pendentes viram `error` (ou `cancelled` se o usuário cancelou), nunca ficam `running`.
4. Relay de hook sem canal disponível (pipe inexistente, extensão fechada): sai com código 0, sem stdout, em menos de ~1 s, para nunca quebrar a sessão do `claude` do usuário.
5. Evento de node com `parentId` desconhecido, evento duplicado ou evento para node inexistente: não lança exceção; o store permanece consistente.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, LICENSE
src/core/schema.ts            # tipos: Run, AgentNode, AgentEvent, NormalizedEvent
src/core/store.ts             # RunStore (aplica NormalizedEvent) + formatTree
src/cli/claude-args.ts        # monta argumentos do claude (painel)
src/cli/stream-adapter.ts     # stream-json -> NormalizedEvent
src/cli/process-run.ts        # spawn, leitura por linha, cancelamento da árvore
src/cli/hook-channel.ts       # servidor local (socket/pipe) que recebe mensagens do relay
src/cli/hook-settings.ts      # gera o arquivo --settings com os hooks
src/cli/hook-adapter.ts       # payload de hook -> NormalizedEvent
hooks/relay.mjs               # script executado pelos hooks (Node puro)
scripts/record-stream.ts      # grava stream real em fixtures/stream/
scripts/record-hooks.ts       # grava eventos de hook reais em fixtures/hooks/
scripts/m0-demo.ts            # roda um modo e imprime a árvore
fixtures/project/.claude/agents/echo.md      # projeto de teste com um subagente
fixtures/project/.claude/settings.json       # hook marcador (teste de merge do --settings)
fixtures/fake-claude.mjs      # CLI falso para testar o runner
fixtures/stream/*.ndjson      # gravados no Task 3
fixtures/hooks/*.ndjson       # gravados no Task 7
tests/...                     # um arquivo de teste por módulo
docs/m0-findings.md           # resultado das validações (Task 9)
```

---

### Task 1: Scaffold do projeto

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: comandos `npm test` (vitest run) e `npm run typecheck`.

- [ ] **Step 1: Inicializar o repositório e conferir o ambiente**

```bash
cd .
git init
node --version
claude --version
```
Expected: Node `v20` ou superior; `claude --version` imprime uma versão. **Anote a versão do `claude`** — ela vai para `docs/m0-findings.md`. Se `claude` não existir ou o Node for < 20, pare e avise o usuário.

- [ ] **Step 2: Criar `package.json`**

```json
{
  "name": "visor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Criar `tsconfig.json`, `vitest.config.ts`, `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15000 },
});
```

`.gitignore`:
```
node_modules/
dist/
*.log
```

- [ ] **Step 4: Criar `LICENSE` (MIT)**

Texto MIT padrão, `Copyright (c) 2026 Ruan Bueno`.

- [ ] **Step 5: Teste de fumaça e instalação**

`tests/smoke.test.ts`:
```ts
import { it, expect } from 'vitest';

it('roda o vitest', () => {
  expect(1 + 1).toBe(2);
});
```

Run: `npm install && npm test && npm run typecheck`
Expected: 1 teste passa; typecheck sem erros.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold do projeto (TypeScript, vitest, MIT)"
```

---

### Task 2: Schema e RunStore

**Files:**
- Create: `src/core/schema.ts`, `src/core/store.ts`
- Test: `tests/core/store.test.ts`
- Delete: `tests/smoke.test.ts`

**Interfaces:**
- Produces (usado por todos os tasks seguintes):
  - `type NodeStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'`
  - `type FinalStatus = 'done' | 'error' | 'cancelled'`
  - `interface Run { id; source: 'panel'|'terminal'; sessionId?; cwd; status: NodeStatus; startedAt; endedAt? }`
  - `interface AgentNode { id; runId; parentId: string|null; agentType; invocationId?; status; startedAt?; endedAt?; eventCount }`
  - `interface AgentEvent { id; nodeId; seq; ts; kind: 'message'|'tool_call'|'tool_result'|'error'; payload }`
  - `type NormalizedEvent` (união abaixo)
  - `class RunStore { constructor(init: {runId; source; cwd; maxEventsPerNode?}); readonly run: Run; readonly nodes: Map<string, AgentNode>; get rootId(): string; apply(e: NormalizedEvent): void; eventsOf(nodeId): AgentEvent[]; edges(): {from: string; to: string}[] }`
  - `function formatTree(store: RunStore): string`
  - Convenção de ids: raiz = `${runId}:root`; subagente = `${runId}:${invocationId}`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/core/store.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { RunStore, formatTree } from '../../src/core/store';

function newStore(max?: number) {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p', maxEventsPerNode: max });
  s.apply({ type: 'run_started', runId: 'r1', sessionId: 's1', ts: 1 });
  return s;
}
const child = (id: string, parent: string | null = null) => ({
  type: 'node_started' as const, runId: 'r1', nodeId: `r1:${id}`,
  parentId: parent === null ? 'r1:root' : `r1:${parent}`,
  agentType: 'echo', invocationId: id, ts: 2,
});

describe('RunStore', () => {
  it('run_started cria a raiz em running', () => {
    const s = newStore();
    expect(s.run.status).toBe('running');
    expect(s.run.sessionId).toBe('s1');
    expect(s.nodes.get('r1:root')?.status).toBe('running');
    expect(s.nodes.get('r1:root')?.parentId).toBeNull();
  });

  it('node_started cria filho e aresta derivada de parentId', () => {
    const s = newStore();
    s.apply(child('t1'));
    expect(s.edges()).toEqual([{ from: 'r1:root', to: 'r1:t1' }]);
  });

  it('dois subagentes do mesmo tipo em paralelo viram nodes distintos', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply(child('t2'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    expect(s.nodes.get('r1:t1')?.status).toBe('done');
    expect(s.nodes.get('r1:t2')?.status).toBe('running');
  });

  it('node_started duplicado é ignorado', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply(child('t1'));
    expect(s.nodes.size).toBe(2);
  });

  it('parentId desconhecido anexa à raiz', () => {
    const s = newStore();
    s.apply({ ...child('t1'), parentId: 'r1:nao-existe' });
    expect(s.nodes.get('r1:t1')?.parentId).toBe('r1:root');
  });

  it('evento para node inexistente não lança nem altera o store', () => {
    const s = newStore();
    expect(() =>
      s.apply({ type: 'node_event', runId: 'r1', nodeId: 'r1:x', kind: 'message', payload: 'a', ts: 2 }),
    ).not.toThrow();
    expect(s.nodes.size).toBe(1);
  });

  it('retém no máximo maxEventsPerNode mas conta todos', () => {
    const s = newStore(3);
    for (let i = 0; i < 5; i++) {
      s.apply({ type: 'node_event', runId: 'r1', nodeId: 'r1:root', kind: 'message', payload: i, ts: 2 });
    }
    expect(s.nodes.get('r1:root')?.eventCount).toBe(5);
    expect(s.eventsOf('r1:root').map((e) => e.payload)).toEqual([2, 3, 4]);
    expect(s.eventsOf('r1:root').map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('run_finished error marca nodes ainda em andamento como error', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply({ type: 'run_finished', runId: 'r1', status: 'error', ts: 5 });
    expect(s.run.status).toBe('error');
    expect(s.nodes.get('r1:t1')?.status).toBe('error');
    expect(s.nodes.get('r1:root')?.status).toBe('error');
  });

  it('run_finished cancelled marca nodes em andamento como cancelled', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    s.apply(child('t2'));
    s.apply({ type: 'run_finished', runId: 'r1', status: 'cancelled', ts: 5 });
    expect(s.nodes.get('r1:t1')?.status).toBe('done');
    expect(s.nodes.get('r1:t2')?.status).toBe('cancelled');
  });

  it('formatTree imprime a hierarquia', () => {
    const s = newStore();
    s.apply(child('t1'));
    s.apply({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    expect(formatTree(s)).toBe('root [done]\n  echo (t1) [done]');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `rm tests/smoke.test.ts && npx vitest run tests/core/store.test.ts`
Expected: FAIL (módulo `src/core/store` não existe).

- [ ] **Step 3: Implementar `src/core/schema.ts`**

```ts
export type NodeStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';
export type FinalStatus = 'done' | 'error' | 'cancelled';
export type EventKind = 'message' | 'tool_call' | 'tool_result' | 'error';

export interface Run {
  id: string;
  source: 'panel' | 'terminal';
  sessionId?: string;
  cwd: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
}

export interface AgentNode {
  id: string;
  runId: string;
  parentId: string | null;
  agentType: string;
  invocationId?: string;
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
}

export interface AgentEvent {
  id: string;
  nodeId: string;
  seq: number;
  ts: number;
  kind: EventKind;
  payload: unknown;
}

export type NormalizedEvent =
  | { type: 'run_started'; runId: string; sessionId?: string; ts: number }
  | {
      type: 'node_started'; runId: string; nodeId: string; parentId: string | null;
      agentType: string; invocationId?: string; ts: number;
    }
  | { type: 'node_event'; runId: string; nodeId: string; kind: EventKind; payload: unknown; ts: number }
  | { type: 'node_finished'; runId: string; nodeId: string; status: FinalStatus; ts: number }
  | { type: 'run_finished'; runId: string; status: FinalStatus; ts: number };

export const rootNodeId = (runId: string) => `${runId}:root`;
export const subagentNodeId = (runId: string, invocationId: string) => `${runId}:${invocationId}`;
```

- [ ] **Step 4: Implementar `src/core/store.ts`**

```ts
import {
  type AgentEvent, type AgentNode, type NormalizedEvent, type Run,
  rootNodeId,
} from './schema';

export interface RunStoreInit {
  runId: string;
  source: Run['source'];
  cwd: string;
  maxEventsPerNode?: number;
}

export class RunStore {
  readonly run: Run;
  readonly nodes = new Map<string, AgentNode>();
  private readonly log = new Map<string, AgentEvent[]>();
  private readonly maxEvents: number;

  constructor(init: RunStoreInit) {
    this.run = { id: init.runId, source: init.source, cwd: init.cwd, status: 'pending', startedAt: Date.now() };
    this.maxEvents = init.maxEventsPerNode ?? 500;
  }

  get rootId(): string {
    return rootNodeId(this.run.id);
  }

  apply(e: NormalizedEvent): void {
    switch (e.type) {
      case 'run_started': {
        if (this.nodes.has(this.rootId)) return;
        this.run.status = 'running';
        this.run.startedAt = e.ts;
        if (e.sessionId) this.run.sessionId = e.sessionId;
        this.nodes.set(this.rootId, {
          id: this.rootId, runId: this.run.id, parentId: null, agentType: 'root',
          status: 'running', startedAt: e.ts, eventCount: 0,
        });
        return;
      }
      case 'node_started': {
        if (this.nodes.has(e.nodeId)) return;
        const parentId = e.parentId && this.nodes.has(e.parentId) ? e.parentId : this.rootId;
        this.nodes.set(e.nodeId, {
          id: e.nodeId, runId: this.run.id, parentId, agentType: e.agentType,
          invocationId: e.invocationId, status: 'running', startedAt: e.ts, eventCount: 0,
        });
        return;
      }
      case 'node_event': {
        const node = this.nodes.get(e.nodeId);
        if (!node) return;
        node.eventCount += 1;
        const list = this.log.get(e.nodeId) ?? [];
        list.push({
          id: `${e.nodeId}#${node.eventCount}`, nodeId: e.nodeId, seq: node.eventCount,
          ts: e.ts, kind: e.kind, payload: e.payload,
        });
        if (list.length > this.maxEvents) list.shift();
        this.log.set(e.nodeId, list);
        return;
      }
      case 'node_finished': {
        const node = this.nodes.get(e.nodeId);
        if (!node || !isActive(node)) return;
        node.status = e.status;
        node.endedAt = e.ts;
        return;
      }
      case 'run_finished': {
        this.run.status = e.status;
        this.run.endedAt = e.ts;
        for (const node of this.nodes.values()) {
          if (!isActive(node)) continue;
          // Um run que terminou "done" com filho ainda ativo é inconsistente: conta como erro.
          node.status = e.status === 'cancelled' ? 'cancelled' : e.status === 'done' && node.id === this.rootId ? 'done' : 'error';
          node.endedAt = e.ts;
        }
        return;
      }
    }
  }

  eventsOf(nodeId: string): AgentEvent[] {
    return [...(this.log.get(nodeId) ?? [])];
  }

  edges(): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const n of this.nodes.values()) if (n.parentId) out.push({ from: n.parentId, to: n.id });
    return out;
  }
}

function isActive(n: AgentNode): boolean {
  return n.status === 'running' || n.status === 'pending';
}

export function formatTree(store: RunStore): string {
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    const n = store.nodes.get(id);
    if (!n) return;
    const label = n.id === store.rootId ? 'root' : `${n.agentType} (${n.invocationId ?? n.id})`;
    lines.push(`${'  '.repeat(depth)}${label} [${n.status}]`);
    for (const c of store.nodes.values()) if (c.parentId === id) walk(c.id, depth + 1);
  };
  walk(store.rootId, 0);
  return lines.join('\n');
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/core/store.test.ts && npm run typecheck`
Expected: 10 testes passam; typecheck limpo.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): schema provisório e RunStore"
```

---

### Task 3: Gravar o stream real do `claude` (fixtures)

Este task é de **descoberta**: grava a saída real e registra onde ela difere da hipótese usada no Task 4. Exige o `claude` instalado e logado. Se o CLI não estiver logado, pare e peça ao usuário para rodar `claude` e fazer login; **não** tente logar por ele.

**Files:**
- Create: `src/cli/claude-args.ts`, `scripts/record-stream.ts`, `fixtures/project/.claude/agents/echo.md`
- Test: `tests/cli/claude-args.test.ts`
- Create (gerados): `fixtures/stream/parallel.ndjson`, `fixtures/stream/single.ndjson`

**Interfaces:**
- Produces: `interface ClaudeArgsInput { prompt: string; permissionMode?: string; allowedTools?: string[]; disallowedTools?: string[]; resume?: string; settingsFile?: string }` e `function buildClaudeArgs(i: ClaudeArgsInput): string[]`.

- [ ] **Step 1: Conferir as flags na versão instalada**

Run: `claude --help`
Expected: aparecem `-p/--print`, `--output-format`, `--verbose`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--resume`, `--settings`. **Se alguma flag tiver outro nome ou faltar, ajuste `claude-args.ts` abaixo e anote em `docs/m0-findings.md`.**

- [ ] **Step 2: Escrever o teste que falha**

`tests/cli/claude-args.test.ts`:
```ts
import { it, expect } from 'vitest';
import { buildClaudeArgs } from '../../src/cli/claude-args';

it('monta args mínimos do modo painel', () => {
  expect(buildClaudeArgs({ prompt: 'oi' })).toEqual([
    '-p', 'oi', '--output-format', 'stream-json', '--verbose',
  ]);
});

it('inclui permissões, resume e settings', () => {
  expect(
    buildClaudeArgs({
      prompt: 'oi', permissionMode: 'acceptEdits',
      allowedTools: ['Bash(npm test:*)', 'Read'], disallowedTools: ['WebFetch'],
      resume: 'sess-1', settingsFile: '/tmp/s.json',
    }),
  ).toEqual([
    '-p', 'oi', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(npm test:*),Read',
    '--disallowedTools', 'WebFetch',
    '--resume', 'sess-1',
    '--settings', '/tmp/s.json',
  ]);
});

it('o prompt nunca é interpretado como flag', () => {
  const args = buildClaudeArgs({ prompt: '--dangerously-skip-permissions' });
  expect(args.slice(0, 2)).toEqual(['-p', '--dangerously-skip-permissions']);
  expect(args).not.toContain('--permission-mode');
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/cli/claude-args.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 4: Implementar `src/cli/claude-args.ts`**

```ts
export interface ClaudeArgsInput {
  prompt: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: string;
  settingsFile?: string;
}

export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  // O prompt é sempre o valor logo após -p, então nunca vira flag.
  const args = ['-p', i.prompt, '--output-format', 'stream-json', '--verbose'];
  if (i.permissionMode) args.push('--permission-mode', i.permissionMode);
  if (i.allowedTools?.length) args.push('--allowedTools', i.allowedTools.join(','));
  if (i.disallowedTools?.length) args.push('--disallowedTools', i.disallowedTools.join(','));
  if (i.resume) args.push('--resume', i.resume);
  if (i.settingsFile) args.push('--settings', i.settingsFile);
  return args;
}
```

Run: `npx vitest run tests/cli/claude-args.test.ts`
Expected: 3 testes passam.

- [ ] **Step 5: Criar o projeto de teste e o script de gravação**

`fixtures/project/.claude/agents/echo.md`:
```markdown
---
name: echo
description: Repeats the text it is given. Use for any trivial echo task.
tools: Read
---
You repeat back exactly the text you receive, in one short line.
```

`scripts/record-stream.ts`:
```ts
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildClaudeArgs } from '../src/cli/claude-args';

const [name, prompt] = process.argv.slice(2);
if (!name || !prompt) {
  console.error('uso: tsx scripts/record-stream.ts <nome> "<prompt>"');
  process.exit(1);
}

const outDir = path.resolve('fixtures/stream');
mkdirSync(outDir, { recursive: true });
const out = createWriteStream(path.join(outDir, `${name}.ndjson`));

const child = spawn('claude', buildClaudeArgs({ prompt, permissionMode: 'acceptEdits' }), {
  cwd: path.resolve('fixtures/project'),
  stdio: ['ignore', 'pipe', 'inherit'],
});
child.stdout.pipe(out);
child.on('close', (code) => {
  console.error(`claude saiu com código ${code}; gravado em fixtures/stream/${name}.ndjson`);
});
```

- [ ] **Step 6: Gravar duas execuções reais**

```bash
npx tsx scripts/record-stream.ts parallel "Use the echo subagent twice, in parallel, with the texts 'alpha' and 'beta', then summarize both results in one sentence."
npx tsx scripts/record-stream.ts single "Use the echo subagent once with the text 'gamma' and report what it said."
```
Expected: dois arquivos `.ndjson` não vazios. Se vazios ou com erro de autenticação, ver a nota no topo do task.

- [ ] **Step 7: Inspecionar e registrar a estrutura real**

```bash
head -c 600 fixtures/stream/single.ndjson
npx tsx -e "
const fs=require('fs');
for (const l of fs.readFileSync('fixtures/stream/parallel.ndjson','utf8').split('\n').filter(Boolean)) {
  const j=JSON.parse(l);
  const blocks=(j.message?.content??[]).map(b=>b.type+(b.name?':'+b.name:'')).join(',');
  console.log(j.type, j.subtype??'', 'parent=',j.parent_tool_use_id??null, blocks);
}"
```
Responda e **anote em `docs/m0-findings.md`** (crie com a seção "Stream"):
1. Qual é o `type`/`subtype` do evento inicial e onde está `session_id`?
2. Qual é o `name` do tool_use que invoca o subagente (`Task`, `Agent` ou outro) e o campo do input com o tipo do agente (`subagent_type`?).
3. Mensagens do subagente trazem `parent_tool_use_id` igual ao `id` do tool_use? Em que tipos de evento?
4. O `tool_result` do subagente chega em evento `user` com `tool_use_id`?
5. Como é o evento final (`result`) e o campo de erro (`is_error`)?
6. Há dados de uso/custo no stream? (spec §7; só registrar, não exibir.)

Se alguma resposta diferir da hipótese do Task 4, o Task 4 deve seguir a fixture, não a hipótese.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): args do claude e fixtures reais de stream-json"
```

---

### Task 4: StreamAdapter

**Files:**
- Create: `src/cli/stream-adapter.ts`
- Test: `tests/cli/stream-adapter.test.ts`, `tests/fixtures-replay.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `rootNodeId`, `subagentNodeId` (Task 2); `RunStore`, `formatTree` (Task 2).
- Produces:
  - `class StreamAdapter { constructor(runId: string); push(line: string): NormalizedEvent[]; end(cancelled: boolean): NormalizedEvent[]; malformedLines: number }`
  - `push` ignora linhas vazias e malformadas (incrementa `malformedLines`).
  - `end` emite `run_finished` apenas se o run ainda não terminou (e antes emite `run_started` se ele nunca começou); `cancelled=true` → `cancelled`, senão `error`.

**Nota:** os formatos abaixo são a hipótese da spec. Os nomes de tool que abrem subagente (`Task`/`Agent`), de campos e de tipos devem ser conferidos com as respostas do Task 3 e a constante `SUBAGENT_TOOLS` ajustada se necessário.

- [ ] **Step 1: Escrever os testes que falham**

`tests/cli/stream-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { StreamAdapter } from '../../src/cli/stream-adapter';
import { RunStore, formatTree } from '../../src/core/store';

const L = (o: unknown) => JSON.stringify(o);
const init = L({ type: 'system', subtype: 'init', session_id: 's1' });
const task = (id: string, type = 'echo') =>
  L({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id, name: 'Task', input: { subagent_type: type, description: 'd', prompt: 'p' } },
  ] } });
const childText = (parent: string, text: string) =>
  L({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text }] } });
const taskResult = (id: string, isError = false) =>
  L({ type: 'user', parent_tool_use_id: null, message: { content: [
    { type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError },
  ] } });
const result = (isError = false) => L({ type: 'result', subtype: 'success', is_error: isError, session_id: 's1' });

function run(lines: string[], opts: { end?: boolean; cancelled?: boolean } = {}) {
  const a = new StreamAdapter('r1');
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  for (const l of lines) for (const e of a.push(l)) s.apply(e);
  if (opts.end) for (const e of a.end(opts.cancelled ?? false)) s.apply(e);
  return { a, s };
}

describe('StreamAdapter', () => {
  it('system/init inicia o run com session_id', () => {
    const { s } = run([init]);
    expect(s.run.sessionId).toBe('s1');
    expect(s.nodes.get('r1:root')?.status).toBe('running');
  });

  it('tool_use de subagente cria filho e o resultado o conclui', () => {
    const { s } = run([init, task('t1'), childText('t1', 'alpha'), taskResult('t1'), result()]);
    expect(formatTree(s)).toBe('root [done]\n  echo (t1) [done]');
    expect(s.eventsOf('r1:t1').map((e) => e.kind)).toEqual(['message', 'tool_result']);
  });

  it('subagentes paralelos do mesmo tipo geram dois nodes', () => {
    const { s } = run([init, task('t1'), task('t2'), taskResult('t2'), taskResult('t1'), result()]);
    expect([...s.nodes.keys()].sort()).toEqual(['r1:root', 'r1:t1', 'r1:t2']);
    expect(s.nodes.get('r1:t1')?.status).toBe('done');
    expect(s.nodes.get('r1:t2')?.status).toBe('done');
  });

  it('tool_result com is_error fecha o filho como error', () => {
    const { s } = run([init, task('t1'), taskResult('t1', true), result()]);
    expect(s.nodes.get('r1:t1')?.status).toBe('error');
  });

  it('result com is_error marca o run como error', () => {
    const { s } = run([init, result(true)]);
    expect(s.run.status).toBe('error');
  });

  it('tool_call comum vai para o node dono (raiz ou filho)', () => {
    const bash = (parent: string | null) =>
      L({ type: 'assistant', parent_tool_use_id: parent, message: { content: [
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
      ] } });
    const { s } = run([init, task('t1'), bash(null), bash('t1')]);
    expect(s.eventsOf('r1:root').some((e) => e.kind === 'tool_call' && (e.payload as any).name === 'Bash')).toBe(true);
    expect(s.eventsOf('r1:t1').map((e) => e.kind)).toEqual(['tool_call']);
  });

  it('linhas malformadas, vazias e truncadas são ignoradas e contadas', () => {
    const { a, s } = run([init, '', 'not json', '{"type":"assis', task('t1'), result()]);
    expect(a.malformedLines).toBe(2);
    expect(s.nodes.has('r1:t1')).toBe(true);
  });

  it('JSON válido mas sem forma esperada não lança', () => {
    const { s } = run([init, '123', 'null', L({ type: 'assistant' }), L({ type: 'assistant', message: { content: 'x' } })]);
    expect(s.run.status).toBe('running');
  });

  it('end sem result marca run e filhos pendentes como error', () => {
    const { s } = run([init, task('t1')], { end: true });
    expect(s.run.status).toBe('error');
    expect(s.nodes.get('r1:t1')?.status).toBe('error');
  });

  it('end cancelado marca como cancelled', () => {
    const { s } = run([init, task('t1')], { end: true, cancelled: true });
    expect(s.run.status).toBe('cancelled');
    expect(s.nodes.get('r1:t1')?.status).toBe('cancelled');
  });

  it('end sem nenhuma linha (CLI ausente) ainda produz um run em error', () => {
    const { s } = run([], { end: true });
    expect(s.run.status).toBe('error');
    expect(s.nodes.get('r1:root')?.status).toBe('error');
  });

  it('end depois de result não duplica run_finished', () => {
    const a = new StreamAdapter('r1');
    a.push(init);
    a.push(result());
    expect(a.end(false)).toEqual([]);
  });
});
```

`tests/fixtures-replay.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StreamAdapter } from '../src/cli/stream-adapter';
import { RunStore } from '../src/core/store';

const dir = path.resolve('fixtures/stream');
const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));

describe('replay de fixtures reais de stream', () => {
  it('há fixtures gravadas', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f}: gera ao menos um subagente, todos fechados, run em done`, () => {
      const a = new StreamAdapter('r1');
      const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
      for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        for (const e of a.push(line)) s.apply(e);
      }
      const subs = [...s.nodes.values()].filter((n) => n.parentId !== null);
      expect(subs.length).toBeGreaterThan(0);
      expect(subs.every((n) => n.status === 'done')).toBe(true);
      expect(s.run.status).toBe('done');
      expect(a.malformedLines).toBe(0);
      expect(s.run.sessionId).toBeTruthy();
    });
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/cli/stream-adapter.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/cli/stream-adapter.ts`**

```ts
import { type NormalizedEvent, rootNodeId, subagentNodeId } from '../core/schema';

// Nomes de tool que abrem um subagente. Conferir contra as fixtures (Task 3).
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

type Json = Record<string, any>;

export class StreamAdapter {
  malformedLines = 0;
  private started = false;
  private finished = false;
  private readonly subagents = new Set<string>();
  private readonly root: string;

  constructor(private readonly runId: string) {
    this.root = rootNodeId(runId);
  }

  push(line: string): NormalizedEvent[] {
    if (!line.trim()) return [];
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.malformedLines += 1;
      return [];
    }
    if (!msg || typeof msg !== 'object') return [];
    const m = msg as Json;
    const ts = Date.now();
    const out: NormalizedEvent[] = [];

    if (m.type === 'system' && m.subtype === 'init') {
      out.push(...this.start(m.session_id, ts));
    } else if (m.type === 'assistant' || m.type === 'user') {
      out.push(...this.start(m.session_id, ts));
      out.push(...this.content(m, ts));
    } else if (m.type === 'result') {
      out.push(...this.start(m.session_id, ts));
      if (!this.finished) {
        this.finished = true;
        out.push({ type: 'run_finished', runId: this.runId, status: m.is_error ? 'error' : 'done', ts });
      }
    }
    return out;
  }

  end(cancelled: boolean): NormalizedEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const ts = Date.now();
    return [
      ...this.start(undefined, ts),
      { type: 'run_finished', runId: this.runId, status: cancelled ? 'cancelled' : 'error', ts },
    ];
  }

  private start(sessionId: unknown, ts: number): NormalizedEvent[] {
    if (this.started) return [];
    this.started = true;
    return [{
      type: 'run_started', runId: this.runId,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined, ts,
    }];
  }

  private owner(m: Json): string {
    const p = m.parent_tool_use_id;
    return typeof p === 'string' && this.subagents.has(p) ? subagentNodeId(this.runId, p) : this.root;
  }

  private content(m: Json, ts: number): NormalizedEvent[] {
    const blocks = m.message?.content;
    if (!Array.isArray(blocks)) return [];
    const out: NormalizedEvent[] = [];
    const owner = this.owner(m);

    for (const b of blocks as Json[]) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        out.push({ type: 'node_event', runId: this.runId, nodeId: owner, kind: 'message', payload: b.text, ts });
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        out.push({
          type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_call',
          payload: { id: b.id, name: b.name, input: b.input }, ts,
        });
        if (SUBAGENT_TOOLS.has(b.name)) {
          this.subagents.add(b.id);
          out.push({
            type: 'node_started', runId: this.runId, nodeId: subagentNodeId(this.runId, b.id),
            parentId: owner, agentType: String(b.input?.subagent_type ?? 'general-purpose'),
            invocationId: b.id, ts,
          });
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (this.subagents.has(b.tool_use_id)) {
          const child = subagentNodeId(this.runId, b.tool_use_id);
          out.push({ type: 'node_event', runId: this.runId, nodeId: child, kind: 'tool_result', payload: b.content, ts });
          out.push({ type: 'node_finished', runId: this.runId, nodeId: child, status: b.is_error ? 'error' : 'done', ts });
        } else {
          out.push({
            type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_result',
            payload: { tool_use_id: b.tool_use_id, content: b.content, is_error: !!b.is_error }, ts,
          });
        }
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/cli/stream-adapter.test.ts tests/fixtures-replay.test.ts && npm run typecheck`
Expected: todos passam. **Se `fixtures-replay` falhar**, a hipótese difere da realidade: ajuste o adapter (e `SUBAGENT_TOOLS`) para seguir a fixture, adicione um teste unitário reproduzindo a diferença, e anote em `docs/m0-findings.md`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cli): StreamAdapter com replay de fixtures reais"
```

---

### Task 5: Runner do processo (spawn, leitura, cancelamento)

**Files:**
- Create: `src/cli/process-run.ts`, `fixtures/fake-claude.mjs`
- Test: `tests/cli/process-run.test.ts`

**Interfaces:**
- Consumes: `StreamAdapter` (Task 4); `NormalizedEvent` (Task 2).
- Produces:
  - `interface ProcessRunOptions { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }`
  - `interface ProcessRunResult { exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: string; stderrTail: string; cancelled: boolean }`
  - `interface ProcessRun { cancel(): void; done: Promise<ProcessRunResult> }`
  - `function startProcessRun(runId: string, opts: ProcessRunOptions, onEvent: (e: NormalizedEvent) => void): ProcessRun`

**Escopo:** resolução de `claude.cmd`/`.exe` no Windows fica para o M1 (spec §12); em M0 apenas registrar em `docs/m0-findings.md` como `spawn('claude')` se comporta no Windows, se houver acesso.

- [ ] **Step 1: Criar o CLI falso**

`fixtures/fake-claude.mjs`:
```js
// Uso: node fake-claude.mjs <arquivo.ndjson|-> [--hang] [--grandchild-pid-file <caminho>]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [, , file, ...flags] = process.argv;
if (file && file !== '-') process.stdout.write(readFileSync(file, 'utf8'));

const i = flags.indexOf('--grandchild-pid-file');
if (i >= 0) {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(flags[i + 1], String(gc.pid));
}
if (flags.includes('--hang')) setInterval(() => {}, 1000);
```

- [ ] **Step 2: Escrever os testes que falham**

`tests/cli/process-run.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProcessRun } from '../../src/cli/process-run';
import { RunStore, formatTree } from '../../src/core/store';
import type { NormalizedEvent } from '../../src/core/schema';

const fake = path.resolve('fixtures/fake-claude.mjs');
const L = (o: unknown) => JSON.stringify(o);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'visor-test-'));

function collect() {
  const store = new RunStore({ runId: 'r1', source: 'panel', cwd: process.cwd() });
  return { store, on: (e: NormalizedEvent) => store.apply(e) };
}

const happy = [
  L({ type: 'system', subtype: 'init', session_id: 's1' }),
  L({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'echo' } },
  ] } }),
  L({ type: 'user', parent_tool_use_id: null, message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
  ] } }),
  L({ type: 'result', is_error: false, session_id: 's1' }),
].join('\n') + '\n';

describe('startProcessRun', () => {
  it('lê o stdout por linha e termina em done', async () => {
    const f = path.join(tmp(), 'happy.ndjson');
    writeFileSync(f, happy);
    const { store, on } = collect();
    const r = await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect(r.exitCode).toBe(0);
    expect(formatTree(store)).toBe('root [done]\n  echo (t1) [done]');
  });

  it('linha maior que 64KB em um único write é lida inteira', async () => {
    const big = 'x'.repeat(200_000);
    const f = path.join(tmp(), 'big.ndjson');
    writeFileSync(f, L({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: big }] } }) + '\n' + L({ type: 'result', is_error: false }) + '\n');
    const { store, on } = collect();
    await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect((store.eventsOf('r1:root')[0]?.payload as string).length).toBe(200_000);
  });

  it('processo que sai sem result vira error', async () => {
    const f = path.join(tmp(), 'partial.ndjson');
    writeFileSync(f, happy.split('\n').slice(0, 2).join('\n') + '\n');
    const { store, on } = collect();
    await startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, on).done;
    expect(store.run.status).toBe('error');
    expect(store.nodes.get('r1:t1')?.status).toBe('error');
  });

  it('CLI ausente (ENOENT) produz run em error e spawnError', async () => {
    const { store, on } = collect();
    const r = await startProcessRun('r1', { command: 'visor-cli-que-nao-existe', args: [], cwd: process.cwd() }, on).done;
    expect(r.spawnError).toBeTruthy();
    expect(store.run.status).toBe('error');
  });

  it('cancel encerra o processo e marca o run como cancelled', async () => {
    const f = path.join(tmp(), 'run.ndjson');
    writeFileSync(f, happy.split('\n').slice(0, 2).join('\n') + '\n');
    const { store, on } = collect();
    const run = startProcessRun('r1', { command: process.execPath, args: [fake, f, '--hang'], cwd: process.cwd() }, on);
    await new Promise((r) => setTimeout(r, 500));
    run.cancel();
    const r = await run.done;
    expect(r.cancelled).toBe(true);
    expect(store.run.status).toBe('cancelled');
    expect(store.nodes.get('r1:t1')?.status).toBe('cancelled');
  });

  it.skipIf(process.platform === 'win32')('cancel mata também os processos netos', async () => {
    const pidFile = path.join(tmp(), 'gc.pid');
    const { on } = collect();
    const run = startProcessRun('r1', { command: process.execPath, args: [fake, '-', '--hang', '--grandchild-pid-file', pidFile], cwd: process.cwd() }, on);
    await new Promise((r) => setTimeout(r, 700));
    const gc = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(gc, 0)).not.toThrow();
    run.cancel();
    await run.done;
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(gc, 0)).toThrow();
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/cli/process-run.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 4: Implementar `src/cli/process-run.ts`**

```ts
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { NormalizedEvent } from '../core/schema';
import { StreamAdapter } from './stream-adapter';

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  stderrTail: string;
  cancelled: boolean;
}

export interface ProcessRun {
  cancel(): void;
  done: Promise<ProcessRunResult>;
}

const STDERR_TAIL_BYTES = 4096;

export function startProcessRun(
  runId: string,
  opts: ProcessRunOptions,
  onEvent: (e: NormalizedEvent) => void,
): ProcessRun {
  const adapter = new StreamAdapter(runId);
  const isWin = process.platform === 'win32';
  const emit = (events: NormalizedEvent[]) => events.forEach(onEvent);

  let cancelled = false;
  let spawnError: string | undefined;
  let stderrTail = '';

  // Em Unix o filho vira líder de grupo, para podermos matar a árvore inteira.
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  createInterface({ input: child.stdout }).on('line', (line) => emit(adapter.push(line)));
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  const done = new Promise<ProcessRunResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      emit(adapter.end(cancelled));
      resolve({ exitCode, signal, spawnError, stderrTail, cancelled });
    };
    child.on('error', (err) => {
      spawnError = err.message;
      if (child.pid === undefined) finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });

  return {
    done,
    cancel() {
      if (cancelled || child.pid === undefined) return;
      cancelled = true;
      if (isWin) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* já terminou */
        }
      }
    },
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/cli/process-run.test.ts && npm run typecheck`
Expected: 6 testes passam (o de netos é pulado no Windows).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): runner do processo com cancelamento da árvore"
```

---

### Task 6: Canal local, relay e settings de hooks

**Files:**
- Create: `src/cli/hook-channel.ts`, `src/cli/hook-settings.ts`, `hooks/relay.mjs`
- Test: `tests/cli/hook-channel.test.ts`

**Interfaces:**
- Produces:
  - `interface HookMessage { runId: string; payload: Record<string, unknown> }`
  - `interface HookChannel { path: string; close(): Promise<void> }`
  - `function createHookChannel(onMessage: (m: HookMessage) => void): Promise<HookChannel>`
  - `const HOOK_EVENTS: string[]`
  - `function buildHookSettings(relayPath: string): object`
  - `function writeHookSettings(dir: string, relayPath: string): string` (retorna o caminho do arquivo)
  - Relay: lê o payload JSON do stdin, lê `VISOR_PIPE` e `VISOR_RUN_ID` do ambiente, envia `{runId, payload}\n` ao canal. Em qualquer falha sai com código 0, sem escrever em stdout.

- [ ] **Step 1: Escrever os testes que falham**

`tests/cli/hook-channel.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHookChannel, type HookMessage } from '../../src/cli/hook-channel';
import { buildHookSettings, writeHookSettings, HOOK_EVENTS } from '../../src/cli/hook-settings';

const relay = path.resolve('hooks/relay.mjs');

function runRelay(env: Record<string, string>, input: string) {
  return spawnSync(process.execPath, [relay], {
    input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000,
  });
}

describe('hook channel + relay', () => {
  it('entrega ao canal a mensagem enviada pelo relay', async () => {
    const got: HookMessage[] = [];
    const ch = await createHookChannel((m) => got.push(m));
    const r = runRelay({ VISOR_PIPE: ch.path, VISOR_RUN_ID: 'r9' }, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's' }));
    await new Promise((res) => setTimeout(res, 200));
    await ch.close();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(got).toEqual([{ runId: 'r9', payload: { hook_event_name: 'SessionStart', session_id: 's' } }]);
  });

  it('sem VISOR_PIPE sai 0 e sem stdout', () => {
    const r = runRelay({ VISOR_PIPE: '', VISOR_RUN_ID: 'r9' }, '{"a":1}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('canal inexistente sai 0, sem stdout, rapidamente', () => {
    const t0 = Date.now();
    const r = runRelay({ VISOR_PIPE: path.join(os.tmpdir(), 'visor-nao-existe.sock'), VISOR_RUN_ID: 'r9' }, '{"a":1}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('stdin que não é JSON sai 0 sem enviar nada', async () => {
    const got: HookMessage[] = [];
    const ch = await createHookChannel((m) => got.push(m));
    const r = runRelay({ VISOR_PIPE: ch.path, VISOR_RUN_ID: 'r9' }, 'isso não é json');
    await new Promise((res) => setTimeout(res, 150));
    await ch.close();
    expect(r.status).toBe(0);
    expect(got).toEqual([]);
  });

  it('o canal ignora linhas inválidas sem cair', async () => {
    const got: HookMessage[] = [];
    const ch = await createHookChannel((m) => got.push(m));
    const net = await import('node:net');
    await new Promise<void>((res) => {
      const s = net.connect(ch.path, () => {
        s.write('lixo\n{"runId":1}\n{"runId":"a","payload":{"k":1}}\n', () => { s.end(); res(); });
      });
    });
    await new Promise((res) => setTimeout(res, 150));
    await ch.close();
    expect(got).toEqual([{ runId: 'a', payload: { k: 1 } }]);
  });
});

describe('hook settings', () => {
  it('registra o relay em todos os eventos de HOOK_EVENTS', () => {
    const s = buildHookSettings('/x/relay.mjs') as any;
    for (const ev of HOOK_EVENTS) {
      expect(s.hooks[ev][0].hooks[0]).toEqual({ type: 'command', command: `node "/x/relay.mjs"` });
    }
    expect(HOOK_EVENTS).toEqual(expect.arrayContaining(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse']));
  });

  it('escreve o arquivo no diretório pedido', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'visor-set-'));
    const file = writeHookSettings(dir, '/x/relay.mjs');
    expect(path.dirname(file)).toBe(dir);
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.SessionStart).toBeDefined();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/cli/hook-channel.test.ts`
Expected: FAIL (módulos não existem).

- [ ] **Step 3: Implementar `hooks/relay.mjs`**

```js
// Executado pelos hooks do claude. Regra de ouro: nunca atrapalhar a sessão do usuário.
// Sempre sai com 0 e nunca escreve em stdout (stdout de hook pode ser interpretado pelo CLI).
import net from 'node:net';

const pipe = process.env.VISOR_PIPE;
const runId = process.env.VISOR_RUN_ID;
let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  if (!pipe || !runId) process.exit(0);
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const bail = setTimeout(() => process.exit(0), 1000);
  const sock = net.connect(pipe);
  sock.on('error', () => process.exit(0));
  sock.end(JSON.stringify({ runId, payload }) + '\n', () => {
    clearTimeout(bail);
    process.exit(0);
  });
});
```

- [ ] **Step 4: Implementar `src/cli/hook-channel.ts`**

```ts
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';

export interface HookMessage {
  runId: string;
  payload: Record<string, unknown>;
}

export interface HookChannel {
  path: string;
  close(): Promise<void>;
}

export function createHookChannel(onMessage: (m: HookMessage) => void): Promise<HookChannel> {
  const id = randomBytes(6).toString('hex');
  const isWin = process.platform === 'win32';
  // Caminho de socket Unix tem limite (~104 chars no macOS); tmpdir + nome curto cabe.
  const p = isWin ? `\\\\.\\pipe\\visor-${id}` : path.join(os.tmpdir(), `visor-${id}.sock`);

  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    createInterface({ input: sock }).on('line', (line) => {
      try {
        const m = JSON.parse(line);
        if (m && typeof m.runId === 'string' && m.payload && typeof m.payload === 'object') {
          onMessage({ runId: m.runId, payload: m.payload });
        }
      } catch {
        /* linha inválida: ignorar */
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, () =>
      resolve({
        path: p,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              if (!isWin) rmSync(p, { force: true });
              done();
            });
          }),
      }),
    );
  });
}
```

- [ ] **Step 5: Implementar `src/cli/hook-settings.ts`**

```ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
];

export function buildHookSettings(relayPath: string): object {
  const hook = { type: 'command', command: `node "${relayPath}"` };
  const hooks: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [hook] }];
  return { hooks };
}

export function writeHookSettings(dir: string, relayPath: string): string {
  const file = path.join(dir, 'visor-hooks.settings.json');
  writeFileSync(file, JSON.stringify(buildHookSettings(relayPath), null, 2));
  return file;
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx vitest run tests/cli/hook-channel.test.ts && npm run typecheck`
Expected: 7 testes passam.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(cli): canal local, relay e settings de hooks"
```

---

### Task 7: Gravar hooks reais e validar `--settings` (descoberta)

Task de **descoberta** que responde às perguntas bloqueantes do modo terminal (spec §5). Exige `claude` logado.

**Files:**
- Create: `scripts/record-hooks.ts`, `fixtures/project/.claude/settings.json`
- Create (gerados): `fixtures/hooks/print.ndjson`, `fixtures/hooks/interactive.ndjson`
- Modify: `docs/m0-findings.md`

- [ ] **Step 1: Hook marcador do projeto (teste de merge)**

`fixtures/project/.claude/settings.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"process.env.VISOR_MARK&&require('fs').appendFileSync(process.env.VISOR_MARK,'project-hook\\n')\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Script de gravação**

`scripts/record-hooks.ts`:
```ts
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHookChannel } from '../src/cli/hook-channel';
import { writeHookSettings } from '../src/cli/hook-settings';
import { buildClaudeArgs } from '../src/cli/claude-args';

const [name, prompt] = process.argv.slice(2);
if (!name) {
  console.error('uso: tsx scripts/record-hooks.ts <nome> ["<prompt>"]  (sem prompt = sessão interativa manual)');
  process.exit(1);
}

const outDir = path.resolve('fixtures/hooks');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${name}.ndjson`);
writeFileSync(outFile, '');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'visor-rec-'));
const markFile = path.join(tmp, 'project-hook.mark');
const channel = await createHookChannel((m) => appendFileSync(outFile, JSON.stringify(m.payload) + '\n'));
const settings = writeHookSettings(tmp, path.resolve('hooks/relay.mjs'));
const env = { ...process.env, VISOR_PIPE: channel.path, VISOR_RUN_ID: 'rec', VISOR_MARK: markFile };
const cwd = path.resolve('fixtures/project');

const cleanup = async () => {
  await channel.close();
  const merged = (await import('node:fs')).existsSync(markFile);
  console.error(`\nhook do projeto também disparou (--settings é aditivo): ${merged}`);
  rmSync(tmp, { recursive: true, force: true });
  console.error(`gravado em ${outFile}`);
};

if (prompt) {
  const child = spawn('claude', buildClaudeArgs({ prompt, permissionMode: 'acceptEdits', settingsFile: settings }), {
    cwd, env, stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.on('close', () => void cleanup());
} else {
  console.error('Abra um terminal e rode, na pasta fixtures/project:\n');
  console.error(`  VISOR_PIPE='${channel.path}' VISOR_RUN_ID=rec VISOR_MARK='${markFile}' claude --settings '${settings}'\n`);
  console.error('Peça: "Use the echo subagent twice, in parallel, with the texts alpha and beta."');
  console.error('Depois use /exit e volte aqui; pressione Ctrl+C para finalizar a gravação.');
  process.on('SIGINT', () => void cleanup().then(() => process.exit(0)));
}
```

- [ ] **Step 3: Gravar em modo não interativo (rápido)**

```bash
npx tsx scripts/record-hooks.ts print "Use the echo subagent twice, in parallel, with the texts 'alpha' and 'beta', then summarize."
```
Expected: `fixtures/hooks/print.ndjson` com várias linhas; mensagem final `hook do projeto também disparou (--settings é aditivo): true`. Se `false`, o `--settings` **substitui** a configuração do projeto: registre em `docs/m0-findings.md` como achado bloqueante e proponha ao usuário a alternativa (spec §15: consentimento explícito antes de editar a configuração do projeto).

- [ ] **Step 4: Gravar sessão interativa real (manual)**

```bash
npx tsx scripts/record-hooks.ts interactive
```
Siga as instruções impressas (rodar o `claude` no terminal indicado, pedir o uso do subagente duas vezes em paralelo, fazer um segundo prompt simples, `/exit`, Ctrl+C no script). Expected: `fixtures/hooks/interactive.ndjson` gravado.

- [ ] **Step 5: Inspecionar e registrar**

```bash
npx tsx -e "
const fs=require('fs');
for (const f of ['print','interactive']) {
  console.log('==',f);
  for (const l of fs.readFileSync('fixtures/hooks/'+f+'.ndjson','utf8').split('\n').filter(Boolean)) {
    const j=JSON.parse(l);
    console.log(j.hook_event_name, Object.keys(j).filter(k=>!['hook_event_name'].includes(k)).join(','));
  }
}"
```
Responda e **anote em `docs/m0-findings.md`** (seção "Hooks"):
1. `--settings` mescla com o `settings.json` do projeto? (resultado do Step 3)
2. Quais eventos chegaram, em ambos os modos? `SubagentStart`/`SubagentStop` chegam? Com quais campos (`agent_id`, `agent_type`, `session_id`)?
3. Como saber a qual node pertence um `PreToolUse`/`PostToolUse` (campo `agent_id` presente só quando dentro de subagente?)
4. Os payloads trazem conteúdo de mensagens/resultado do subagente, ou só o caminho do transcript? (**não abrir o transcript**.)
5. Em sessão interativa, `Stop` dispara a cada turno? `SessionEnd` dispara ao sair?
6. Dois subagentes paralelos têm `agent_id` distintos?
7. Os campos de uso/custo aparecem em algum payload?

Se os hooks **não** permitirem montar o grafo (sem vínculo de subagente), registre a conclusão e acione o fallback da spec §15 ("somente execução, sem grafo"), parando o Task 8 em modo reduzido.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): gravação de hooks reais e validação do --settings"
```

---

### Task 8: HookAdapter

**Files:**
- Create: `src/cli/hook-adapter.ts`
- Test: `tests/cli/hook-adapter.test.ts`; modify `tests/fixtures-replay.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `rootNodeId`, `subagentNodeId` (Task 2); `RunStore` (Task 2).
- Produces: `class HookAdapter { constructor(runId: string); push(payload: Record<string, unknown>): NormalizedEvent[] }`

**Nota:** os nomes de campo abaixo (`hook_event_name`, `session_id`, `agent_id`, `agent_type`, `tool_name`, `tool_input`, `prompt`) são a hipótese. **Ajuste ao que o Task 7 registrou** (inclusive o mapeamento de `Stop`, que em sessão interativa pode ocorrer a cada turno e por isso não encerra o run).

- [ ] **Step 1: Escrever os testes que falham**

`tests/cli/hook-adapter.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { HookAdapter } from '../../src/cli/hook-adapter';
import { RunStore, formatTree } from '../../src/core/store';

function run(payloads: Record<string, unknown>[]) {
  const a = new HookAdapter('r1');
  const s = new RunStore({ runId: 'r1', source: 'terminal', cwd: '/p' });
  for (const p of payloads) for (const e of a.push(p)) s.apply(e);
  return s;
}
const start = { hook_event_name: 'SessionStart', session_id: 's1' };
const subStart = (id: string, type = 'echo') => ({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: id, agent_type: type });
const subStop = (id: string) => ({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: id });

describe('HookAdapter', () => {
  it('SessionStart cria a raiz com session_id', () => {
    const s = run([start]);
    expect(s.run.sessionId).toBe('s1');
    expect(s.nodes.get('r1:root')?.status).toBe('running');
  });

  it('SubagentStart/Stop criam e fecham o filho', () => {
    const s = run([start, subStart('a1'), subStop('a1')]);
    expect(formatTree(s)).toBe('root [running]\n  echo (a1) [done]');
  });

  it('dois subagentes paralelos viram dois nodes', () => {
    const s = run([start, subStart('a1'), subStart('a2'), subStop('a2'), subStop('a1')]);
    expect(s.nodes.size).toBe(3);
  });

  it('PreToolUse sem agent_id vai para a raiz; com agent_id vai para o filho', () => {
    const s = run([
      start, subStart('a1'),
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { hook_event_name: 'PreToolUse', agent_id: 'a1', tool_name: 'Read', tool_input: { file_path: 'x' } },
      { hook_event_name: 'PostToolUse', agent_id: 'a1', tool_name: 'Read', tool_response: 'ok' },
    ]);
    expect(s.eventsOf('r1:root').map((e) => e.kind)).toEqual(['tool_call']);
    expect(s.eventsOf('r1:a1').map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
  });

  it('UserPromptSubmit registra o prompt na raiz', () => {
    const s = run([start, { hook_event_name: 'UserPromptSubmit', prompt: 'oi' }]);
    expect(s.eventsOf('r1:root')[0]).toMatchObject({ kind: 'message', payload: { role: 'user', text: 'oi' } });
  });

  it('SessionEnd encerra o run', () => {
    const s = run([start, { hook_event_name: 'SessionEnd' }]);
    expect(s.run.status).toBe('done');
  });

  it('evento sem SessionStart prévio ainda inicia o run (hook perdido)', () => {
    const s = run([subStart('a1')]);
    expect(s.nodes.has('r1:root')).toBe(true);
    expect(s.nodes.has('r1:a1')).toBe(true);
  });

  it('SubagentStop duplicado, evento desconhecido e payload sem forma não lançam', () => {
    const s = run([start, subStart('a1'), subStop('a1'), subStop('a1'), { hook_event_name: 'Coisa' }, {}, { hook_event_name: 42 }]);
    expect(s.nodes.get('r1:a1')?.status).toBe('done');
  });

  it('SubagentStart repetido com o mesmo agent_id não duplica o node', () => {
    const s = run([start, subStart('a1'), subStart('a1')]);
    expect(s.nodes.size).toBe(2);
  });
});
```

Em `tests/fixtures-replay.test.ts`, acrescentar ao final:
```ts
import { HookAdapter } from '../src/cli/hook-adapter';

const hookDir = path.resolve('fixtures/hooks');
const hookFiles = readdirSync(hookDir).filter((f) => f.endsWith('.ndjson'));

describe('replay de fixtures reais de hooks', () => {
  it('há fixtures gravadas', () => {
    expect(hookFiles.length).toBeGreaterThan(0);
  });

  for (const f of hookFiles) {
    it(`${f}: gera ao menos um subagente e todos fecham`, () => {
      const a = new HookAdapter('r1');
      const s = new RunStore({ runId: 'r1', source: 'terminal', cwd: '/p' });
      for (const line of readFileSync(path.join(hookDir, f), 'utf8').split('\n').filter(Boolean)) {
        for (const e of a.push(JSON.parse(line))) s.apply(e);
      }
      const subs = [...s.nodes.values()].filter((n) => n.parentId !== null);
      expect(subs.length).toBeGreaterThan(0);
      expect(subs.every((n) => n.status === 'done')).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/cli/hook-adapter.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/cli/hook-adapter.ts`**

```ts
import { type NormalizedEvent, rootNodeId, subagentNodeId } from '../core/schema';

type Json = Record<string, any>;

export class HookAdapter {
  private started = false;
  private readonly subagents = new Set<string>();
  private readonly root: string;

  constructor(private readonly runId: string) {
    this.root = rootNodeId(runId);
  }

  push(payload: Json): NormalizedEvent[] {
    if (!payload || typeof payload !== 'object') return [];
    const ev = payload.hook_event_name;
    if (typeof ev !== 'string') return [];
    const ts = Date.now();
    const out: NormalizedEvent[] = [];

    if (!this.started) {
      this.started = true;
      out.push({
        type: 'run_started', runId: this.runId,
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined, ts,
      });
    }

    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : undefined;
    const owner = agentId && this.subagents.has(agentId) ? subagentNodeId(this.runId, agentId) : this.root;

    switch (ev) {
      case 'SubagentStart':
        if (agentId && !this.subagents.has(agentId)) {
          this.subagents.add(agentId);
          out.push({
            type: 'node_started', runId: this.runId, nodeId: subagentNodeId(this.runId, agentId),
            parentId: this.root, agentType: String(payload.agent_type ?? 'unknown'),
            invocationId: agentId, ts,
          });
        }
        break;
      case 'SubagentStop':
        if (agentId && this.subagents.has(agentId)) {
          out.push({ type: 'node_finished', runId: this.runId, nodeId: subagentNodeId(this.runId, agentId), status: 'done', ts });
        }
        break;
      case 'PreToolUse':
        out.push({
          type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_call',
          payload: { name: payload.tool_name, input: payload.tool_input }, ts,
        });
        break;
      case 'PostToolUse':
        out.push({
          type: 'node_event', runId: this.runId, nodeId: owner, kind: 'tool_result',
          payload: { name: payload.tool_name, response: payload.tool_response }, ts,
        });
        break;
      case 'UserPromptSubmit':
        out.push({
          type: 'node_event', runId: this.runId, nodeId: this.root, kind: 'message',
          payload: { role: 'user', text: payload.prompt }, ts,
        });
        break;
      case 'SessionEnd':
        out.push({ type: 'run_finished', runId: this.runId, status: 'done', ts });
        break;
      default:
        break; // SessionStart (já tratado acima), Stop e eventos desconhecidos não alteram o grafo
    }
    return out;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test && npm run typecheck`
Expected: toda a suíte passa. **Se o replay das fixtures de hooks falhar**, ajuste o adapter para seguir a fixture real (nomes de campo, vínculo do `PreToolUse` ao subagente), acrescente um teste unitário reproduzindo a diferença e anote em `docs/m0-findings.md`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cli): HookAdapter com replay de fixtures reais"
```

---

### Task 9: Demo ponta a ponta, achados e congelamento do schema

**Files:**
- Create: `scripts/m0-demo.ts`
- Modify: `docs/m0-findings.md`, `spec-harness-multiagentes-v0.4.md` (status e seção 11)

**Interfaces:**
- Consumes: `startProcessRun`, `buildClaudeArgs`, `createHookChannel`, `writeHookSettings`, `HookAdapter`, `RunStore`, `formatTree`.

- [ ] **Step 1: Escrever o demo**

`scripts/m0-demo.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs } from '../src/cli/claude-args';
import { startProcessRun } from '../src/cli/process-run';
import { createHookChannel } from '../src/cli/hook-channel';
import { writeHookSettings } from '../src/cli/hook-settings';
import { HookAdapter } from '../src/cli/hook-adapter';
import { RunStore, formatTree } from '../src/core/store';

const [mode, prompt] = process.argv.slice(2);
if ((mode !== 'panel' && mode !== 'hooks') || !prompt) {
  console.error('uso: tsx scripts/m0-demo.ts <panel|hooks> "<prompt>"');
  process.exit(1);
}
const cwd = path.resolve('fixtures/project');

if (mode === 'panel') {
  const store = new RunStore({ runId: 'demo', source: 'panel', cwd });
  const run = startProcessRun('demo', {
    command: 'claude', args: buildClaudeArgs({ prompt, permissionMode: 'acceptEdits' }), cwd,
  }, (e) => { store.apply(e); console.log(formatTree(store), '\n'); });
  process.on('SIGINT', () => run.cancel());
  const r = await run.done;
  console.log('FINAL\n' + formatTree(store), '\nsessionId:', store.run.sessionId, '\nexit:', r.exitCode, r.spawnError ?? '');
} else {
  // Modo hooks via claude -p (equivalente automatizável); a sessão interativa foi validada no Task 7.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'visor-demo-'));
  const store = new RunStore({ runId: 'demo', source: 'terminal', cwd });
  const adapter = new HookAdapter('demo');
  const channel = await createHookChannel((m) => {
    for (const e of adapter.push(m.payload)) store.apply(e);
    console.log(formatTree(store), '\n');
  });
  const settings = writeHookSettings(tmp, path.resolve('hooks/relay.mjs'));
  const child = spawn('claude', buildClaudeArgs({ prompt, permissionMode: 'acceptEdits', settingsFile: settings }), {
    cwd, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, VISOR_PIPE: channel.path, VISOR_RUN_ID: 'demo' },
  });
  await new Promise((r) => child.on('close', r));
  await new Promise((r) => setTimeout(r, 300));
  await channel.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log('FINAL\n' + formatTree(store));
}
```

- [ ] **Step 2: Executar os dois modos**

```bash
npx tsx scripts/m0-demo.ts panel "Use the echo subagent twice, in parallel, with the texts 'alpha' and 'beta', then summarize."
npx tsx scripts/m0-demo.ts hooks "Use the echo subagent twice, in parallel, with the texts 'alpha' and 'beta', then summarize."
```
Expected (ambos): na saída `FINAL`, `root` com dois filhos `echo` em `done`. Teste também o cancelamento: rode o modo `panel` com um prompt longo e pressione Ctrl+C; `FINAL` deve mostrar nodes em `cancelled` e nenhum processo `claude` remanescente (`pgrep -fl claude` não lista o run).

- [ ] **Step 3: Completar `docs/m0-findings.md`**

Estrutura obrigatória (preencher com **resultados reais**, não hipóteses):
```markdown
# M0 — Achados

- Versão do claude testada: <saída de claude --version>
- Data: <data>
- SO: <macOS/Linux/Windows>

## Stream (modo painel)
<respostas 1-6 do Task 3, Step 7>

## Hooks (modo terminal)
<respostas 1-7 do Task 7, Step 5>

## Critérios de aceite do M0 (spec §14)
- [ ] Painel: criação do filho, vínculo com o pai e conclusão — evidência: <trecho da saída do demo>
- [ ] Terminal: criação do filho, vínculo com o pai e conclusão — evidência: <trecho>
- [ ] `--settings` é aditivo — evidência: <resultado do Task 7 Step 3>
- [ ] Cancelamento mata a árvore — evidência: <resultado do Step 2>
- [ ] Schema validado com eventos reais — ajustes feitos: <lista>

## Diferenças em relação à hipótese da spec
<lista; vazio se nenhuma>

## Windows
<comportamento observado de spawn('claude') / ou "não testado">

## Decisão sobre o modo terminal
<grafo completo | grafo parcial (descrever) | somente execução, sem grafo (spec §15)>
```
Marque cada item do checklist **somente se a evidência foi observada**; item não verificado fica desmarcado com o motivo.

- [ ] **Step 4: Atualizar a spec**

Em `spec-harness-multiagentes-v0.4.md`: (a) trocar o status do cabeçalho para `rascunho v0.4 · M0 concluído`, acrescentando uma linha "Mudanças da v0.3" resumindo os ajustes de schema/eventos descobertos; (b) na seção 11, remover "(provisório, congelar após M0)" e alinhar os tipos ao que está em `src/core/schema.ts`; (c) corrigir na seção 8 qualquer nome de campo/flag que as fixtures contradisseram; (d) refletir a decisão sobre o modo terminal na seção 15 se houve rebaixamento. Renomear o arquivo para `spec-harness-multiagentes-v0.4.md` somente se houve mudança de conteúdo.

- [ ] **Step 5: Verificação final**

Run: `npm test && npm run typecheck`
Expected: toda a suíte verde, typecheck limpo.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: achados do M0 e schema congelado"
```

---

## Self-Review

**Cobertura da spec (M0 e dependências):**
- Spawn + normalização do stream → Tasks 3, 4, 5.
- Hooks via `--settings` no terminal → Tasks 6, 7, 8.
- Grafo com criação do filho, vínculo e conclusão → Tasks 2, 4, 8, 9.
- Schema validado com eventos reais e congelado → Tasks 3, 7, 9.
- Compliance (sem credenciais, sem transcripts, `--settings` sem editar o projeto) → Global Constraints; Task 7 não abre transcript.
- Cancelamento da árvore → Task 5 (teste de netos) e Task 9.
- Itens fora do M0 (Webview, presets, múltiplos runs, Codex, API key, resolução de `claude.cmd` no Windows) → marcos M1–M6.

**Consistência de tipos:** `NormalizedEvent`, `rootNodeId`, `subagentNodeId`, `RunStore.apply/eventsOf/edges`, `formatTree`, `StreamAdapter.push/end/malformedLines`, `HookAdapter.push`, `startProcessRun`, `createHookChannel`, `writeHookSettings`, `buildClaudeArgs` usam os mesmos nomes e assinaturas em todos os tasks.

**Pontos de atenção:** os Tasks 3 e 7 dependem de um `claude` logado e consomem um pouco da assinatura; os formatos dos Tasks 4 e 8 são hipóteses explicitamente sujeitas ao que as fixtures mostrarem.
