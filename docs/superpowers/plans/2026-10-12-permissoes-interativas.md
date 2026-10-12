# Permissões interativas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aprovar/negar o uso de ferramentas do Claude Code dentro do Visor (card com Permitir / Permitir sempre / Negar).

**Architecture:** Cada turno continua sendo um processo `claude -p` novo (`--resume`). Passa a usar `--input-format stream-json --permission-prompt-tool=stdio`: a mensagem do turno vai pelo stdin, o CLI emite `control_request` (`can_use_tool`) no stdout e o host responde com `control_response` no stdin. O adapter vira o pedido num evento do store; o webview mostra o card; a decisão volta ao processo.

**Tech Stack:** TypeScript, Node `child_process`, React 18 (webview), vitest (+ jsdom).

**Spec:** `docs/superpowers/specs/2026-10-12-permissoes-interativas-design.md`

## Global Constraints

- Só o Claude muda; o Codex mantém `stdio: ['ignore', …]` e prompt posicional (`buildCodexArgs` intocado).
- Cada turno do Claude é um processo novo com `--resume`; nada de processo persistente.
- Textos de interface e comentários em português (padrão do repositório), nomes de código como já usados.
- O status de node/run **não** muda durante um pedido de permissão.
- O texto do pedido mostrado na tela tem no máximo 2.000 caracteres e não contém caracteres de controle.
- A Webview só recebe `requestId`, `tool`, `summary` e `hasAlways`; as sugestões completas ficam só no host.
- Validar toda mensagem da Webview em `parseWebviewMessage` (ids com tamanho máximo, decisão numa lista fechada).
- Verificação final: `npx tsc --noEmit` e `npx vitest run` sem falhas.

## Review Focus

- Pedido de permissão chega **depois** de o processo ter terminado ou ter sido cancelado: a resposta é ignorada, sem exceção e com aviso discreto (Task 5).
- Dois pedidos seguidos (ferramentas em paralelo): o segundo não sobrescreve o primeiro; o card mostra um por vez e a decisão vai para o `requestId` certo (Task 4 e 6).
- `control_request` malformado (sem `request_id`, sem `tool_name`) ou de subtype desconhecido: não derruba o adapter nem aparece como card (Task 3).
- `input` gigante ou com caracteres de controle (`‮`, `\0`): o resumo é limitado e limpo (Task 2).
- "Permitir sempre" quando o CLI não mandou sugestão: o botão não aparece e, se a mensagem chegar mesmo assim, age como "Permitir" (Task 2 e 5).
- Prompt com aspas, quebras de linha e Unicode vai íntegro pelo stdin (Task 1).
- Escrever no stdin de um processo que já morreu (`EPIPE`) não gera exceção não tratada (Task 4).

---

### Task 0: Spike — formato da resposta `allow` e fechamento do stdin

Sem código de produto. O resultado define duas funções pequenas das Tasks 1 e 2; se algo divergir do assumido, ajuste só elas.

**Files:**
- Create (descartável, fora do repositório): `/tmp/entrytest/spike2.py`
- Modify: `docs/superpowers/specs/2026-10-12-permissoes-interativas-design.md` (seção "Pontos a confirmar" → registrar resultados)

- [ ] **Step 1: Escrever o spike de `allow` e "permitir sempre"**

```bash
cd /tmp/entrytest && cat > spike2.py <<'EOF'
import subprocess, json, os, sys, time
mode = sys.argv[1]  # allow | allow_always | bg
env = dict(os.environ, CLAUDE_CODE_ENTRYPOINT='claude-vscode')
for k in ('CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION'): env.pop(k, None)
if os.path.exists('/tmp/entrytest/spike.txt'): os.remove('/tmp/entrytest/spike.txt')
p = subprocess.Popen(['claude','-p','--output-format','stream-json','--input-format','stream-json','--verbose',
                      '--permission-mode','default','--max-turns','4','--permission-prompt-tool=stdio'],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
prompt = {'bg': 'Run `sleep 8 && echo bg-done > /tmp/entrytest/bg.txt` as a background shell command (run_in_background), then reply "started".'}.get(mode,
          'Run the shell command: touch /tmp/entrytest/spike.txt . Then say done.')
p.stdin.write(json.dumps({"type":"user","message":{"role":"user","content":prompt}})+"\n"); p.stdin.flush()
t0 = time.time()
for line in p.stdout:
    m = json.loads(line); t = m.get('type')
    if t == 'control_request':
        req = m['request']; print('CONTROL_REQUEST keys:', sorted(req.keys()), '| id:', m['request_id'])
        resp = {"behavior": "allow", "updatedInput": req['input']}
        if mode == 'allow_always':
            resp["updatedPermissions"] = [s for s in req.get('permission_suggestions', []) if s.get('type') == 'addRules'][:1]
        print('RESPONDING', json.dumps(resp)[:300])
        p.stdin.write(json.dumps({"type":"control_response","response":{"subtype":"success","request_id":m['request_id'],"response":resp}})+"\n"); p.stdin.flush()
    elif t == 'result':
        print('RESULT is_error=', m.get('is_error'), 'at', round(time.time()-t0,1), 's')
        if mode == 'bg': p.stdin.close()   # fecha o stdin logo no result, como o plano pretende
        else: break
    if time.time() - t0 > 80: break
try: p.stdin.close()
except Exception: pass
p.wait(timeout=30)
print('exit', p.returncode, '| spike.txt', os.path.exists('/tmp/entrytest/spike.txt'), '| bg.txt', os.path.exists('/tmp/entrytest/bg.txt'))
EOF
python3 spike2.py allow
```

Expected: `CONTROL_REQUEST keys: [...]`, `RESPONDING {"behavior": "allow", "updatedInput": …}`, `RESULT is_error= False`, `spike.txt True`. Se der `is_error True` ou `spike.txt False`, anote a mensagem de erro do CLI e ajuste o formato (por exemplo, sem `updatedInput`, ou `updatedInput` obrigatório).

- [ ] **Step 2: Testar "permitir sempre" e o fechamento do stdin com tarefa em segundo plano**

```bash
cd /tmp/entrytest && python3 spike2.py allow_always && cat /tmp/entrytest/.claude/settings.local.json 2>/dev/null | head -20; python3 spike2.py bg; ls /tmp/entrytest/bg.txt 2>&1
```

Expected: `allow_always` termina com `spike.txt True` (e talvez cria `.claude/settings.local.json` com a regra — anote se criou). No `bg`, `bg.txt` existir depois do `exit` significa que fechar o stdin no `result` **não** atrapalha tarefas em segundo plano. Se `bg.txt` não existir, a decisão passa a ser: manter o stdin aberto até o processo terminar sozinho (Task 4, ver "Se o spike disser que não pode fechar").

- [ ] **Step 3: Registrar os resultados na spec**

Acrescente no fim da seção "Pontos a confirmar" da spec um bloco `Resultados do spike (2026-10-12)` com: formato aceito de `allow`; formato de `updatedPermissions`; se `.claude/settings.local.json` foi criado; se `bg.txt` apareceu. Limpe: `rm -rf /tmp/entrytest/.claude /tmp/entrytest/spike.txt /tmp/entrytest/bg.txt`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-12-permissoes-interativas-design.md docs/superpowers/plans/2026-10-12-permissoes-interativas.md
git commit -m "docs: spec e plano das permissões interativas"
```

---

### Task 1: Entrada por stdin (`claude-input.ts`) e novos argumentos do Claude

**Files:**
- Create: `src/cli/claude-input.ts`
- Modify: `src/cli/claude-args.ts`
- Test: `tests/cli/claude-input.test.ts` (novo), `tests/cli/claude-args.test.ts`

**Interfaces:**
- Produces:
  - `type PermissionDecision = { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string }`
  - `userMessageLine(text: string): string` — uma linha JSON terminada em `\n`
  - `permissionResponseLine(requestId: string, decision: PermissionDecision): string`
  - `ClaudeArgsInput` **perde** o campo `prompt`; `buildClaudeArgs` sempre inclui `--input-format stream-json` e `--permission-prompt-tool=stdio` e não termina mais em `-- <prompt>`.

- [ ] **Step 1: Escrever os testes que falham**

`tests/cli/claude-input.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { permissionResponseLine, userMessageLine } from '../../src/cli/claude-input';

describe('userMessageLine', () => {
  it('é uma linha JSON de mensagem de usuário terminada em \\n', () => {
    const line = userMessageLine('oi');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({ type: 'user', message: { role: 'user', content: 'oi' } });
  });

  it('preserva aspas, quebras de linha e Unicode', () => {
    const text = 'linha 1\n"aspas" \\ barra\n日本語 🎉';
    expect(JSON.parse(userMessageLine(text)).message.content).toBe(text);
    expect(userMessageLine(text).slice(0, -1).includes('\n')).toBe(false);
  });
});

describe('permissionResponseLine', () => {
  it('allow leva updatedInput e, se houver, updatedPermissions', () => {
    const line = permissionResponseLine('req-1', { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ type: 'addRules' }] });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ type: 'addRules' }] } },
    });
  });

  it('deny leva a mensagem', () => {
    expect(JSON.parse(permissionResponseLine('req-2', { behavior: 'deny', message: 'não' })).response.response).toEqual({ behavior: 'deny', message: 'não' });
  });
});
```

Em `tests/cli/claude-args.test.ts`, substitua o arquivo inteiro por:

```ts
import { it, expect } from 'vitest';
import { buildClaudeArgs } from '../../src/cli/claude-args';

const BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool=stdio'];

it('monta args mínimos do modo painel (a mensagem vai pelo stdin, não pelos argumentos)', () => {
  expect(buildClaudeArgs({})).toEqual(BASE);
});

it('inclui permissões, resume e settings', () => {
  expect(
    buildClaudeArgs({
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash(npm test:*)', 'Read'], disallowedTools: ['WebFetch'],
      resume: 'sess-1', settingsFile: '/tmp/s.json',
    }),
  ).toEqual([
    ...BASE,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Bash(npm test:*)', 'Read',
    '--disallowedTools', 'WebFetch',
    '--resume', 'sess-1',
    '--settings', '/tmp/s.json',
  ]);
});

it('nunca coloca prompt nos argumentos', () => {
  expect(buildClaudeArgs({ appendSystemPrompt: 'regra' })).not.toContain('--');
});
```

Acrescente ao mesmo arquivo os casos que já existiam, sem o prompt:

```ts
it('appendSystemPrompt entra nos argumentos', () => {
  expect(buildClaudeArgs({ appendSystemPrompt: 'instrução' })).toEqual([...BASE, '--append-system-prompt', 'instrução']);
});

it('model e effort entram nos argumentos', () => {
  expect(buildClaudeArgs({ model: 'opus', effort: 'high' })).toEqual([...BASE, '--model', 'opus', '--effort', 'high']);
});

it('sem model/effort nada é acrescentado e --add-dir nunca é usado', () => {
  const args = buildClaudeArgs({});
  expect(args).not.toContain('--add-dir');
  expect(args).not.toContain('--model');
  expect(args).not.toContain('--effort');
  expect(args).not.toContain('--permission-mode');
});

it('cada regra de tool vai como argumento próprio (vírgula/espaço dentro de uma regra não a quebra)', () => {
  expect(buildClaudeArgs({ allowedTools: ['Read(//a/b,c d.txt)', 'Bash(ls)'], disallowedTools: ['Edit(//x/y z)'] })).toEqual([
    ...BASE, '--allowedTools', 'Read(//a/b,c d.txt)', 'Bash(ls)', '--disallowedTools', 'Edit(//x/y z)',
  ]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/cli/claude-input.test.ts tests/cli/claude-args.test.ts`
Expected: FAIL (módulo `claude-input` não existe; args antigos).

- [ ] **Step 3: Implementar**

`src/cli/claude-input.ts`:

```ts
/** Decisão do usuário sobre um pedido de permissão (formato aceito por `control_response` do Claude Code). */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string };

/** Mensagem de usuário para o stdin do `claude --input-format stream-json` (uma linha JSON). */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

/** Resposta a um `control_request` (`can_use_tool`) no stdin do CLI. */
export function permissionResponseLine(requestId: string, decision: PermissionDecision): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: decision },
  }) + '\n';
}
```

`src/cli/claude-args.ts` — remova `prompt` da interface e as duas últimas linhas, e acrescente as flags:

```ts
export interface ClaudeArgsInput {
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: string;
  settingsFile?: string;
  appendSystemPrompt?: string;
  model?: string;
  effort?: string;
}

export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  // A mensagem do turno vai pelo stdin (stream-json) e os pedidos de permissão voltam pelo mesmo canal (stdio).
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--permission-prompt-tool=stdio'];
  if (i.permissionMode) args.push('--permission-mode', i.permissionMode);
  // Cada regra é um argumento: vírgulas e espaços dentro de uma regra (ex.: caminhos) não a quebram.
  if (i.allowedTools?.length) args.push('--allowedTools', ...i.allowedTools);
  if (i.disallowedTools?.length) args.push('--disallowedTools', ...i.disallowedTools);
  if (i.resume) args.push('--resume', i.resume);
  if (i.settingsFile) args.push('--settings', i.settingsFile);
  if (i.model) args.push('--model', i.model);
  if (i.effort) args.push('--effort', i.effort);
  if (i.appendSystemPrompt) args.push('--append-system-prompt', i.appendSystemPrompt);
  return args;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/cli/claude-input.test.ts tests/cli/claude-args.test.ts`
Expected: PASS. (`run-controller.ts` ainda passa `prompt:` a `buildClaudeArgs` e `tsc` vai reclamar — será corrigido na Task 5; não rode `tsc`/suíte completa agora.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/claude-input.ts src/cli/claude-args.ts tests/cli/claude-input.test.ts tests/cli/claude-args.test.ts
git commit -m "feat: mensagem do Claude via stdin e flag de permissão por stdio"
```

---

### Task 2: Evento, resumo e armazenamento do pedido de permissão

**Files:**
- Create: `src/core/permission.ts`
- Modify: `src/core/schema.ts`, `src/core/store.ts`, `src/core/snapshot.ts`, `src/protocol.ts` (só o tipo `NodeView`)
- Test: `tests/core/permission.test.ts` (novo), `tests/core/store.test.ts`, `tests/core/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `PermissionPrompt = { requestId: string; tool: string; summary: string; hasAlways: boolean }` (em `schema.ts`)
  - `AgentNode.permissions?: PermissionPrompt[]`
  - `NormalizedEvent` ganha:
    `{ type: 'permission_request'; runId: string; nodeId: string; requestId: string; tool: string; input: Record<string, unknown>; description?: string; suggestions: unknown[]; ts: number }` e
    `{ type: 'permission_resolved'; runId: string; requestId: string; ts: number }`
  - `NodeView.permissions?: PermissionPrompt[]`
  - `summarizeToolInput(tool: string, input: Record<string, unknown>, description?: string): string`
  - `alwaysSuggestion(suggestions: unknown[]): unknown | undefined` — primeira sugestão `addRules` com `behavior: 'allow'`

- [ ] **Step 1: Testes que falham**

`tests/core/permission.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { alwaysSuggestion, summarizeToolInput } from '../../src/core/permission';

describe('summarizeToolInput', () => {
  it('Bash mostra o comando', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test', description: 'Roda os testes' })).toBe('npm test');
  });
  it('Edit/Write/Read mostram o caminho', () => {
    expect(summarizeToolInput('Edit', { file_path: '/p/a.ts', old_string: 'x' })).toBe('/p/a.ts');
    expect(summarizeToolInput('Read', { file_path: '/p/b.ts' })).toBe('/p/b.ts');
  });
  it('outras ferramentas mostram o JSON da entrada', () => {
    expect(summarizeToolInput('WebFetch', { url: 'https://x.dev' })).toBe('{"url":"https://x.dev"}');
  });
  it('sem entrada útil usa a descrição', () => {
    expect(summarizeToolInput('Foo', {}, 'faz algo')).toBe('faz algo');
  });
  it('limita a 2.000 caracteres', () => {
    const s = summarizeToolInput('Bash', { command: 'x'.repeat(5000) });
    expect(s.length).toBeLessThanOrEqual(2001);
    expect(s.endsWith('…')).toBe(true);
  });
  it('remove controles, largura zero e marcas bidi', () => {
    expect(summarizeToolInput('Bash', { command: 'ls\u0000‮ -la​' })).toBe('ls -la');
  });
});

describe('alwaysSuggestion', () => {
  const add = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' };
  it('devolve a primeira addRules de allow', () => {
    expect(alwaysSuggestion([{ type: 'addDirectories', directories: ['/p'] }, add])).toBe(add);
  });
  it('ignora regras que não são allow e entradas inválidas', () => {
    expect(alwaysSuggestion([{ type: 'addRules', behavior: 'deny' }, null, 7, 'x'])).toBeUndefined();
    expect(alwaysSuggestion([])).toBeUndefined();
  });
});
```

Em `tests/core/store.test.ts`, dentro do `describe('RunStore', …)` adicione:

```ts
  describe('permissões', () => {
    const req = (id: string, extra: Record<string, unknown> = {}) => ({
      type: 'permission_request' as const, runId: 'r1', nodeId: 'r1:root', requestId: id, tool: 'Bash',
      input: { command: `cmd-${id}` }, suggestions: [{ type: 'addRules', behavior: 'allow', rules: [] }], ts: 3, ...extra,
    });

    it('pedido entra na fila do node sem mudar o status; resolved remove só o pedido certo', () => {
      const s = newStore();
      s.apply(req('a'));
      s.apply(req('b'));
      const root = s.nodes.get('r1:root')!;
      expect(root.status).toBe('running');
      expect(root.permissions!.map((p) => p.requestId)).toEqual(['a', 'b']);
      expect(root.permissions![0]).toEqual({ requestId: 'a', tool: 'Bash', summary: 'cmd-a', hasAlways: true });
      s.apply({ type: 'permission_resolved', runId: 'r1', requestId: 'a', ts: 4 });
      expect(root.permissions!.map((p) => p.requestId)).toEqual(['b']);
    });

    it('hasAlways é false sem sugestão', () => {
      const s = newStore();
      s.apply(req('a', { suggestions: [] }));
      expect(s.nodes.get('r1:root')!.permissions![0]!.hasAlways).toBe(false);
    });

    it('pedido para node inexistente cai na raiz', () => {
      const s = newStore();
      s.apply(req('a', { nodeId: 'r1:nao-existe' }));
      expect(s.nodes.get('r1:root')!.permissions).toHaveLength(1);
    });

    it('run_finished limpa os pedidos pendentes', () => {
      const s = newStore();
      s.apply(req('a'));
      s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 9 });
      expect(s.nodes.get('r1:root')!.permissions ?? []).toEqual([]);
    });

    it('pedido depois do run encerrado é ignorado', () => {
      const s = newStore();
      s.apply({ type: 'run_finished', runId: 'r1', status: 'done', ts: 9 });
      s.apply(req('late'));
      expect(s.nodes.get('r1:root')!.permissions ?? []).toEqual([]);
    });
  });
```

Em `tests/core/snapshot.test.ts` adicione (reaproveitando o import de `RunStore`/`toRunView` do arquivo):

```ts
it('toRunView expõe os pedidos de permissão do node (sem input nem sugestões)', () => {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  s.apply({ type: 'run_started', runId: 'r1', ts: 1 });
  s.apply({ type: 'permission_request', runId: 'r1', nodeId: 'r1:root', requestId: 'a', tool: 'Bash', input: { command: 'ls' }, suggestions: [], ts: 2 });
  const node = toRunView(s).nodes[0]!;
  expect(node.permissions).toEqual([{ requestId: 'a', tool: 'Bash', summary: 'ls', hasAlways: false }]);
  expect(JSON.stringify(node)).not.toContain('suggestions');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/core/permission.test.ts tests/core/store.test.ts tests/core/snapshot.test.ts`
Expected: FAIL (módulo e eventos não existem).

- [ ] **Step 3: Implementar**

`src/core/permission.ts`:

```ts
const MAX_SUMMARY = 2000;
// Controles, largura zero e marcas de direção (bidi) podem enganar a leitura do que está sendo aprovado.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;

const clean = (s: string) => s.replace(UNSAFE, '');

/** Texto curto e seguro do que o agente quer fazer, para a pessoa decidir. */
export function summarizeToolInput(tool: string, input: Record<string, unknown>, description?: string): string {
  let text = '';
  if (tool === 'Bash' && typeof input.command === 'string') text = input.command;
  else if (typeof input.file_path === 'string') text = input.file_path;
  else if (Object.keys(input).length > 0) {
    try {
      text = JSON.stringify(input) ?? '';
    } catch {
      text = '';
    }
  }
  if (!text) text = description ?? '';
  text = clean(text);
  return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) + '…' : text;
}

/** Primeira sugestão do CLI que cria uma regra "permitir" (é o que "Permitir sempre" aplica). */
export function alwaysSuggestion(suggestions: unknown[]): unknown | undefined {
  return suggestions.find((s) => !!s && typeof s === 'object' && (s as any).type === 'addRules' && (s as any).behavior === 'allow');
}
```

`src/core/schema.ts` — após `Question` adicione:

```ts
/** Pedido de permissão de ferramenta aguardando a pessoa (só o que a tela precisa). */
export interface PermissionPrompt {
  requestId: string;
  tool: string;
  summary: string;
  /** o CLI sugeriu uma regra "permitir sempre" */
  hasAlways: boolean;
}
```

em `AgentNode`, depois de `question?: Question;` adicione `permissions?: PermissionPrompt[];` e no `NormalizedEvent`, antes do `usage`, acrescente:

```ts
  /** o CLI pede permissão para usar uma ferramenta (controle por stdin); a decisão volta pelo processo */
  | {
      type: 'permission_request'; runId: string; nodeId: string; requestId: string; tool: string;
      input: Record<string, unknown>; description?: string; suggestions: unknown[]; ts: number;
    }
  | { type: 'permission_resolved'; runId: string; requestId: string; ts: number }
```

`src/core/store.ts` — `import { alwaysSuggestion, summarizeToolInput } from './permission';` e, dentro do `switch (e.type)`, antes de `case 'usage':` adicione:

```ts
      case 'permission_request': {
        const node = this.nodes.get(e.nodeId) ?? this.nodes.get(this.rootId);
        if (!node) return;
        (node.permissions ??= []).push({
          requestId: e.requestId, tool: e.tool,
          summary: summarizeToolInput(e.tool, e.input, e.description),
          hasAlways: alwaysSuggestion(e.suggestions) !== undefined,
        });
        return;
      }
      case 'permission_resolved': {
        for (const node of this.nodes.values()) {
          if (node.permissions) node.permissions = node.permissions.filter((p) => p.requestId !== e.requestId);
        }
        return;
      }
```

e no início de `case 'run_finished': {` acrescente a primeira linha `for (const node of this.nodes.values()) delete node.permissions;`.

`src/protocol.ts` — em `NodeView`, depois de `question?: Question;`:

```ts
  /** pedidos de permissão pendentes, do mais antigo ao mais novo */
  permissions?: PermissionPrompt[];
```

e no import de tipos da primeira linha: `import type { NodeStatus, PermissionPrompt, Question } from './core/schema';`.

`src/core/snapshot.ts` — no `.map` dos nodes, depois da linha de `question`:

```ts
      ...(n.permissions?.length ? { permissions: n.permissions } : {}),
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core src/protocol.ts tests/core
git commit -m "feat: pedido de permissão no store e no snapshot"
```

---

### Task 3: O adapter lê `control_request` (`can_use_tool`)

**Files:**
- Modify: `src/cli/stream-adapter.ts`
- Test: `tests/cli/stream-adapter.test.ts`

**Interfaces:**
- Consumes: evento `permission_request` (Task 2).
- Produces: `StreamAdapter.push` emite `permission_request` com `nodeId = rootNodeId(runId)`.

- [ ] **Step 1: Testes que falham** (dentro do `describe('StreamAdapter', …)`)

```ts
  describe('control_request', () => {
    const line = (o: unknown) => JSON.stringify(o);
    const can = (over: Record<string, unknown> = {}, reqOver: Record<string, unknown> = {}) => line({
      type: 'control_request', request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, description: 'Lista', permission_suggestions: [{ type: 'addRules' }], ...reqOver },
      ...over,
    });

    it('can_use_tool vira permission_request na raiz', () => {
      const a = new StreamAdapter('r1');
      const ev = a.push(can());
      expect(ev.map((e) => e.type)).toEqual(['run_started', 'permission_request']);
      expect(ev[1]).toMatchObject({
        type: 'permission_request', runId: 'r1', nodeId: 'r1:root', requestId: 'req-1', tool: 'Bash',
        input: { command: 'ls' }, description: 'Lista', suggestions: [{ type: 'addRules' }],
      });
    });

    it('sem sugestões, suggestions é []', () => {
      const ev = new StreamAdapter('r1').push(can({}, { permission_suggestions: undefined }));
      expect(ev.at(-1)).toMatchObject({ suggestions: [] });
    });

    it('subtype desconhecido é ignorado, sem contar como malformado', () => {
      const a = new StreamAdapter('r1');
      expect(a.push(line({ type: 'control_request', request_id: 'x', request: { subtype: 'hook_callback' } }))).toEqual([]);
      expect(a.malformedLines).toBe(0);
    });

    it('can_use_tool sem request_id ou sem tool_name conta como malformado e não vira evento', () => {
      const a = new StreamAdapter('r1');
      expect(a.push(can({ request_id: undefined }))).toEqual([]);
      expect(a.push(can({}, { tool_name: undefined }))).toEqual([]);
      expect(a.malformedLines).toBe(2);
    });

    it('input que não é objeto vira {}', () => {
      const ev = new StreamAdapter('r1').push(can({}, { input: 'texto' }));
      expect(ev.at(-1)).toMatchObject({ input: {} });
    });
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/cli/stream-adapter.test.ts -t control_request`
Expected: FAIL.

- [ ] **Step 3: Implementar** — em `push`, antes do `} else if (m.type === 'assistant' || m.type === 'user') {` insira:

```ts
    } else if (m.type === 'control_request') {
      const r = m.request;
      if (r?.subtype === 'can_use_tool') {
        if (typeof m.request_id !== 'string' || typeof r.tool_name !== 'string') {
          this.malformedLines += 1;
        } else {
          out.push(...this.start(m.session_id, ts));
          out.push({
            type: 'permission_request', runId: this.runId, nodeId: this.root, requestId: m.request_id, tool: r.tool_name,
            input: r.input && typeof r.input === 'object' && !Array.isArray(r.input) ? r.input : {},
            ...(typeof r.description === 'string' ? { description: r.description } : {}),
            suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
            ts,
          });
        }
      }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/cli/stream-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stream-adapter.ts tests/cli/stream-adapter.test.ts
git commit -m "feat: adapter converte can_use_tool em permission_request"
```

---

### Task 4: `process-run` escreve no stdin e responde pedidos

**Files:**
- Modify: `src/cli/process-run.ts`, `fixtures/fake-claude.mjs`
- Test: `tests/cli/process-run.test.ts`

**Interfaces:**
- Consumes: `PermissionDecision`, `permissionResponseLine` (Task 1).
- Produces:
  - `ProcessRunOptions.input?: string` — linhas já terminadas em `\n`, escritas no stdin ao iniciar (só então o stdin é `pipe`; sem `input` continua `ignore`).
  - `ProcessRun.respond(requestId: string, decision: PermissionDecision): boolean` — `true` se escreveu; `false` se o stdin já está fechado.
  - O stdin fecha sozinho quando o adapter emite `run_finished`, no `cancel()` e quando o processo termina.

**Se o spike (Task 0) disser que não pode fechar no `run_finished`:** troque o gatilho de fechamento por "só no `cancel()` e no término do processo" (apague a chamada em `emit`) e ajuste o teste "fecha o stdin no result" para esperar que o stdin siga aberto.

- [ ] **Step 1: Estender o fake**

Substitua `fixtures/fake-claude.mjs` por:

```js
// Uso: node fake-claude.mjs <arquivo.ndjson|-> [--hang] [--grandchild-pid-file <caminho>] [--stdin-file <caminho>] [--reply-file <caminho>]
// Linhas do ndjson no formato {"__wait":"<request_id>"} fazem o fake esperar o control_response daquele id no stdin
// (e gravá-lo em --reply-file) antes de seguir. --stdin-file grava tudo o que chegou no stdin ao fechar.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [, , file, ...flags] = process.argv;
const flagValue = (name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };

const i = flags.indexOf('--grandchild-pid-file');
if (i >= 0) {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(flags[i + 1], String(gc.pid));
}
if (flags.includes('--ignore-sigterm')) process.on('SIGTERM', () => {});

const stdinFile = flagValue('--stdin-file');
const replyFile = flagValue('--reply-file');
const needsStdin = !!stdinFile || !!replyFile || (file && file !== '-' && readFileSync(file, 'utf8').includes('__wait'));
const waiters = new Map();
if (needsStdin) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (stdinFile) appendFileSync(stdinFile, line + '\n');
    try {
      const m = JSON.parse(line);
      const id = m?.response?.request_id;
      if (m?.type === 'control_response' && id) {
        if (replyFile) appendFileSync(replyFile, line + '\n');
        waiters.get(id)?.();
        waiters.delete(id);
      }
    } catch { /* linha que não é JSON */ }
  });
}

if (file && file !== '-') {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const wait = line.includes('__wait') ? JSON.parse(line).__wait : undefined;
    if (wait) await new Promise((resolve) => waiters.set(wait, resolve));
    else process.stdout.write(line + '\n');
  }
}
if (flags.includes('--hang')) setInterval(() => {}, 1000);
else if (needsStdin) process.exit(0);
```

- [ ] **Step 2: Testes que falham** (em `tests/cli/process-run.test.ts`, dentro do `describe('startProcessRun', …)`)

```ts
  describe('stdin e permissões', () => {
    const ask = L({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
    const script = (extra: string[] = []) => [
      L({ type: 'system', subtype: 'init', session_id: 's1' }),
      ask,
      L({ __wait: 'req-1' }),
      L({ type: 'result', is_error: false, session_id: 's1' }),
      ...extra,
    ].join('\n') + '\n';

    it('escreve a mensagem inicial no stdin e entrega o pedido ao onEvent', async () => {
      const dir = tmp();
      const f = path.join(dir, 's.ndjson'); writeFileSync(f, script());
      const stdinFile = path.join(dir, 'stdin.log'); const replyFile = path.join(dir, 'reply.log');
      const events: NormalizedEvent[] = [];
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--stdin-file', stdinFile, '--reply-file', replyFile], cwd: process.cwd(),
        input: '{"type":"user","message":{"role":"user","content":"oi"}}\n',
      }, (e) => {
        events.push(e);
        if (e.type === 'permission_request') {
          expect(run.respond(e.requestId, { behavior: 'allow', updatedInput: { command: 'ls' } })).toBe(true);
        }
      });
      const r = await run.done;
      expect(r.exitCode).toBe(0);
      expect(events.map((e) => e.type)).toContain('permission_request');
      expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'done' });
      expect(readFileSync(stdinFile, 'utf8')).toContain('"content":"oi"');
      expect(JSON.parse(readFileSync(replyFile, 'utf8').trim())).toEqual({
        type: 'control_response', response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
      });
    });

    it('respond depois do fim do processo devolve false, sem exceção', async () => {
      const f = path.join(tmp(), 's.ndjson'); writeFileSync(f, happy);
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd(), input: 'x\n' }, () => {});
      await run.done;
      expect(run.respond('req-1', { behavior: 'deny', message: 'n' })).toBe(false);
    });

    it('processo que sai antes de ler o stdin não gera erro não tratado (EPIPE)', async () => {
      const f = path.join(tmp(), 's.ndjson'); writeFileSync(f, happy);
      const big = 'y'.repeat(1_000_000) + '\n';
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd(), input: big }, () => {});
      const r = await run.done;
      expect(r.exitCode).toBe(0);
    });

    it('cancelar com pedido pendente encerra o processo e termina cancelled', async () => {
      const dir = tmp(); const f = path.join(dir, 's.ndjson'); writeFileSync(f, script());
      const events: NormalizedEvent[] = [];
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd(), input: 'x\n' }, (e) => {
        events.push(e);
        if (e.type === 'permission_request') run.cancel();
      });
      const r = await run.done;
      expect(r.cancelled).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'run_finished', status: 'cancelled' });
    });

    it('sem input o stdin continua fechado (Codex e usos antigos)', async () => {
      const f = path.join(tmp(), 's.ndjson'); writeFileSync(f, happy);
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f], cwd: process.cwd() }, () => {});
      expect(run.respond('req-1', { behavior: 'deny', message: 'n' })).toBe(false);
      await run.done;
    });
  });
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/cli/process-run.test.ts -t "stdin e permissões"`
Expected: FAIL (`input`/`respond` não existem).

- [ ] **Step 4: Implementar** em `src/cli/process-run.ts`

Importe: `import { permissionResponseLine, type PermissionDecision } from './claude-input';`

Opções e interface:

```ts
  /** Linhas (já com \n) escritas no stdin ao iniciar; só então o stdin é um pipe. O Claude manda a mensagem do turno por aqui. */
  input?: string;
```

```ts
export interface ProcessRun {
  cancel(): void;
  /** Responde a um pedido de permissão pelo stdin. false se o stdin já não está disponível. */
  respond(requestId: string, decision: PermissionDecision): boolean;
  done: Promise<ProcessRunResult>;
}
```

Em `startProcessRun`: troque `stdio: ['ignore', 'pipe', 'pipe']` por `stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']`. Troque a linha `const emit = …` por:

```ts
  const emit = (events: NormalizedEvent[]) => {
    events.forEach(onEvent);
    // O turno acabou: não há mais nada a responder, e fechar o stdin deixa o CLI sair.
    if (events.some((e) => e.type === 'run_finished')) closeStdin();
  };
```

Logo depois do `spawn(...)` (antes do `createInterface`), acrescente:

```ts
  let stdinOpen = false;
  const closeStdin = () => {
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin?.end();
  };
  if (opts.input !== undefined && child.stdin) {
    stdinOpen = true;
    // O CLI pode sair antes de ler tudo (EPIPE): não é erro do Visor.
    child.stdin.on('error', () => { stdinOpen = false; });
    child.stdin.write(opts.input);
  }
```

(`emit` é declarado antes e usa `closeStdin`, que é uma `const` declarada depois do spawn mas só chamada depois — por isso mova a declaração de `emit` para **depois** do bloco acima, ou declare `let closeStdin = () => {}` antes e atribua depois. Use a segunda forma: `let closeStdin: () => void = () => {};` junto das outras variáveis e troque `const closeStdin = () => {` por `closeStdin = () => {`.)

Em `finish`, antes de `emit(adapter.end(cancelled))`, chame `closeStdin();`. No retorno:

```ts
  return {
    done,
    respond(requestId, decision) {
      if (!stdinOpen || !child.stdin || child.stdin.destroyed) return false;
      child.stdin.write(permissionResponseLine(requestId, decision));
      return true;
    },
    cancel() {
      if (cancelled || child.pid === undefined) return;
      cancelled = true;
      closeStdin();
      …(resto igual)
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/cli`
Expected: PASS (incluindo os testes antigos de `process-run`, que agora rodam com o fake novo).

- [ ] **Step 6: Commit**

```bash
git add src/cli/process-run.ts fixtures/fake-claude.mjs tests/cli/process-run.test.ts
git commit -m "feat: process-run escreve no stdin e responde pedidos de permissão"
```

---

### Task 5: Protocolo e `RunController`

**Files:**
- Modify: `src/protocol.ts`, `src/ext/run-controller.ts`
- Test: `tests/protocol.test.ts`, `tests/ext/run-controller.test.ts`

**Interfaces:**
- Consumes: `userMessageLine`, `PermissionDecision` (Task 1); `alwaysSuggestion` (Task 2); `ProcessRun.respond`, `ProcessRunOptions.input` (Task 4).
- Produces:
  - `WebviewMessage` ganha `{ type: 'permission'; runId: string; requestId: string; decision: 'allow' | 'allow_always' | 'deny' }`.
  - O turno do Claude passa `input: userMessageLine(prompt)` em `startRun` e `buildClaudeArgs` sem `prompt`.

- [ ] **Step 1: Testes que falham**

`tests/protocol.test.ts` (dentro do `describe('parseWebviewMessage', …)`):

```ts
  it('permission: aceita as três decisões e valida os ids', () => {
    for (const decision of ['allow', 'allow_always', 'deny'] as const) {
      expect(parseWebviewMessage({ type: 'permission', runId: 'r1', requestId: 'q1', decision })).toEqual({ type: 'permission', runId: 'r1', requestId: 'q1', decision });
    }
    expect(parseWebviewMessage({ type: 'permission', runId: 'r1', requestId: 'q1', decision: 'talvez' })).toBeNull();
    expect(parseWebviewMessage({ type: 'permission', runId: '', requestId: 'q1', decision: 'allow' })).toBeNull();
    expect(parseWebviewMessage({ type: 'permission', runId: 'r1', requestId: 'x'.repeat(301), decision: 'allow' })).toBeNull();
    expect(parseWebviewMessage({ type: 'permission', runId: 'r1', decision: 'allow' })).toBeNull();
  });
```

`tests/ext/run-controller.test.ts`:

1. Em `FakeRun` acrescente `respond: ReturnType<typeof vi.fn>;` e em `startRun` do `setup` troque o corpo por:

```ts
    const cancel = vi.fn();
    const respond = vi.fn(() => true);
    let finish: (r: ProcessRunResult) => void = () => {};
    const done = new Promise<ProcessRunResult>((res) => (finish = res));
    runs.push({ runId, opts, emit: on, finish: (r) => finish(r ?? result()), cancel, respond });
    return { cancel, respond, done };
```

2. Adicione, perto do topo (depois de `Q`), um helper para ler o prompt que agora vai no `input`:

```ts
const promptOf = (opts: ProcessRunOptions): string => {
  const line = JSON.parse(opts.input!.trim());
  return line.message.content;
};
```

3. Ajuste as asserções que liam o prompt dos args (linhas aproximadas de hoje):
   - `expect(opts.args.slice(-2)).toEqual(['--', 'olá']);` → `expect(promptOf(opts)).toBe('olá');`
   - `expect(opts.args.slice(-2)).toEqual(['--', 'Azul']);` → `expect(promptOf(opts)).toBe('Azul');`
   - `t.runs.at(-1)!.opts.args.at(-1)!` (prompts de continuação de subagente) → `promptOf(t.runs.at(-1)!.opts)`
   - `expect(opts.args.at(-1)).toContain('subagent_type "reader"');` → `expect(promptOf(opts)).toContain('subagent_type "reader"');`
   - `expect(t.runs[0]!.opts.args.at(-1)).toContain(...)` → `expect(promptOf(t.runs[0]!.opts)).toContain(...)`
   Procure outras com `grep -n "args.at(-1)\|slice(-2)" tests/ext/run-controller.test.ts` e converta do mesmo jeito. Testes de Codex não mudam.

4. Novos testes (no fim do arquivo):

```ts
describe('permissões interativas', () => {
  const ask = (runId: string, requestId: string, suggestions: unknown[] = [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }]): NormalizedEvent => ({
    type: 'permission_request', runId, nodeId: `${runId}:root`, requestId, tool: 'Bash', input: { command: 'ls' }, suggestions, ts: 4,
  });

  it('o turno do Claude manda a mensagem pelo stdin e usa as flags de permissão', async () => {
    const t = setup();
    const done = await startChat(t, 'oi');
    const { opts } = t.runs[0]!;
    expect(opts.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--permission-prompt-tool=stdio']));
    expect(opts.args).not.toContain('--');
    expect(promptOf(opts)).toBe('oi');
    t.runs[0]!.finish(); await done;
  });

  it('o pedido aparece no snapshot (sem input nem sugestões) e o status não muda', async () => {
    const t = setup();
    const done = await startChat(t);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(ask('r1', 'q1'));
    await t.tick();
    const root = t.view('r1').nodes[0]!;
    expect(root.permissions).toEqual([{ requestId: 'q1', tool: 'Bash', summary: 'ls', hasAlways: true }]);
    expect(root.status).toBe('running');
    t.runs[0]!.finish(); await done;
  });

  it.each([
    ['allow', { behavior: 'allow', updatedInput: { command: 'ls' } }],
    ['allow_always', { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }] }],
    ['deny', { behavior: 'deny', message: 'Negado pelo usuário no Visor.' }],
  ] as const)('decisão %s é enviada ao processo e o pedido some', async (decision, expected) => {
    const t = setup();
    const done = await startChat(t);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(ask('r1', 'q1'));
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'q1', decision });
    expect(t.runs[0]!.respond).toHaveBeenCalledWith('q1', expected);
    await t.tick();
    expect(t.view('r1').nodes[0]!.permissions).toBeUndefined();
    t.runs[0]!.finish(); await done;
  });

  it('allow_always sem sugestão age como allow', async () => {
    const t = setup();
    const done = await startChat(t);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(ask('r1', 'q1', []));
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'q1', decision: 'allow_always' });
    expect(t.runs[0]!.respond).toHaveBeenCalledWith('q1', { behavior: 'allow', updatedInput: { command: 'ls' } });
    t.runs[0]!.finish(); await done;
  });

  it('dois pedidos: cada decisão vai para o requestId certo', async () => {
    const t = setup();
    const done = await startChat(t);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(ask('r1', 'a')); t.runs[0]!.emit(ask('r1', 'b'));
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'b', decision: 'deny' });
    await t.tick();
    expect(t.runs[0]!.respond).toHaveBeenCalledWith('b', expect.objectContaining({ behavior: 'deny' }));
    expect(t.view('r1').nodes[0]!.permissions!.map((p) => p.requestId)).toEqual(['a']);
    t.runs[0]!.finish(); await done;
  });

  it('pedido inexistente, repetido ou depois do fim do turno é ignorado com aviso', async () => {
    const t = setup();
    const done = await startChat(t);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(ask('r1', 'q1'));
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'nao-existe', decision: 'allow' });
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'q1', decision: 'allow' });
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'q1', decision: 'allow' }); // repetido
    expect(t.runs[0]!.respond).toHaveBeenCalledTimes(1);
    t.runs[0]!.finish(); await done;
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'q1', decision: 'allow' }); // turno acabou
    expect(t.runs[0]!.respond).toHaveBeenCalledTimes(1);
    expect(t.notices().filter((n) => n.text.includes('permissão')).length).toBeGreaterThanOrEqual(2);
    await t.c.handle({ type: 'permission', runId: 'nao-existe', requestId: 'q1', decision: 'allow' }); // sem exceção
  });

  it('se o processo não aceita mais a resposta (respond false), avisa e remove o pedido', async () => {
    const t = setup();
    const done = await startChat(t);
    t.runs[0]!.respond.mockReturnValue(false);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(ask('r1', 'q1'));
    await t.c.handle({ type: 'permission', runId: 'r1', requestId: 'q1', decision: 'allow' });
    await t.tick();
    expect(t.view('r1').nodes[0]!.permissions).toBeUndefined();
    expect(t.notices().some((n) => n.text.includes('permissão'))).toBe(true);
    t.runs[0]!.finish(); await done;
  });

  it('terminar o turno com pedido pendente limpa o pedido', async () => {
    const t = setup();
    const done = await startChat(t);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(ask('r1', 'q1'));
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'cancelled', ts: 9 });
    t.runs[0]!.finish(); await done;
    expect(t.view('r1').nodes[0]!.permissions).toBeUndefined();
  });
});
```

(`startChat`, `init`, `t.view`, `t.notices`, `t.tick` já existem no arquivo.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/protocol.test.ts tests/ext/run-controller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

`src/protocol.ts` — em `WebviewMessage`, após `| { type: 'pickFiles'; requestId: string }`:

```ts
  | { type: 'permission'; runId: string; requestId: string; decision: 'allow' | 'allow_always' | 'deny' }
```

e em `parseWebviewMessage`, antes de `case 'listClis':`:

```ts
    case 'permission':
      return validNodeId(m.runId) && validNodeId(m.requestId) && (m.decision === 'allow' || m.decision === 'allow_always' || m.decision === 'deny')
        ? { type: 'permission', runId: m.runId, requestId: m.requestId, decision: m.decision }
        : null;
```

`src/ext/run-controller.ts`:

- imports: `import { userMessageLine, type PermissionDecision } from '../cli/claude-input';` e `import { alwaysSuggestion } from '../core/permission';`.
- `Chat` ganha `pending: Map<string, Extract<NormalizedEvent, { type: 'permission_request' }>>;`. Em `startChat` (hoje `chat = { store, busy: true, cancelRequested: false };`, `src/ext/run-controller.ts:587`), acrescente `pending: new Map()`.
- No `switch` de `handle`, depois de `case 'send':`:

```ts
      case 'permission':
        this.answerPermission(msg.runId, msg.requestId, msg.decision);
        return;
```

- Método novo (junto de `cancelChat`):

```ts
  /** Decisão da pessoa sobre um pedido de permissão do Claude: vira o control_response no stdin do processo. */
  private answerPermission(runId: string, requestId: string, decision: 'allow' | 'allow_always' | 'deny'): void {
    const chat = this.chats.get(runId);
    const req = chat?.pending.get(requestId);
    if (!chat || !req) {
      this.notice('warn', 'Esse pedido de permissão não está mais ativo.', chat);
      return;
    }
    chat.pending.delete(requestId);
    let answer: PermissionDecision;
    if (decision === 'deny') {
      answer = { behavior: 'deny', message: 'Negado pelo usuário no Visor.' };
    } else {
      const always = decision === 'allow_always' ? alwaysSuggestion(req.suggestions) : undefined;
      answer = { behavior: 'allow', updatedInput: req.input, ...(always ? { updatedPermissions: [always] } : {}) };
    }
    const delivered = chat.active?.respond(requestId, answer) ?? false;
    chat.store.apply({ type: 'permission_resolved', runId, requestId, ts: Date.now() });
    this.dirty.add(runId);
    this.schedule();
    if (!delivered) this.notice('warn', 'Não consegui entregar a permissão: o processo já terminou.', chat);
  }
```

- Em `runTurn`, no ramo `else` do Claude, remova `prompt: t.prompt,` de `buildClaudeArgs` e acrescente após o `if/else` que monta `command/args` uma variável `let input: string | undefined;` (declare junto de `command`/`args`) e, no ramo Claude, `input = userMessageLine(t.prompt);`. Em `startRun`, acrescente nas opções: `...(input !== undefined ? { input } : {}),`.
- No callback de eventos de `startRun`, antes de `store.apply(e);`:

```ts
          if (e.type === 'permission_request') chat.pending.set(e.requestId, e);
```

- Depois de `const result = await run.done;` e `chat.active = undefined;` acrescente `chat.pending.clear();`. No `catch (err)` também `chat.pending.clear();`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsc --noEmit && npx vitest run tests/protocol.test.ts tests/ext/run-controller.test.ts`
Expected: sem erros de tipo e PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts src/ext/run-controller.ts tests/protocol.test.ts tests/ext/run-controller.test.ts
git commit -m "feat: host recebe a decisão de permissão e responde ao processo"
```

---

### Task 6: Card de permissão na Webview

**Files:**
- Create: `webview/PermissionCard.tsx`
- Modify: `webview/graph.ts`, `webview/ChatCard.tsx`, `webview/chat-context.ts`, `webview/App.tsx`, `webview/styles.css`
- Test: `tests/webview/app-render.test.tsx`

**Interfaces:**
- Consumes: `NodeView.permissions` (Task 2), mensagem `permission` (Task 5).
- Produces: `ChatNodeData.permission?: PermissionPrompt`, `ChatNodeData.permissionCount?: number`; `ChatCtx.onPermission(runId: string, requestId: string, decision: 'allow' | 'allow_always' | 'deny'): void`.

- [ ] **Step 1: Testes que falham** (no fim de `tests/webview/app-render.test.tsx`)

```tsx
// ---------- permissões ----------
const asking = (hasAlways = true, extra: Partial<RunView['nodes'][number]> = {}) =>
  chat('r', 'Permissão', 'running', { permissions: [{ requestId: 'q1', tool: 'Bash', summary: 'rm -rf build', hasAlways }], ...extra }, true);

it('mostra o card de permissão com a ferramenta e o resumo, e os três botões enviam a decisão', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking()] });
  const c = card('r').querySelector('.permission-card')!;
  expect(c).not.toBeNull();
  expect(c.textContent).toContain('Bash');
  expect(c.textContent).toContain('rm -rf build');
  const labels = [...c.querySelectorAll('button')].map((b) => b.textContent);
  expect(labels).toEqual(['Permitir', 'Permitir sempre', 'Negar']);
  for (const [label, decision] of [['Permitir', 'allow'], ['Permitir sempre', 'allow_always'], ['Negar', 'deny']] as const) {
    posted.length = 0;
    await click([...c.querySelectorAll('button')].find((b) => b.textContent === label)!);
    expect(posted).toContainEqual({ type: 'permission', runId: 'r', requestId: 'q1', decision });
  }
  await unmount(root);
});

it('sem sugestão do CLI não há "Permitir sempre"', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking(false)] });
  expect([...card('r').querySelectorAll('.permission-card button')].map((b) => b.textContent)).toEqual(['Permitir', 'Negar']);
  await unmount(root);
});

it('com vários pedidos mostra um por vez e avisa quantos faltam; sem pedido, o card some', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking(true, { permissions: [
    { requestId: 'q1', tool: 'Bash', summary: 'ls', hasAlways: true },
    { requestId: 'q2', tool: 'Edit', summary: '/p/a.ts', hasAlways: false },
  ] })] });
  expect(card('r').querySelectorAll('.permission-card')).toHaveLength(1);
  expect(card('r').querySelector('.permission-card')!.textContent).toContain('ls');
  expect(card('r').querySelector('.permission-card')!.textContent).toContain('+1 pedido');
  await send({ type: 'snapshot', runs: [chat('r', 'Permissão', 'running', {}, true)] });
  expect(card('r').querySelector('.permission-card')).toBeNull();
  await unmount(root);
});

it('o texto do pedido é exibido como texto (sem interpretar HTML)', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking(true, { permissions: [{ requestId: 'q1', tool: 'Bash', summary: '<img src=x onerror=alert(1)>', hasAlways: false }] })] });
  expect(card('r').querySelector('.permission-card img')).toBeNull();
  expect(card('r').querySelector('.permission-card')!.textContent).toContain('<img src=x onerror=alert(1)>');
  await unmount(root);
});
```

(`mount`, `unmount`, `card`, `chat`, `posted` já existem no arquivo.)

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/webview/app-render.test.tsx -t "permissão"`
Expected: FAIL.

- [ ] **Step 3: Implementar**

`webview/PermissionCard.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import type { PermissionPrompt } from '../src/core/schema';

export type PermissionChoice = 'allow' | 'allow_always' | 'deny';

/** Pedido de permissão de ferramenta do Claude Code: a pessoa decide aqui, sem sair do Visor. */
export function PermissionCard({ prompt, more, onAnswer }: { prompt: PermissionPrompt; more: number; onAnswer(choice: PermissionChoice): void }) {
  const first = useRef<HTMLButtonElement>(null);
  // Foco no primeiro botão quando um pedido novo aparece, para dar para decidir pelo teclado.
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, [prompt.requestId]);
  return (
    <div className="permission-card" role="group" aria-label="Pedido de permissão">
      <div className="question-title"><span className="spinner" aria-hidden="true" /> Permissão necessária: <strong>{prompt.tool}</strong></div>
      {prompt.summary && <pre className="permission-summary">{prompt.summary}</pre>}
      <div className="question-options">
        <button ref={first} className="option" onClick={() => onAnswer('allow')}>Permitir</button>
        {prompt.hasAlways && <button className="option" onClick={() => onAnswer('allow_always')}>Permitir sempre</button>}
        <button className="option deny" onClick={() => onAnswer('deny')}>Negar</button>
      </div>
      {more > 0 && <div className="question-hint">+{more} {more === 1 ? 'pedido' : 'pedidos'} na fila.</div>}
    </div>
  );
}
```

`webview/graph.ts` — importe `PermissionPrompt` do schema (`import type { NodeStatus, PermissionPrompt, Question } from '../src/core/schema';`), em `ChatNodeData` acrescente:

```ts
  /** pedido de permissão mais antigo ainda pendente (o card mostra um por vez) */
  permission?: PermissionPrompt;
  permissionCount?: number;
```

e em `data` do node de chat, depois da linha de `question`:

```ts
            ...(n.permissions?.length ? { permission: n.permissions[0], permissionCount: n.permissions.length } : {}),
```

`webview/chat-context.ts` — em `ChatCtx` acrescente `onPermission(runId: string, requestId: string, decision: 'allow' | 'allow_always' | 'deny'): void;` e no default do `createContext` acrescente `onPermission: noop,`.

`webview/App.tsx` — em `chatCtx`, depois de `onSend`:

```ts
      onPermission: (runId, requestId, decision) => send({ type: 'permission', runId, requestId, decision }),
```

`webview/ChatCard.tsx` — `import { PermissionCard } from './PermissionCard';` e, logo após a linha do `QuestionCard`:

```tsx
        {d.permission && (
          <PermissionCard prompt={d.permission} more={(d.permissionCount ?? 1) - 1} onAnswer={(choice) => ctx.onPermission(d.runId, d.permission!.requestId, choice)} />
        )}
```

`webview/styles.css` — acrescente:

```css
.permission-card { border: 1px solid var(--waiting); border-left-width: 4px; border-radius: 6px; padding: 10px 12px; background: var(--card); }
.permission-summary { margin: 6px 0; padding: 6px 8px; max-height: 140px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 4px; background: var(--vscode-textCodeBlock-background, #8882); font-family: var(--vscode-editor-font-family, monospace); font-size: .9em; user-select: text; }
.permission-card .question-options button.option.deny:hover:not(:disabled) { background: var(--error); color: #fff; }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tudo PASS.

- [ ] **Step 5: Commit**

```bash
git add webview tests/webview
git commit -m "feat: card de permissão no chat (permitir, permitir sempre, negar)"
```

---

### Task 7: Verificação no `claude` real e documentação

**Files:**
- Modify: `scripts/e2e-turns.ts` (só se ele depender do prompt nos args; ver Step 1), `README.md` (seção de permissões, se existir)

- [ ] **Step 1: Conferir os scripts e o README**

Run: `grep -n "args\|prompt\|permission" scripts/e2e-turns.ts | head -20; grep -n -i "permiss" README.md | head`
Expected: nenhum ponto do script monta args do Claude à mão (ele usa `RunController`). Se montar, troque pelo `input` como na Task 5.

- [ ] **Step 2: Build e janela de teste**

```bash
npm run build --silent && pkill -f visor-dev-user; sleep 2
nohup "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --new-window --user-data-dir /tmp/visor-dev-user --extensionDevelopmentPath="$PWD" "$PWD/fixtures/project" >/tmp/visor-dev.log 2>&1 &
```

- [ ] **Step 2b: Roteiro manual (na janela aberta)**

1. Novo chat com permissões **Padrão**: "Rode o comando: touch /tmp/visor-perm.txt". Esperado: aparece o card "Permissão necessária: Bash" com o comando. Clique **Permitir** → o arquivo existe (`ls /tmp/visor-perm.txt`) e o chat termina.
2. Repita com `touch /tmp/visor-perm2.txt` e clique **Negar** → o arquivo **não** existe e o Claude relata a negação.
3. Repita com `touch /tmp/visor-perm3.txt` e clique **Permitir sempre** → roda; peça de novo o mesmo comando em outra mensagem: não deve perguntar.
4. Peça algo que dispare dois pedidos e **Cancele** no meio: o card some e o chat termina como cancelado.
5. No terminal: `claude` → `/resume` mostra a sessão com origem do VS Code (não `sdk-cli`).
6. Chat com permissões **Bypass**: nenhum card aparece.

Anote qualquer divergência; se houver, abra um chat de correção em vez de ajustar às cegas.

- [ ] **Step 3: Suíte completa**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tudo PASS.

- [ ] **Step 4: Commit**

```bash
git add -A docs README.md scripts
git commit -m "docs: roteiro de verificação das permissões interativas"
```
