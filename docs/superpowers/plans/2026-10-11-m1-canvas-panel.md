# M1 — Extensão com canvas de uma execução pelo painel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensão do VS Code que abre um painel (aba do editor), recebe um prompt, roda o `claude` headless e mostra o grafo de agentes em tempo real, com cancelamento, permissões configuráveis e detecção do CLI.

**Architecture:** A lógica fica em módulos puros testáveis com vitest (`RunController`, layout, snapshot, protocolo, reducer da UI). A camada que importa `vscode` é fina (`extension.ts`) e a verificação dela é um smoke manual (F5). O host mantém o `RunStore` do M0 e envia **snapshots completos** do grafo à Webview, com throttle de 50 ms. A Webview renderiza com React + `@xyflow/react` e posiciona os nodes com um layout em árvore calculado por código próprio.

**Tech Stack:** TypeScript, esbuild (dois bundles), React 18, `@xyflow/react`, `@types/vscode`, vitest. Reaproveita `src/core` e `src/cli` do M0.

**Spec:** `spec-harness-multiagentes-v0.4.md` (seções 3, 4, 6 [RF-01, 02, 05–07, 09, 10, 14], 7, 7.1, 12, 13, 14/M1)

## Global Constraints

- Nunca ler `~/.claude/.credentials.json`, Keychain ou qualquer armazenamento de token (spec §3.1).
- Nunca abrir arquivos de transcript em `~/.claude` (spec §5).
- Autenticação detectada só pela saída/erro do próprio CLI; a extensão **não** faz login (spec §3.5, §7). Da saída de `claude auth status` só se usam `loggedIn` e `authMethod`; o resto (inclusive e-mail) é descartado e nunca registrado nem enviado à Webview.
- A UI informa qual método de autenticação está em uso (spec §3.7).
- Comando "Abrir canvas de agentes" abre o painel como **aba do editor**, não sidebar (RF-01).
- O workspace aberto é o `cwd` do run (RF-02).
- Estados de node: `pending | running | done | error | cancelled`; a aresta é derivada de `parentId` (spec §11).
- Cancelar encerra a árvore de processos e marca nodes em andamento como `cancelled` (RF-09).
- Permissões do modo painel: `acceptEdits` por padrão; `bypassPermissions` nunca é padrão e exige confirmação modal a cada execução (spec §7.1).
- Mensagens vindas da Webview são não confiáveis: validar forma e tamanho antes de usar.
- A Webview roda com CSP restritiva: sem `unsafe-eval`, scripts só com nonce.
- Dependência de runtime só as já listadas; nenhuma chamada de rede da extensão.
- `package.json` tem `"type": "module"`, então o bundle da extensão se chama `dist/extension.cjs`.
- Plataformas: macOS e Linux verificados; no Windows só `claude.exe` (instalador nativo) é suportado em M1, `.cmd` não (ver Task 2). Windows não é verificável nesta máquina.
- Licença MIT; textos de UI em português.

## Review Focus

1. Duplo clique em "Executar" ou segundo `start` enquanto um run está ativo: nunca spawna dois processos.
2. Fechar o painel com um run em andamento, reabrir depois: o canvas mostra o estado atual (snapshot reenviado no `ready`), o run segue e `deactivate` o cancela.
3. Prompt vazio, só espaços, gigante (> 100 000 caracteres) ou mensagem de forma inesperada vinda da Webview: ignorado sem lançar.
4. Pasta não aberta no VS Code, CLI ausente, CLI não autenticado, CLI sem `auth status`: mensagem clara em português, nenhum processo de run spawnado (exceto no caso "desconhecido", que segue com aviso).
5. Rajada de milhares de eventos: a Webview recebe poucos snapshots (throttle), não um por evento.
6. `bypassPermissions` configurado: sem confirmação do usuário nenhum run começa.

---

## File Structure

```
package.json                  # vira o manifest da extensão (+ scripts build/watch)
esbuild.mjs                   # dois bundles: dist/extension.cjs e dist/webview.js(+.css)
tsconfig.json                 # + jsx, lib DOM
.vscode/launch.json           # F5: Extension Development Host
.vscodeignore
scripts/sanitize-fixtures.ts  # remove dados pessoais das fixtures
docs/release-checklist.md     # itens do gate de release já conhecidos
docs/m1-smoke.md              # roteiro de verificação manual
src/cli/detect.ts             # detectClaude + execText
src/ext/settings.ts           # parseSettings (puro)
src/core/layout.ts            # layoutTree (puro)
src/core/snapshot.ts          # toRunView (puro)
src/protocol.ts               # mensagens host <-> webview + parseWebviewMessage
src/ext/run-controller.ts     # RunController (puro, sem import de vscode)
src/ext/html.ts               # buildWebviewHtml + makeNonce
src/ext/extension.ts          # activate/deactivate (único arquivo que importa vscode)
webview/index.tsx, App.tsx, Toolbar.tsx, Banner.tsx, GraphView.tsx, AgentNodeCard.tsx
webview/state.ts              # reducer da UI (puro)
webview/graph.ts              # toFlow: RunView -> nodes/edges do React Flow (puro)
webview/format.ts             # formatDuration, statusLabel (puro)
webview/styles.css, webview/globals.d.ts
tests/...                     # um arquivo por módulo puro
```

---

### Task 1: Sanitizar as fixtures

**Files:**
- Create: `scripts/sanitize-fixtures.ts`, `tests/fixtures-clean.test.ts`, `docs/release-checklist.md`
- Modify: `fixtures/stream/*.ndjson`, `fixtures/hooks/*.ndjson`, `docs/superpowers/plans/2026-10-11-m0-event-capture.md` (caminho absoluto na linha **Spec**)

**Interfaces:**
- Produces: `function sanitizeValue(value: unknown, ctx: SanitizeContext): unknown`, `function makeContext(): SanitizeContext`; as fixtures continuam passando em `tests/fixtures-replay.test.ts`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/fixtures-clean.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = ['fixtures/stream', 'fixtures/hooks'];
const files = dirs.flatMap((d) =>
  readdirSync(d).filter((f) => f.endsWith('.ndjson')).map((f) => path.join(d, f)),
);

describe('fixtures não contêm dados pessoais', () => {
  it('há fixtures para verificar', () => expect(files.length).toBeGreaterThan(0));

  for (const f of files) {
    it(`${f}`, () => {
      const text = readFileSync(f, 'utf8');
      const user = os.userInfo().username;
      if (user.length > 3) expect(text).not.toContain(user);
      expect(text).not.toContain(os.homedir());
      expect(text).not.toMatch(/\/Users\/(?!user\b)[^/"\\]+/);
      expect(text).not.toMatch(/\/home\/(?!user\b)[^/"\\]+/);
      const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
      expect(emails.filter((e) => e !== 'user@example.com')).toEqual([]);
      expect(text).not.toMatch(/claude-\d{3,}/);
      for (const key of ['rate_limit_info', '"plugins"', '"mcp_servers"', '"slash_commands"', '"skills"', '"memory_paths"', '"messaging_socket_path"']) {
        expect(text).not.toContain(key);
      }
    });
  }
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/fixtures-clean.test.ts`
Expected: FAIL em todas as fixtures (caminho do usuário, `rate_limit_info` etc.).

- [ ] **Step 3: Implementar `scripts/sanitize-fixtures.ts`**

O nome de usuário e o `homedir` vêm do sistema em tempo de execução, para não gravá-los no código.
```ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DROP_KEYS = new Set([
  'rate_limit_info', 'plugins', 'mcp_servers', 'slash_commands', 'terminal_slash_commands',
  'skills', 'agents', 'memory_paths', 'messaging_socket_path', 'apiKeySource',
  'session_crons', 'background_tasks',
]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export interface SanitizeContext {
  home: string;
  user: string;
  uuids: Map<string, string>;
}

export function makeContext(): SanitizeContext {
  return { home: os.homedir(), user: os.userInfo().username, uuids: new Map() };
}

function sanitizeString(s: string, ctx: SanitizeContext): string {
  let out = s;
  const enc = (p: string) => p.replace(/\//g, '-');
  out = out.split(enc(ctx.home) + '-').join('-home-user-'); // diretórios de projeto codificados
  out = out.split(ctx.home).join('/home/user');
  out = out.replace(/\/private\/tmp\/claude-\d+/g, '/tmp/claude-test').replace(/claude-\d{3,}/g, 'claude-test');
  if (ctx.user.length > 3) out = out.split(ctx.user).join('user');
  out = out.replace(EMAIL, 'user@example.com');
  out = out.replace(UUID, (m) => {
    const key = m.toLowerCase();
    let v = ctx.uuids.get(key);
    if (!v) {
      v = `00000000-0000-4000-8000-${String(ctx.uuids.size + 1).padStart(12, '0')}`;
      ctx.uuids.set(key, v);
    }
    return v;
  });
  return out;
}

export function sanitizeValue(value: unknown, ctx: SanitizeContext): unknown {
  if (typeof value === 'string') return sanitizeString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      out[k] = sanitizeValue(v, ctx);
    }
    return out;
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = makeContext();
  for (const dir of ['fixtures/stream', 'fixtures/hooks']) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ndjson'))) {
      const file = path.join(dir, f);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const out = lines.map((l) => JSON.stringify(sanitizeValue(JSON.parse(l), ctx)));
      writeFileSync(file, out.join('\n') + '\n');
      console.log(`sanitizado: ${file} (${lines.length} linhas)`);
    }
  }
}
```

- [ ] **Step 4: Rodar o script e os testes**

```bash
npx tsx scripts/sanitize-fixtures.ts
npm test
```
Expected: todas as fixtures sanitizadas; `fixtures-clean` e `fixtures-replay` passam (suíte inteira verde). Se o replay falhar, algum id usado pelos adapters foi alterado: ajuste `DROP_KEYS`/regex sem tocar em `toolu_*` nem `agent_id`.

- [ ] **Step 5: Teste unitário do script (idempotência e mapeamento de UUID)**

Acrescentar a `tests/fixtures-clean.test.ts`:
```ts
import { sanitizeValue, makeContext } from '../scripts/sanitize-fixtures';

describe('sanitizeValue', () => {
  it('mapeia o mesmo UUID para o mesmo valor falso e é idempotente', () => {
    const ctx = makeContext();
    const id = '492d6a59-284f-440e-8984-5c4c9bdbc932';
    const once = sanitizeValue({ a: id, b: [id], rate_limit_info: { x: 1 } }, ctx) as any;
    expect(once.a).toBe(once.b[0]);
    expect(once.a).not.toBe(id);
    expect('rate_limit_info' in once).toBe(false);
    expect(sanitizeValue(once, makeContext())).toEqual(once);
  });

  it('troca e-mail e caminho do usuário', () => {
    const ctx = makeContext();
    const out = sanitizeValue({ m: `x@y.com ${os.homedir()}/p` }, ctx) as any;
    expect(out.m).toBe('user@example.com /home/user/p');
  });
});
```
Run: `npx vitest run tests/fixtures-clean.test.ts`
Expected: PASS.

- [ ] **Step 6: Sanitizar o caminho absoluto no plano do M0 e criar o checklist de release**

Em `docs/superpowers/plans/2026-10-11-m0-event-capture.md`, trocar a linha `**Spec:** \`/Users/.../spec-harness-multiagentes-v0.4.md\`` (ou v0.3) por `**Spec:** \`spec-harness-multiagentes-v0.4.md\``. Conferir com `grep -rn "$HOME" docs spec-*.md` que nada restou.

`docs/release-checklist.md`:
```markdown
# Checklist do gate de release (spec §3)

- [ ] Termos da Anthropic revisados; confirmação por escrito, se possível.
- [ ] Licença MIT presente e README com declaração de compliance (spec §3).
- [ ] **Histórico git:** os primeiros commits contêm fixtures com dados pessoais (caminho do usuário, e-mail, ids de sessão). Antes de publicar, recriar o repositório a partir do estado atual (sem histórico) ou reescrever o histórico.
- [ ] `grep -rn` por e-mail, nome de usuário e caminhos absolutos em todo o repositório.
- [ ] Faixa de versões do CLI testadas documentada (hoje: 2.1.267).
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: sanitiza fixtures e adiciona checklist de release"
```

---

### Task 2: Detecção do CLI

**Files:**
- Create: `src/cli/detect.ts`
- Test: `tests/cli/detect.test.ts`

**Interfaces:**
- Produces:
  - `type CliCheck = { state: 'ok'; version: string; authMethod: string } | { state: 'not_installed'; message: string } | { state: 'not_authenticated'; version: string; message: string } | { state: 'unknown'; version: string; message: string }`
  - `interface ExecResult { code: number | null; stdout: string; stderr: string; spawnError?: string }`
  - `type ExecFn = (command: string, args: string[]) => Promise<ExecResult>`
  - `function detectClaude(exec: ExecFn, command?: string): Promise<CliCheck>` (padrão `'claude'`)
  - `const execText: ExecFn` (implementação real, timeout 10 s)

**Nota Windows:** `execFile` não executa `claude.cmd` (erro `EINVAL`). Em M1 isso cai em `not_installed` e a mensagem orienta a usar o instalador nativo (`claude.exe`) ou configurar `visor.claudePath`.

- [ ] **Step 1: Escrever os testes que falham**

`tests/cli/detect.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { detectClaude, execText, type ExecFn } from '../../src/cli/detect';

const fake = (version: ExecResultLike, auth: ExecResultLike): ExecFn => async (_c, args) =>
  args[0] === '--version' ? version : auth;
type ExecResultLike = { code: number | null; stdout: string; stderr: string; spawnError?: string };
const ok = (stdout: string, code = 0): ExecResultLike => ({ code, stdout, stderr: '' });

describe('detectClaude', () => {
  it('CLI ausente (spawnError) vira not_installed com instrução', async () => {
    const r = await detectClaude(fake({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }, ok('')));
    expect(r.state).toBe('not_installed');
    expect((r as any).message).toMatch(/Instale/);
    expect((r as any).message).toMatch(/visor\.claudePath/);
  });

  it('logado vira ok com versão e método, sem vazar o e-mail', async () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.com', configDirectory: '/x' });
    const r = await detectClaude(fake(ok('2.1.267 (Claude Code)\n'), ok(out)));
    expect(r).toEqual({ state: 'ok', version: '2.1.267', authMethod: 'claude.ai' });
    expect(JSON.stringify(r)).not.toContain('a@b.com');
  });

  it('não logado vira not_authenticated (mesmo com exit code diferente de zero)', async () => {
    const r = await detectClaude(fake(ok('2.1.267 (Claude Code)'), ok('{"loggedIn":false}', 1)));
    expect(r.state).toBe('not_authenticated');
    expect((r as any).message).toMatch(/faça login/);
  });

  it('saída sem JSON (CLI sem auth status) vira unknown', async () => {
    const r = await detectClaude(fake(ok('1.0.0'), ok('error: unknown command', 1)));
    expect(r).toMatchObject({ state: 'unknown', version: '1.0.0' });
  });

  it('JSON sem loggedIn booleano vira unknown', async () => {
    const r = await detectClaude(fake(ok('1.0.0'), ok('{"loggedIn":"yes"}')));
    expect(r.state).toBe('unknown');
  });

  it('authMethod ausente vira "desconhecido"', async () => {
    const r = await detectClaude(fake(ok('1.0.0'), ok('{"loggedIn":true}')));
    expect(r).toMatchObject({ state: 'ok', authMethod: 'desconhecido' });
  });
});

describe('execText (processo real)', () => {
  it('comando inexistente retorna spawnError', async () => {
    const r = await execText('visor-cli-que-nao-existe', ['--version']);
    expect(r.spawnError).toBeTruthy();
  });

  it('captura stdout e exit code de um processo real', async () => {
    const r = await execText(process.execPath, ['-e', 'console.log("oi"); process.exit(3)']);
    expect(r).toMatchObject({ code: 3, stdout: 'oi\n' });
  });

  it('detectClaude contra um binário que não é o claude resulta em unknown, não em exceção', async () => {
    const r = await detectClaude(execText, process.execPath);
    expect(r.state).toBe('unknown');
    expect((r as any).version).toMatch(/^v\d+/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/cli/detect.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/cli/detect.ts`**

```ts
import { execFile } from 'node:child_process';

export type CliCheck =
  | { state: 'ok'; version: string; authMethod: string }
  | { state: 'not_installed'; message: string }
  | { state: 'not_authenticated'; version: string; message: string }
  | { state: 'unknown'; version: string; message: string };

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}
export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

export const execText: ExecFn = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code === 'string' && code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return resolve({ code: null, stdout: '', stderr: '', spawnError: err.message });
      }
      resolve({ code: typeof code === 'number' ? code : null, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export async function detectClaude(exec: ExecFn, command = 'claude'): Promise<CliCheck> {
  const v = await exec(command, ['--version']);
  if (v.spawnError) {
    return {
      state: 'not_installed',
      message:
        `Não encontrei o CLI "${command}". Instale o Claude Code (no Windows, use o instalador nativo) ` +
        'e rode `claude` no terminal para fazer login, ou configure `visor.claudePath`.',
    };
  }
  const version = v.stdout.trim().split(/\s+/)[0] ?? '';

  const a = await exec(command, ['auth', 'status', '--json']);
  let parsed: any;
  try {
    parsed = JSON.parse(a.stdout);
  } catch {
    parsed = undefined;
  }
  // Só loggedIn e authMethod são lidos; o resto da saída (inclusive e-mail) é descartado.
  if (parsed?.loggedIn === true) {
    return { state: 'ok', version, authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : 'desconhecido' };
  }
  if (parsed?.loggedIn === false) {
    return {
      state: 'not_authenticated',
      version,
      message: 'O CLI não está autenticado. Rode `claude` no terminal e faça login; a extensão não faz login por você.',
    };
  }
  return {
    state: 'unknown',
    version,
    message: 'Não consegui confirmar a autenticação (esta versão do CLI pode não ter `auth status`). Vou tentar executar mesmo assim.',
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/cli/detect.test.ts && npm run typecheck`
Expected: 9 testes passam.

- [ ] **Step 5: Conferir contra o CLI real (somente leitura)**

```bash
npx tsx -e "import('./src/cli/detect').then(async m => console.log(await m.detectClaude(m.execText)))"
```
Expected: `{ state: 'ok', version: '2.1.267', authMethod: '...' }` e **nenhum e-mail** na saída.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): detecção do CLI e da autenticação pela saída do próprio claude"
```

---

### Task 3: Settings (puro)

**Files:**
- Create: `src/ext/settings.ts`
- Test: `tests/ext/settings.test.ts`

**Interfaces:**
- Produces:
  - `const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const`
  - `type PermissionMode = typeof PERMISSION_MODES[number]`
  - `interface VisorSettings { claudePath: string; permissionMode: PermissionMode; allowedTools: string[]; disallowedTools: string[] }`
  - `const DEFAULT_SETTINGS: VisorSettings`
  - `function parseSettings(get: (key: string) => unknown): VisorSettings` (chaves sem o prefixo `visor.`)

- [ ] **Step 1: Escrever os testes que falham**

`tests/ext/settings.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseSettings, DEFAULT_SETTINGS, PERMISSION_MODES } from '../../src/ext/settings';

const from = (o: Record<string, unknown>) => parseSettings((k) => o[k]);

describe('parseSettings', () => {
  it('sem nada configurado devolve os padrões conservadores', () => {
    expect(from({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ claudePath: 'claude', permissionMode: 'acceptEdits', allowedTools: [], disallowedTools: [] });
  });

  it('aceita valores válidos', () => {
    expect(from({ claudePath: '/opt/claude', permissionMode: 'plan', allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: ['WebFetch'] }))
      .toEqual({ claudePath: '/opt/claude', permissionMode: 'plan', allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: ['WebFetch'] });
  });

  it('modo inválido volta ao padrão, nunca vira bypass por acidente', () => {
    expect(from({ permissionMode: 'bypass' }).permissionMode).toBe('acceptEdits');
    expect(from({ permissionMode: 42 }).permissionMode).toBe('acceptEdits');
  });

  it('claudePath vazio ou não-string volta ao padrão', () => {
    expect(from({ claudePath: '   ' }).claudePath).toBe('claude');
    expect(from({ claudePath: 3 }).claudePath).toBe('claude');
  });

  it('listas descartam itens que não são strings não vazias', () => {
    expect(from({ allowedTools: ['Read', '', 5, null, ' Edit '] }).allowedTools).toEqual(['Read', 'Edit']);
    expect(from({ allowedTools: 'Read' }).allowedTools).toEqual([]);
  });

  it('PERMISSION_MODES cobre os modos do CLI 2.1.267', () => {
    expect([...PERMISSION_MODES].sort()).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'manual', 'plan']);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/settings.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/ext/settings.ts`**

```ts
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface VisorSettings {
  claudePath: string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
}

export const DEFAULT_SETTINGS: VisorSettings = {
  claudePath: 'claude',
  permissionMode: 'acceptEdits',
  allowedTools: [],
  disallowedTools: [],
};

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];

export function parseSettings(get: (key: string) => unknown): VisorSettings {
  const path = get('claudePath');
  const mode = get('permissionMode');
  return {
    claudePath: typeof path === 'string' && path.trim() ? path.trim() : DEFAULT_SETTINGS.claudePath,
    permissionMode: (PERMISSION_MODES as readonly unknown[]).includes(mode) ? (mode as PermissionMode) : DEFAULT_SETTINGS.permissionMode,
    allowedTools: list(get('allowedTools')),
    disallowedTools: list(get('disallowedTools')),
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/ext/settings.test.ts && npm run typecheck`
Expected: 6 testes passam.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ext): parse das settings com padrões conservadores"
```

---

### Task 4: Layout em árvore

**Files:**
- Create: `src/core/layout.ts`
- Test: `tests/core/layout.test.ts`

**Interfaces:**
- Produces:
  - `interface LayoutInput { id: string; parentId: string | null }`
  - `interface LayoutOptions { hGap?: number; vGap?: number }` (padrão 220 e 120)
  - `function layoutTree(nodes: LayoutInput[], opts?: LayoutOptions): Map<string, { x: number; y: number }>`

- [ ] **Step 1: Escrever os testes que falham**

`tests/core/layout.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { layoutTree } from '../../src/core/layout';

const n = (id: string, parentId: string | null = null) => ({ id, parentId });

describe('layoutTree', () => {
  it('um node fica na origem', () => {
    expect(layoutTree([n('r')]).get('r')).toEqual({ x: 0, y: 0 });
  });

  it('raiz centralizada sobre dois filhos', () => {
    const p = layoutTree([n('r'), n('a', 'r'), n('b', 'r')]);
    expect(p.get('a')).toEqual({ x: 0, y: 120 });
    expect(p.get('b')).toEqual({ x: 220, y: 120 });
    expect(p.get('r')).toEqual({ x: 110, y: 0 });
  });

  it('filhos em paralelo mantêm a ordem de inserção', () => {
    const p = layoutTree([n('r'), n('c', 'r'), n('a', 'r'), n('b', 'r')]);
    expect(['c', 'a', 'b'].map((id) => p.get(id)!.x)).toEqual([0, 220, 440]);
  });

  it('cadeia cresce para baixo no mesmo x', () => {
    const p = layoutTree([n('r'), n('a', 'r'), n('b', 'a')]);
    expect([p.get('r'), p.get('a'), p.get('b')]).toEqual([{ x: 0, y: 0 }, { x: 0, y: 120 }, { x: 0, y: 240 }]);
  });

  it('respeita hGap e vGap', () => {
    const p = layoutTree([n('r'), n('a', 'r'), n('b', 'r')], { hGap: 100, vGap: 50 });
    expect(p.get('b')).toEqual({ x: 100, y: 50 });
  });

  it('pai desconhecido vira raiz em vez de sumir', () => {
    const p = layoutTree([n('r'), n('x', 'nao-existe')]);
    expect(p.has('x')).toBe(true);
    expect(p.get('x')!.y).toBe(0);
  });

  it('ciclo e auto-referência não travam e posicionam todos', () => {
    const p = layoutTree([n('a', 'b'), n('b', 'a'), n('s', 's')]);
    expect(p.size).toBe(3);
  });

  it('lista vazia devolve mapa vazio', () => {
    expect(layoutTree([]).size).toBe(0);
  });

  it('100 filhos em paralelo: o último fica em 99 * hGap e a raiz no meio', () => {
    const nodes = [n('r'), ...Array.from({ length: 100 }, (_, i) => n(`c${i}`, 'r'))];
    const p = layoutTree(nodes);
    expect(p.get('c99')!.x).toBe(99 * 220);
    expect(p.get('r')!.x).toBe((99 * 220) / 2);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/core/layout.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/core/layout.ts`**

```ts
export interface LayoutInput {
  id: string;
  parentId: string | null;
}
export interface LayoutOptions {
  hGap?: number;
  vGap?: number;
}

export function layoutTree(nodes: LayoutInput[], opts: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const hGap = opts.hGap ?? 220;
  const vGap = opts.vGap ?? 120;
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];

  for (const n of nodes) {
    if (n.parentId && n.parentId !== n.id && ids.has(n.parentId)) {
      const list = children.get(n.parentId) ?? [];
      list.push(n.id);
      children.set(n.parentId, list);
    } else {
      roots.push(n.id);
    }
  }

  const pos = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  let nextLeaf = 0;

  const place = (id: string, depth: number): number => {
    visited.add(id);
    const kids = (children.get(id) ?? []).filter((k) => !visited.has(k));
    let x: number;
    if (kids.length === 0) {
      x = nextLeaf * hGap;
      nextLeaf += 1;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    pos.set(id, { x, y: depth * vGap });
    return x;
  };

  for (const r of roots) if (!visited.has(r)) place(r, 0);
  // Ciclos sem raiz: posiciona o que sobrou.
  for (const n of nodes) if (!visited.has(n.id)) place(n.id, 0);
  return pos;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/core/layout.test.ts && npm run typecheck`
Expected: 9 testes passam.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): layout em árvore sem dependências"
```

---

### Task 5: Snapshot e protocolo host ↔ Webview

**Files:**
- Create: `src/core/snapshot.ts`, `src/protocol.ts`
- Test: `tests/core/snapshot.test.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `RunStore` (M0), `CliCheck` (Task 2), `NodeStatus` (M0).
- Produces:
  - `interface NodeView { id: string; parentId: string | null; agentType: string; status: NodeStatus; startedAt?: number; endedAt?: number; eventCount: number }`
  - `interface RunView { id: string; status: NodeStatus; startedAt: number; endedAt?: number; nodes: NodeView[]; edges: { from: string; to: string }[] }`
  - `function toRunView(store: RunStore): RunView`
  - `type HostMessage = { type: 'snapshot'; run: RunView | null } | { type: 'cli'; check: CliCheck } | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }`
  - `type WebviewMessage = { type: 'ready' } | { type: 'start'; prompt: string } | { type: 'cancel' }`
  - `const MAX_PROMPT_CHARS = 100_000`
  - `function parseWebviewMessage(raw: unknown): WebviewMessage | null`

- [ ] **Step 1: Escrever os testes que falham**

`tests/core/snapshot.test.ts`:
```ts
import { it, expect } from 'vitest';
import { RunStore } from '../../src/core/store';
import { toRunView } from '../../src/core/snapshot';

it('converte o store em dados simples, sem eventos nem payloads', () => {
  const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
  s.apply({ type: 'run_started', runId: 'r1', sessionId: 's', ts: 1 });
  s.apply({ type: 'node_started', runId: 'r1', nodeId: 'r1:t1', parentId: 'r1:root', agentType: 'echo', invocationId: 't1', ts: 2 });
  s.apply({ type: 'node_event', runId: 'r1', nodeId: 'r1:t1', kind: 'message', payload: 'segredo', ts: 3 });
  const v = toRunView(s);
  expect(v).toMatchObject({ id: 'r1', status: 'running', startedAt: 1 });
  expect(v.nodes.map((n) => [n.id, n.parentId, n.agentType, n.status, n.eventCount])).toEqual([
    ['r1:root', null, 'root', 'running', 0],
    ['r1:t1', 'r1:root', 'echo', 'running', 1],
  ]);
  expect(v.edges).toEqual([{ from: 'r1:root', to: 'r1:t1' }]);
  expect(JSON.stringify(v)).not.toContain('segredo');
  expect(() => structuredClone(v)).not.toThrow();
});

it('store ainda sem run_started tem zero nodes e status pending', () => {
  const v = toRunView(new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' }));
  expect(v.nodes).toEqual([]);
  expect(v.status).toBe('pending');
});
```

`tests/protocol.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseWebviewMessage, MAX_PROMPT_CHARS } from '../../src/protocol';

describe('parseWebviewMessage', () => {
  it('aceita ready, cancel e start válido', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'cancel' })).toEqual({ type: 'cancel' });
    expect(parseWebviewMessage({ type: 'start', prompt: 'faça X' })).toEqual({ type: 'start', prompt: 'faça X' });
  });

  it('descarta campos extras', () => {
    expect(parseWebviewMessage({ type: 'cancel', evil: 1 })).toEqual({ type: 'cancel' });
  });

  it('rejeita prompt vazio, só espaços, não-string e gigante', () => {
    for (const prompt of ['', '   \n', 5, null, undefined, 'x'.repeat(MAX_PROMPT_CHARS + 1)]) {
      expect(parseWebviewMessage({ type: 'start', prompt })).toBeNull();
    }
    expect(parseWebviewMessage({ type: 'start', prompt: 'x'.repeat(MAX_PROMPT_CHARS) })).not.toBeNull();
  });

  it('rejeita tipos desconhecidos e formas inesperadas sem lançar', () => {
    for (const raw of [null, undefined, 3, 'start', [], {}, { type: 7 }, { type: 'rm -rf' }]) {
      expect(parseWebviewMessage(raw)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/core/snapshot.test.ts tests/protocol.test.ts`
Expected: FAIL (módulos não existem).

- [ ] **Step 3: Implementar `src/protocol.ts`**

```ts
import type { NodeStatus } from './core/schema';
import type { CliCheck } from './cli/detect';

export interface NodeView {
  id: string;
  parentId: string | null;
  agentType: string;
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
}

export interface RunView {
  id: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
  nodes: NodeView[];
  edges: { from: string; to: string }[];
}

export type HostMessage =
  | { type: 'snapshot'; run: RunView | null }
  | { type: 'cli'; check: CliCheck }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export type WebviewMessage = { type: 'ready' } | { type: 'start'; prompt: string } | { type: 'cancel' };

export const MAX_PROMPT_CHARS = 100_000;

export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'cancel':
      return { type: 'cancel' };
    case 'start':
      if (typeof m.prompt !== 'string' || !m.prompt.trim() || m.prompt.length > MAX_PROMPT_CHARS) return null;
      return { type: 'start', prompt: m.prompt };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Implementar `src/core/snapshot.ts`**

```ts
import type { RunView } from '../protocol';
import type { RunStore } from './store';

export function toRunView(store: RunStore): RunView {
  return {
    id: store.run.id,
    status: store.run.status,
    startedAt: store.run.startedAt,
    endedAt: store.run.endedAt,
    nodes: [...store.nodes.values()].map((n) => ({
      id: n.id,
      parentId: n.parentId,
      agentType: n.agentType,
      status: n.status,
      startedAt: n.startedAt,
      endedAt: n.endedAt,
      eventCount: n.eventCount,
    })),
    edges: store.edges(),
  };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/core/snapshot.test.ts tests/protocol.test.ts && npm run typecheck`
Expected: 6 testes passam.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: snapshot do grafo e protocolo host-webview validado"
```

---

### Task 6: RunController

**Files:**
- Create: `src/ext/run-controller.ts`
- Test: `tests/ext/run-controller.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `NormalizedEvent` (M0); `startProcessRun`, `ProcessRun`, `ProcessRunOptions`, `ProcessRunResult` (M0); `buildClaudeArgs` (M0); `CliCheck` (Task 2); `VisorSettings` (Task 3); `toRunView` e protocolo (Task 5).
- Produces:
  ```ts
  interface ControllerDeps {
    post(msg: HostMessage): void;
    cwd(): string | undefined;
    settings(): VisorSettings;
    detect(command: string): Promise<CliCheck>;
    confirmBypass(): Promise<boolean>;
    startRun(runId: string, opts: ProcessRunOptions, onEvent: (e: NormalizedEvent) => void): ProcessRun;
    flushMs?: number;       // padrão 50
    newRunId?(): string;    // padrão crypto.randomUUID
  }
  class RunController {
    constructor(deps: ControllerDeps);
    handle(msg: WebviewMessage): Promise<void>;
    dispose(): void;
  }
  ```
  Comportamento: um run por vez (`busy`); `ready` reenvia `cli` (se houver) e `snapshot`; `start` valida pasta → detecta CLI → confirma bypass → spawna; `unknown` segue com aviso; `not_installed`/`not_authenticated` só enviam o `cli`; snapshots com throttle; ao terminar, snapshot final e `notice` para erro/cancelamento; `dispose` cancela o run ativo.

- [ ] **Step 1: Escrever os testes que falham**

`tests/ext/run-controller.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { RunController, type ControllerDeps } from '../../src/ext/run-controller';
import { DEFAULT_SETTINGS } from '../../src/ext/settings';
import type { HostMessage } from '../../src/protocol';
import type { NormalizedEvent } from '../../src/core/schema';
import type { ProcessRun, ProcessRunResult } from '../../src/cli/process-run';
import type { CliCheck } from '../../src/cli/detect';

const OK: CliCheck = { state: 'ok', version: '2.1.267', authMethod: 'claude.ai' };
const result = (o: Partial<ProcessRunResult> = {}): ProcessRunResult => ({
  exitCode: 0, signal: null, stderrTail: '', malformedLines: 0, cancelled: false, ...o,
});

function setup(over: Partial<ControllerDeps> = {}) {
  const posted: HostMessage[] = [];
  let emit: (e: NormalizedEvent) => void = () => {};
  let finish: (r: ProcessRunResult) => void = () => {};
  const cancel = vi.fn();
  const startRun = vi.fn((_id: string, _o: unknown, on: (e: NormalizedEvent) => void): ProcessRun => {
    emit = on;
    return { cancel, done: new Promise<ProcessRunResult>((res) => (finish = res)) };
  });
  const deps: ControllerDeps = {
    post: (m) => posted.push(m),
    cwd: () => '/proj',
    settings: () => DEFAULT_SETTINGS,
    detect: async () => OK,
    confirmBypass: async () => true,
    startRun: startRun as any,
    flushMs: 5,
    newRunId: () => 'r1',
    ...over,
  };
  const c = new RunController(deps);
  const snaps = () => posted.filter((m) => m.type === 'snapshot') as Extract<HostMessage, { type: 'snapshot' }>[];
  const notices = () => posted.filter((m) => m.type === 'notice') as Extract<HostMessage, { type: 'notice' }>[];
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  return { c, posted, snaps, notices, startRun, cancel, tick, emit: (e: NormalizedEvent) => emit(e), finish: (r: ProcessRunResult) => finish(r) };
}
const init: NormalizedEvent = { type: 'run_started', runId: 'r1', sessionId: 's', ts: 1 };
const sub = (id: string): NormalizedEvent => ({ type: 'node_started', runId: 'r1', nodeId: `r1:${id}`, parentId: 'r1:root', agentType: 'echo', invocationId: id, ts: 2 });

describe('RunController', () => {
  it('sem pasta aberta avisa e não spawna', async () => {
    const t = setup({ cwd: () => undefined });
    await t.c.handle({ type: 'start', prompt: 'x' });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.notices()[0]).toMatchObject({ level: 'error' });
    expect(t.notices()[0]!.text).toMatch(/pasta/);
  });

  it.each([
    ['not_installed', { state: 'not_installed', message: 'falta' }],
    ['not_authenticated', { state: 'not_authenticated', version: '1', message: 'login' }],
  ] as const)('CLI %s envia o diagnóstico e não spawna', async (_n, check) => {
    const t = setup({ detect: async () => check as CliCheck });
    await t.c.handle({ type: 'start', prompt: 'x' });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.posted.find((m) => m.type === 'cli')).toMatchObject({ check });
  });

  it('CLI "unknown" avisa mas executa', async () => {
    const t = setup({ detect: async () => ({ state: 'unknown', version: '1', message: 'sem auth status' }) });
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    expect(t.startRun).toHaveBeenCalledTimes(1);
    t.finish(result());
    await p;
  });

  it('passa cwd, comando e argumentos de permissão ao spawn', async () => {
    const t = setup({ settings: () => ({ claudePath: '/bin/claude', permissionMode: 'plan', allowedTools: ['Read'], disallowedTools: [] }) });
    const p = t.c.handle({ type: 'start', prompt: 'olá' });
    await t.tick();
    const [runId, opts] = t.startRun.mock.calls[0] as any[];
    expect(runId).toBe('r1');
    expect(opts.command).toBe('/bin/claude');
    expect(opts.cwd).toBe('/proj');
    expect(opts.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--allowedTools', 'Read']));
    expect(opts.args.slice(-2)).toEqual(['--', 'olá']);
    t.finish(result());
    await p;
  });

  it('fluxo feliz: snapshots mostram o grafo e o final fecha em done', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.emit(init); t.emit(sub('t1'));
    await t.tick();
    expect(t.snaps().at(-1)!.run!.nodes.map((n) => n.id)).toEqual(['r1:root', 'r1:t1']);
    t.emit({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    t.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    t.finish(result());
    await p;
    expect(t.snaps().at(-1)!.run!.status).toBe('done');
    expect(t.notices()).toEqual([]);
  });

  it('rajada de 2000 eventos gera poucos snapshots (throttle)', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.emit(init);
    for (let i = 0; i < 2000; i++) t.emit({ type: 'node_event', runId: 'r1', nodeId: 'r1:root', kind: 'message', payload: i, ts: 5 });
    const before = t.snaps().length;
    await t.tick(30);
    expect(t.snaps().length - before).toBeLessThanOrEqual(2);
    t.finish(result());
    await p;
  });

  it('segundo start enquanto há run ativo avisa e não spawna de novo', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    await t.c.handle({ type: 'start', prompt: 'y' });
    expect(t.startRun).toHaveBeenCalledTimes(1);
    expect(t.notices().some((n) => n.level === 'warn')).toBe(true);
    t.finish(result());
    await p;
  });

  it('dois starts quase simultâneos (durante a detecção) também spawnam uma vez só', async () => {
    const t = setup({ detect: () => new Promise((r) => setTimeout(() => r(OK), 20)) });
    const a = t.c.handle({ type: 'start', prompt: 'x' });
    const b = t.c.handle({ type: 'start', prompt: 'y' });
    await t.tick(60);
    expect(t.startRun).toHaveBeenCalledTimes(1);
    t.finish(result());
    await Promise.all([a, b]);
  });

  it('depois que o run termina, um novo start é aceito', async () => {
    const t = setup();
    const a = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.finish(result());
    await a;
    const b = t.c.handle({ type: 'start', prompt: 'y' });
    await t.tick();
    expect(t.startRun).toHaveBeenCalledTimes(2);
    t.finish(result());
    await b;
  });

  it('cancel chama cancel do processo; cancelamento gera aviso informativo', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.emit(init);
    await t.c.handle({ type: 'cancel' });
    expect(t.cancel).toHaveBeenCalledTimes(1);
    t.emit({ type: 'run_finished', runId: 'r1', status: 'cancelled', ts: 6 });
    t.finish(result({ cancelled: true }));
    await p;
    expect(t.notices().at(-1)).toMatchObject({ level: 'info' });
    expect(t.snaps().at(-1)!.run!.status).toBe('cancelled');
  });

  it('cancel sem run ativo é inofensivo', async () => {
    const t = setup();
    await expect(t.c.handle({ type: 'cancel' })).resolves.toBeUndefined();
    expect(t.cancel).not.toHaveBeenCalled();
  });

  it('falha ao spawnar vira aviso de erro com a causa', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.emit({ type: 'run_started', runId: 'r1', ts: 1 });
    t.emit({ type: 'run_finished', runId: 'r1', status: 'error', ts: 2 });
    t.finish(result({ exitCode: null, spawnError: 'spawn claude ENOENT' }));
    await p;
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.notices().at(-1)!.text).toMatch(/ENOENT/);
  });

  it('término com erro inclui o final do stderr no aviso', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.emit(init);
    t.emit({ type: 'run_finished', runId: 'r1', status: 'error', ts: 2 });
    t.finish(result({ exitCode: 1, stderrTail: 'Permission denied for Bash' }));
    await p;
    expect(t.notices().at(-1)!.text).toMatch(/Permission denied for Bash/);
  });

  it('bypassPermissions sem confirmação não inicia run; com confirmação inicia', async () => {
    const settings = () => ({ ...DEFAULT_SETTINGS, permissionMode: 'bypassPermissions' as const });
    const no = setup({ settings, confirmBypass: async () => false });
    await no.c.handle({ type: 'start', prompt: 'x' });
    expect(no.startRun).not.toHaveBeenCalled();

    const yes = setup({ settings, confirmBypass: async () => true });
    const p = yes.c.handle({ type: 'start', prompt: 'x' });
    await yes.tick();
    expect(yes.startRun).toHaveBeenCalledTimes(1);
    yes.finish(result());
    await p;
  });

  it('ready reenvia o diagnóstico do CLI e o snapshot atual', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.emit(init); t.emit(sub('t1'));
    t.posted.length = 0;
    await t.c.handle({ type: 'ready' });
    expect(t.posted.map((m) => m.type)).toEqual(['cli', 'snapshot']);
    expect((t.posted[1] as any).run.nodes).toHaveLength(2);
    t.finish(result());
    await p;
  });

  it('ready sem run envia snapshot nulo', async () => {
    const t = setup();
    await t.c.handle({ type: 'ready' });
    expect(t.posted).toEqual([{ type: 'snapshot', run: null }]);
  });

  it('dispose cancela o run ativo e para o timer', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick();
    t.emit(init);
    t.c.dispose();
    expect(t.cancel).toHaveBeenCalledTimes(1);
    t.finish(result({ cancelled: true }));
    await p;
  });

  it('exceção em detect não deixa o controller travado', async () => {
    let first = true;
    const t = setup({ detect: async () => { if (first) { first = false; throw new Error('boom'); } return OK; } });
    await t.c.handle({ type: 'start', prompt: 'x' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    const p = t.c.handle({ type: 'start', prompt: 'y' });
    await t.tick();
    expect(t.startRun).toHaveBeenCalledTimes(1);
    t.finish(result());
    await p;
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/run-controller.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar `src/ext/run-controller.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { buildClaudeArgs } from '../cli/claude-args';
import type { CliCheck } from '../cli/detect';
import type { ProcessRun, ProcessRunOptions } from '../cli/process-run';
import type { NormalizedEvent } from '../core/schema';
import { toRunView } from '../core/snapshot';
import { RunStore } from '../core/store';
import type { HostMessage, WebviewMessage } from '../protocol';
import type { VisorSettings } from './settings';

export interface ControllerDeps {
  post(msg: HostMessage): void;
  cwd(): string | undefined;
  settings(): VisorSettings;
  detect(command: string): Promise<CliCheck>;
  confirmBypass(): Promise<boolean>;
  startRun(runId: string, opts: ProcessRunOptions, onEvent: (e: NormalizedEvent) => void): ProcessRun;
  flushMs?: number;
  newRunId?(): string;
}

export class RunController {
  private store?: RunStore;
  private active?: ProcessRun;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private lastCheck?: CliCheck;

  constructor(private readonly deps: ControllerDeps) {}

  async handle(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (this.lastCheck) this.deps.post({ type: 'cli', check: this.lastCheck });
        this.postSnapshot();
        return;
      case 'cancel':
        this.active?.cancel();
        return;
      case 'start':
        return this.start(msg.prompt);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.cancel();
  }

  private notice(level: 'info' | 'warn' | 'error', text: string): void {
    this.deps.post({ type: 'notice', level, text });
  }

  private postSnapshot(): void {
    this.deps.post({ type: 'snapshot', run: this.store ? toRunView(this.store) : null });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.postSnapshot();
    }, this.deps.flushMs ?? 50);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.postSnapshot();
  }

  private async start(prompt: string): Promise<void> {
    if (this.busy) {
      this.notice('warn', 'Já existe uma execução em andamento. Cancele-a ou espere terminar.');
      return;
    }
    this.busy = true; // marcado antes de qualquer await: bloqueia starts concorrentes
    try {
      const cwd = this.deps.cwd();
      if (!cwd) {
        this.notice('error', 'Abra uma pasta no VS Code antes de executar: o workspace é o diretório de trabalho do agente.');
        return;
      }
      const settings = this.deps.settings();

      const check = await this.deps.detect(settings.claudePath);
      this.lastCheck = check;
      this.deps.post({ type: 'cli', check });
      if (check.state === 'not_installed' || check.state === 'not_authenticated') return;

      if (settings.permissionMode === 'bypassPermissions' && !(await this.deps.confirmBypass())) {
        this.notice('info', 'Execução não iniciada: o modo bypassPermissions não foi confirmado.');
        return;
      }

      const runId = this.deps.newRunId?.() ?? randomUUID();
      const store = new RunStore({ runId, source: 'panel', cwd });
      this.store = store;
      const args = buildClaudeArgs({
        prompt,
        permissionMode: settings.permissionMode,
        allowedTools: settings.allowedTools,
        disallowedTools: settings.disallowedTools,
      });
      const run = this.deps.startRun(runId, { command: settings.claudePath, args, cwd }, (e) => {
        store.apply(e);
        this.schedule();
      });
      this.active = run;
      this.postSnapshot();

      const result = await run.done;
      this.active = undefined;
      this.flush();

      if (result.cancelled) {
        this.notice('info', 'Execução cancelada.');
      } else if (result.spawnError) {
        this.notice('error', `Não consegui executar o CLI: ${result.spawnError}`);
      } else if (store.run.status === 'error') {
        const tail = result.stderrTail.trim().slice(-500);
        this.notice('error', `A execução terminou com erro (código ${result.exitCode}).${tail ? ` ${tail}` : ''}`);
      }
    } catch (err) {
      this.active = undefined;
      this.notice('error', `Falha inesperada: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/ext/run-controller.test.ts && npm run typecheck`
Expected: 19 testes passam (incluindo os `it.each`). Se o teste de throttle for instável, aumentar o `tick` e **não** afrouxar a asserção.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ext): RunController com throttle, run único e confirmação de bypass"
```

---

### Task 7: Esqueleto da extensão (manifest, build, HTML, painel)

**Files:**
- Modify: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `esbuild.mjs`, `.vscode/launch.json`, `.vscodeignore`, `src/ext/html.ts`, `src/ext/extension.ts`, `webview/index.tsx` (placeholder mínimo), `webview/globals.d.ts`
- Test: `tests/ext/html.test.ts`

**Interfaces:**
- Consumes: `RunController`, `ControllerDeps` (Task 6); `parseSettings` (Task 3); `detectClaude`, `execText` (Task 2); `startProcessRun` (M0); `parseWebviewMessage`, `HostMessage` (Task 5).
- Produces:
  - `function makeNonce(): string`
  - `function buildWebviewHtml(o: { cspSource: string; nonce: string; scriptUri: string; styleUri: string }): string`
  - Comandos `visor.openCanvas` ("Visor: Abrir canvas de agentes") e `visor.cancelRun` ("Visor: Cancelar execução").
  - Settings `visor.claudePath`, `visor.permissionMode`, `visor.allowedTools`, `visor.disallowedTools`.
  - Bundles `dist/extension.cjs`, `dist/webview.js`, `dist/webview.css`.

- [ ] **Step 1: Instalar dependências**

```bash
npm install --save-dev esbuild @types/vscode@^1.90.0 @types/react@^18 @types/react-dom@^18
npm install --save-dev react@^18 react-dom@^18 @xyflow/react
```
(Tudo vai em devDependencies porque é empacotado pelo esbuild.)
Expected: instalação sem erros.

- [ ] **Step 2: Escrever o teste do HTML que falha**

`tests/ext/html.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildWebviewHtml, makeNonce } from '../../src/ext/html';

const html = buildWebviewHtml({ cspSource: 'vscode-webview://abc', nonce: 'N0NCE', scriptUri: 'vscode-webview://abc/dist/webview.js', styleUri: 'vscode-webview://abc/dist/webview.css' });

describe('buildWebviewHtml', () => {
  it('CSP: default-src none, script só com nonce, sem unsafe-eval', () => {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-N0NCE'");
    expect(csp).not.toContain('unsafe-eval');
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!;
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('o script carrega com o mesmo nonce e a div raiz existe', () => {
    expect(html).toContain('<script nonce="N0NCE" src="vscode-webview://abc/dist/webview.js"></script>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<link rel="stylesheet" href="vscode-webview://abc/dist/webview.css">');
  });

  it('não permite que valores injetem aspas no HTML', () => {
    const evil = buildWebviewHtml({ cspSource: 'x', nonce: 'n', scriptUri: 'a"><script>alert(1)</script>', styleUri: 's' });
    expect(evil).not.toContain('<script>alert(1)</script>');
  });
});

describe('makeNonce', () => {
  it('gera valores diferentes, só com caracteres seguros e com entropia suficiente', () => {
    const a = makeNonce(), b = makeNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/ext/html.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 4: Implementar `src/ext/html.ts`**

```ts
import { randomBytes } from 'node:crypto';

export function makeNonce(): string {
  return randomBytes(18).toString('base64url');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildWebviewHtml(o: { cspSource: string; nonce: string; scriptUri: string; styleUri: string }): string {
  const csp = [
    "default-src 'none'",
    `style-src ${o.cspSource} 'unsafe-inline'`, // React Flow aplica estilos inline
    `script-src 'nonce-${o.nonce}'`,
    `font-src ${o.cspSource}`,
    `img-src ${o.cspSource} data:`,
  ].join('; ');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${esc(o.styleUri)}">
<title>Visor — Agentes</title>
</head>
<body>
<div id="root"></div>
<script nonce="${esc(o.nonce)}" src="${esc(o.scriptUri)}"></script>
</body>
</html>`;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/ext/html.test.ts`
Expected: 4 testes passam.

- [ ] **Step 6: Manifest, tsconfig, build e launch**

`package.json` (mesclar com o existente, mantendo `devDependencies` instaladas):
```json
{
  "name": "visor",
  "displayName": "Visor — Canvas de Agentes",
  "description": "Mostra a execução de agentes do Claude Code como um grafo de nodes.",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": { "vscode": "^1.90.0", "node": ">=20" },
  "main": "./dist/extension.cjs",
  "categories": ["Other"],
  "contributes": {
    "commands": [
      { "command": "visor.openCanvas", "title": "Visor: Abrir canvas de agentes" },
      { "command": "visor.cancelRun", "title": "Visor: Cancelar execução" }
    ],
    "configuration": {
      "title": "Visor",
      "properties": {
        "visor.claudePath": { "type": "string", "default": "claude", "description": "Caminho do executável do Claude Code. No Windows, use o claude.exe do instalador nativo." },
        "visor.permissionMode": {
          "type": "string", "default": "acceptEdits",
          "enum": ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
          "markdownDescription": "Modo de permissões do `claude -p` (modo painel é headless, sem aprovação interativa). `bypassPermissions` exige confirmação a cada execução."
        },
        "visor.allowedTools": { "type": "array", "items": { "type": "string" }, "default": [], "description": "Regras de tools permitidas, ex.: Bash(npm test:*)." },
        "visor.disallowedTools": { "type": "array", "items": { "type": "string" }, "default": [], "description": "Regras de tools bloqueadas." }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests", "webview"]
}
```

`esbuild.mjs`:
```js
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info' };

const configs = [
  {
    ...common,
    entryPoints: ['src/ext/extension.ts'],
    outfile: 'dist/extension.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/index.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
  },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  for (const c of configs) await build(c);
}
```

`.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Executar extensão",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}", "${workspaceFolder}/fixtures/project"],
      "outFiles": ["${workspaceFolder}/dist/**/*.cjs"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```
(O segundo argumento abre `fixtures/project` como workspace do Extension Development Host, com o subagente `echo`.)

`.vscodeignore`:
```
src/**
tests/**
webview/**
scripts/**
docs/**
fixtures/**
node_modules/**
.superpowers/**
**/*.map
```

`.gitignore`: acrescentar `dist/`.

`webview/globals.d.ts`:
```ts
declare module '*.css';
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
```

`webview/index.tsx` (placeholder, substituído no Task 8):
```tsx
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<p>Visor carregando…</p>);
```

- [ ] **Step 7: Implementar `src/ext/extension.ts`**

```ts
import * as vscode from 'vscode';
import { detectClaude, execText } from '../cli/detect';
import { startProcessRun } from '../cli/process-run';
import { parseWebviewMessage, type HostMessage } from '../protocol';
import { buildWebviewHtml, makeNonce } from './html';
import { RunController } from './run-controller';
import { parseSettings } from './settings';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Visor');
  let panel: vscode.WebviewPanel | undefined;

  const controller = new RunController({
    post: (msg: HostMessage) => {
      void panel?.webview.postMessage(msg);
    },
    cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    settings: () => {
      const cfg = vscode.workspace.getConfiguration('visor');
      return parseSettings((key) => cfg.get(key));
    },
    detect: (command) => detectClaude(execText, command),
    confirmBypass: async () => {
      const yes = 'Executar sem pedir permissões';
      const pick = await vscode.window.showWarningMessage(
        'O modo bypassPermissions deixa o agente executar qualquer tool sem pedir aprovação. Continuar?',
        { modal: true },
        yes,
      );
      return pick === yes;
    },
    startRun: startProcessRun,
  });

  const openCanvas = () => {
    if (panel) {
      panel.reveal();
      return;
    }
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    panel = vscode.window.createWebviewPanel('visor.canvas', 'Visor — Agentes', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    const web = panel.webview;
    web.html = buildWebviewHtml({
      cspSource: web.cspSource,
      nonce: makeNonce(),
      scriptUri: web.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: web.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
    });
    web.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewMessage(raw);
      if (msg) controller.handle(msg).catch((err) => log.appendLine(String(err)));
    });
    panel.onDidDispose(() => {
      panel = undefined; // o run, se houver, continua; reabrir o canvas reenvia o snapshot
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('visor.openCanvas', openCanvas),
    vscode.commands.registerCommand('visor.cancelRun', () => {
      controller.handle({ type: 'cancel' }).catch((err) => log.appendLine(String(err)));
    }),
    log,
    { dispose: () => controller.dispose() },
  );
}

export function deactivate(): void {}
```

- [ ] **Step 8: Build e typecheck**

Run: `npm run build && npm run typecheck && npm test`
Expected: `dist/extension.cjs`, `dist/webview.js` gerados sem erros; typecheck limpo; suíte verde. Conferir: `ls dist` mostra `extension.cjs`, `webview.js`; `grep -c "require(\"vscode\")" dist/extension.cjs` é ≥ 1 (vscode não embutido).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(ext): esqueleto da extensão, build com esbuild e HTML com CSP"
```

---

### Task 8: UI da Webview

**Files:**
- Create: `webview/state.ts`, `webview/graph.ts`, `webview/format.ts`, `webview/App.tsx`, `webview/Toolbar.tsx`, `webview/Banner.tsx`, `webview/GraphView.tsx`, `webview/AgentNodeCard.tsx`, `webview/styles.css`
- Modify: `webview/index.tsx`
- Test: `tests/webview/state.test.ts`, `tests/webview/graph.test.ts`, `tests/webview/format.test.ts`

**Interfaces:**
- Consumes: `HostMessage`, `RunView`, `NodeView`, `WebviewMessage` (Task 5); `CliCheck` (Task 2); `layoutTree` (Task 4); `NodeStatus` (M0).
- Produces:
  - `interface ViewState { cli: CliCheck | null; run: RunView | null; notices: Notice[] }`, `interface Notice { id: number; level: 'info'|'warn'|'error'; text: string }`
  - `type Action = HostMessage | { type: 'dismiss'; id: number }`
  - `const initialState: ViewState`, `function reduce(state: ViewState, action: Action): ViewState` (no máximo 5 notices; ids crescentes)
  - `function isActive(run: RunView | null): boolean` (status `running` ou `pending`)
  - `interface FlowNodeData { agentType: string; label: string; status: NodeStatus; startedAt?: number; endedAt?: number; eventCount: number; isRoot: boolean }`
  - `function toFlow(run: RunView | null): { nodes: { id: string; type: 'agent'; position: { x: number; y: number }; data: FlowNodeData }[]; edges: { id: string; source: string; target: string; animated: boolean }[] }`
  - `function formatDuration(ms: number): string` (`850ms`, `1.2s`, `59.9s`, `1m 05s`, `1h 02m`)
  - `const STATUS_LABEL: Record<NodeStatus, string>` e `const STATUS_GLYPH: Record<NodeStatus, string>`

- [ ] **Step 1: Escrever os testes que falham**

`tests/webview/format.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatDuration, STATUS_LABEL, STATUS_GLYPH } from '../../webview/format';

describe('formatDuration', () => {
  it.each([
    [0, '0ms'], [850, '850ms'], [1200, '1.2s'], [59_900, '59.9s'],
    [60_000, '1m 00s'], [65_000, '1m 05s'], [3_720_000, '1h 02m'],
  ])('%i -> %s', (ms, out) => expect(formatDuration(ms)).toBe(out));

  it('valores negativos ou inválidos viram 0ms', () => {
    expect(formatDuration(-5)).toBe('0ms');
    expect(formatDuration(NaN)).toBe('0ms');
  });
});

describe('rótulos de status', () => {
  it('todo status tem rótulo e glifo, e os glifos são distintos (não só cor)', () => {
    const keys = ['pending', 'running', 'done', 'error', 'cancelled'] as const;
    for (const k of keys) { expect(STATUS_LABEL[k]).toBeTruthy(); expect(STATUS_GLYPH[k]).toBeTruthy(); }
    expect(new Set(keys.map((k) => STATUS_GLYPH[k])).size).toBe(5);
  });
});
```

`tests/webview/state.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { reduce, initialState, isActive } from '../../webview/state';
import type { RunView } from '../../src/protocol';

const run = (status: RunView['status']): RunView => ({ id: 'r', status, startedAt: 1, nodes: [], edges: [] });

describe('reduce', () => {
  it('snapshot substitui o run; snapshot nulo limpa', () => {
    const s1 = reduce(initialState, { type: 'snapshot', run: run('running') });
    expect(s1.run?.status).toBe('running');
    expect(reduce(s1, { type: 'snapshot', run: null }).run).toBeNull();
  });

  it('cli guarda o diagnóstico', () => {
    const check = { state: 'ok', version: '1', authMethod: 'claude.ai' } as const;
    expect(reduce(initialState, { type: 'cli', check }).cli).toEqual(check);
  });

  it('notice acumula com ids crescentes, no máximo 5, e dismiss remove', () => {
    let s = initialState;
    for (let i = 0; i < 7; i++) s = reduce(s, { type: 'notice', level: 'info', text: `n${i}` });
    expect(s.notices).toHaveLength(5);
    expect(s.notices.map((n) => n.text)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
    const ids = s.notices.map((n) => n.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const after = reduce(s, { type: 'dismiss', id: ids[0]! });
    expect(after.notices).toHaveLength(4);
  });

  it('não muta o estado anterior', () => {
    const before = structuredClone(initialState);
    reduce(initialState, { type: 'notice', level: 'warn', text: 'x' });
    expect(initialState).toEqual(before);
  });
});

describe('isActive', () => {
  it('running e pending estão ativos; o resto e nulo não', () => {
    expect(isActive(run('running'))).toBe(true);
    expect(isActive(run('pending'))).toBe(true);
    for (const st of ['done', 'error', 'cancelled'] as const) expect(isActive(run(st))).toBe(false);
    expect(isActive(null)).toBe(false);
  });
});
```

`tests/webview/graph.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { toFlow } from '../../webview/graph';
import type { RunView } from '../../src/protocol';

const run: RunView = {
  id: 'r', status: 'running', startedAt: 1,
  nodes: [
    { id: 'r:root', parentId: null, agentType: 'root', status: 'running', startedAt: 1, eventCount: 0 },
    { id: 'r:a', parentId: 'r:root', agentType: 'backend', status: 'running', startedAt: 2, eventCount: 3 },
    { id: 'r:b', parentId: 'r:root', agentType: 'tests', status: 'done', startedAt: 2, endedAt: 5, eventCount: 1 },
  ],
  edges: [{ from: 'r:root', to: 'r:a' }, { from: 'r:root', to: 'r:b' }],
};

describe('toFlow', () => {
  it('null vira grafo vazio', () => {
    expect(toFlow(null)).toEqual({ nodes: [], edges: [] });
  });

  it('nodes ganham posição do layout em árvore e rótulos', () => {
    const f = toFlow(run);
    const byId = Object.fromEntries(f.nodes.map((n) => [n.id, n]));
    expect(byId['r:root']!.position).toEqual({ x: 110, y: 0 });
    expect(byId['r:a']!.position).toEqual({ x: 0, y: 120 });
    expect(byId['r:root']!.data).toMatchObject({ isRoot: true, label: 'Orquestrador' });
    expect(byId['r:a']!.data).toMatchObject({ isRoot: false, label: 'backend', eventCount: 3 });
    expect(f.nodes.every((n) => n.type === 'agent')).toBe(true);
  });

  it('aresta anima só enquanto o destino está em execução', () => {
    const f = toFlow(run);
    expect(f.edges).toEqual([
      { id: 'r:root->r:a', source: 'r:root', target: 'r:a', animated: true },
      { id: 'r:root->r:b', source: 'r:root', target: 'r:b', animated: false },
    ]);
  });

  it('aresta para node inexistente é descartada', () => {
    const f = toFlow({ ...run, edges: [{ from: 'r:root', to: 'fantasma' }] });
    expect(f.edges).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/webview`
Expected: FAIL (módulos não existem).

- [ ] **Step 3: Implementar os módulos puros**

`webview/format.ts`:
```ts
import type { NodeStatus } from '../src/core/schema';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`;
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'aguardando',
  running: 'executando',
  done: 'concluído',
  error: 'erro',
  cancelled: 'cancelado',
};

export const STATUS_GLYPH: Record<NodeStatus, string> = {
  pending: '○',
  running: '●',
  done: '✓',
  error: '✕',
  cancelled: '■',
};
```

`webview/state.ts`:
```ts
import type { CliCheck } from '../src/cli/detect';
import type { HostMessage, RunView } from '../src/protocol';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}
export interface ViewState {
  cli: CliCheck | null;
  run: RunView | null;
  notices: Notice[];
  nextNoticeId: number;
}
export type Action = HostMessage | { type: 'dismiss'; id: number };

export const initialState: ViewState = { cli: null, run: null, notices: [], nextNoticeId: 1 };
const MAX_NOTICES = 5;

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, run: action.run };
    case 'cli':
      return { ...state, cli: action.check };
    case 'notice': {
      const notice: Notice = { id: state.nextNoticeId, level: action.level, text: action.text };
      return { ...state, notices: [...state.notices, notice].slice(-MAX_NOTICES), nextNoticeId: state.nextNoticeId + 1 };
    }
    case 'dismiss':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
  }
}

export function isActive(run: RunView | null): boolean {
  return run?.status === 'running' || run?.status === 'pending';
}
```
Ajustar `tests/webview/state.test.ts` se necessário: `initialState` agora tem `nextNoticeId`; o teste "não muta" continua válido.

`webview/graph.ts`:
```ts
import type { NodeStatus } from '../src/core/schema';
import { layoutTree } from '../src/core/layout';
import type { RunView } from '../src/protocol';

export interface FlowNodeData {
  agentType: string;
  label: string;
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
  isRoot: boolean;
}

export function toFlow(run: RunView | null) {
  if (!run) return { nodes: [], edges: [] };
  const positions = layoutTree(run.nodes.map((n) => ({ id: n.id, parentId: n.parentId })));
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const nodes = run.nodes.map((n) => {
    const isRoot = n.parentId === null;
    return {
      id: n.id,
      type: 'agent' as const,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: {
        agentType: n.agentType,
        label: isRoot ? 'Orquestrador' : n.agentType,
        status: n.status,
        startedAt: n.startedAt,
        endedAt: n.endedAt,
        eventCount: n.eventCount,
        isRoot,
      } satisfies FlowNodeData,
    };
  });
  const edges = run.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to, animated: byId.get(e.to)!.status === 'running' }));
  return { nodes, edges };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/webview && npm run typecheck`
Expected: todos passam; typecheck limpo.

- [ ] **Step 5: Componentes React e estilos**

`webview/AgentNodeCard.tsx`:
```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { formatDuration, STATUS_GLYPH, STATUS_LABEL } from './format';
import type { FlowNodeData } from './graph';

export function AgentNodeCard({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData & { now: number };
  const end = d.endedAt ?? d.now;
  const duration = d.startedAt ? formatDuration(end - d.startedAt) : '';
  return (
    <div className={`agent-node status-${d.status}${d.isRoot ? ' is-root' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="agent-name">{d.label}</div>
      <div className="agent-meta">
        <span className="status-badge">
          <span aria-hidden="true">{STATUS_GLYPH[d.status]}</span> {STATUS_LABEL[d.status]}
        </span>
        <span>{duration}</span>
      </div>
      {d.eventCount > 0 && <div className="agent-events">{d.eventCount} eventos</div>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
```

`webview/GraphView.tsx`:
```tsx
import { Background, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import type { RunView } from '../src/protocol';
import { AgentNodeCard } from './AgentNodeCard';
import { toFlow } from './graph';

const nodeTypes = { agent: AgentNodeCard };

export function GraphView({ run, now }: { run: RunView | null; now: number }) {
  const flow = useMemo(() => toFlow(run), [run]);
  const nodes = useMemo(() => flow.nodes.map((n) => ({ ...n, data: { ...n.data, now } })), [flow, now]);
  const dark = !document.body.classList.contains('vscode-light');
  if (!run || run.nodes.length === 0) {
    return <div className="empty">{run ? 'Aguardando o agente iniciar…' : 'Escreva um prompt e clique em Executar para ver os agentes.'}</div>;
  }
  return (
    <ReactFlowProvider>
      <ReactFlow
        key={run.nodes.length}
        nodes={nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        colorMode={dark ? 'dark' : 'light'}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
```
O `key={run.nodes.length}` remonta o `ReactFlow` quando um node é adicionado, para o `fitView` reenquadrar o grafo.

`webview/Toolbar.tsx`:
```tsx
import { useState } from 'react';

export function Toolbar({ running, onStart, onCancel }: { running: boolean; onStart(prompt: string): void; onCancel(): void }) {
  const [prompt, setPrompt] = useState('');
  const submit = () => {
    if (!running && prompt.trim()) onStart(prompt);
  };
  return (
    <div className="toolbar">
      <textarea
        value={prompt}
        placeholder="Descreva a tarefa para o agente… (Ctrl/Cmd+Enter para executar)"
        aria-label="Prompt"
        rows={2}
        disabled={running}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {running ? (
        <button className="danger" onClick={onCancel}>Cancelar</button>
      ) : (
        <button onClick={submit} disabled={!prompt.trim()}>Executar</button>
      )}
    </div>
  );
}
```

`webview/Banner.tsx`:
```tsx
import type { CliCheck } from '../src/cli/detect';
import type { Notice } from './state';

export function Banner({ cli, notices, onDismiss }: { cli: CliCheck | null; notices: Notice[]; onDismiss(id: number): void }) {
  return (
    <div className="banners">
      {cli?.state === 'ok' && (
        <div className="banner info" role="status">
          Autenticação: {cli.authMethod} · via CLI do Claude Code {cli.version}. A extensão não acessa suas credenciais.
        </div>
      )}
      {cli && cli.state !== 'ok' && (
        <div className={`banner ${cli.state === 'unknown' ? 'warn' : 'error'}`} role="alert">{cli.message}</div>
      )}
      {notices.map((n) => (
        <div key={n.id} className={`banner ${n.level}`} role={n.level === 'error' ? 'alert' : 'status'}>
          <span>{n.text}</span>
          <button className="link" onClick={() => onDismiss(n.id)} aria-label="Dispensar aviso">×</button>
        </div>
      ))}
    </div>
  );
}
```

`webview/App.tsx`:
```tsx
import { useEffect, useReducer, useState } from 'react';
import type { HostMessage, WebviewMessage } from '../src/protocol';
import { Banner } from './Banner';
import { GraphView } from './GraphView';
import { initialState, isActive, reduce } from './state';
import { Toolbar } from './Toolbar';

const vscode = acquireVsCodeApi();
const send = (m: WebviewMessage) => vscode.postMessage(m);

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [now, setNow] = useState(() => Date.now());
  const running = isActive(state.run);

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => dispatch(e.data);
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  return (
    <div className="app">
      <Toolbar running={running} onStart={(prompt) => send({ type: 'start', prompt })} onCancel={() => send({ type: 'cancel' })} />
      <Banner cli={state.cli} notices={state.notices} onDismiss={(id) => dispatch({ type: 'dismiss', id })} />
      <div className="canvas"><GraphView run={state.run} now={now} /></div>
    </div>
  );
}
```

`webview/index.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
```

`webview/styles.css` (tokens em `:root`, herdando as variáveis do tema do VS Code):
```css
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-editor-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border, #8884);
  --card: var(--vscode-editorWidget-background, var(--bg));
  --accent: var(--vscode-button-background);
  --accent-fg: var(--vscode-button-foreground);
  --running: var(--vscode-charts-blue, #3794ff);
  --done: var(--vscode-charts-green, #89d185);
  --error: var(--vscode-errorForeground, #f48771);
  --cancelled: var(--vscode-charts-yellow, #cca700);
  --pending: var(--vscode-disabledForeground, #888);
}
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.app { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.toolbar textarea { flex: 1; resize: vertical; min-height: 40px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; padding: 6px 8px; font: inherit; }
.toolbar textarea:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button { background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 4px; padding: 6px 16px; cursor: pointer; font: inherit; }
button:disabled { opacity: .5; cursor: default; }
button.danger { background: var(--vscode-errorForeground, #c33); color: #fff; }
button.link { background: none; color: inherit; padding: 0 4px; font-size: 1.2em; }
.banners { display: flex; flex-direction: column; gap: 4px; padding: 8px 16px 0; }
.banner { display: flex; justify-content: space-between; gap: 8px; padding: 6px 10px; border-radius: 4px; border-left: 3px solid var(--muted); background: var(--card); }
.banner.error { border-left-color: var(--error); }
.banner.warn { border-left-color: var(--cancelled); }
.banner.info { border-left-color: var(--running); }
.canvas { flex: 1; min-height: 0; }
.empty { display: grid; place-items: center; height: 100%; color: var(--muted); padding: 0 16px; text-align: center; }
.agent-node { min-width: 160px; padding: 8px 12px; border-radius: 6px; background: var(--card); border: 2px solid var(--pending); color: var(--fg); }
.agent-node.is-root { border-style: double; }
.agent-name { font-weight: 600; margin-bottom: 4px; }
.agent-meta { display: flex; justify-content: space-between; gap: 12px; font-size: .9em; color: var(--muted); }
.agent-events { font-size: .85em; color: var(--muted); margin-top: 2px; }
.status-running { border-color: var(--running); }
.status-done { border-color: var(--done); }
.status-error { border-color: var(--error); }
.status-cancelled { border-color: var(--cancelled); }
.status-running .status-badge { color: var(--running); }
.status-done .status-badge { color: var(--done); }
.status-error .status-badge { color: var(--error); }
.status-cancelled .status-badge { color: var(--cancelled); }
@media (prefers-reduced-motion: reduce) { .react-flow__edge.animated path { animation: none !important; } }
@media (max-width: 480px) { .toolbar { flex-direction: column; } }
```

- [ ] **Step 6: Build, typecheck e suíte**

Run: `npm run build && npm run typecheck && npm test`
Expected: bundles gerados (`dist/webview.css` presente); typecheck limpo; suíte verde.

- [ ] **Step 7: Smoke automatizado do bundle da Webview**

Rodar o bundle num DOM simulado e conferir que monta sem lançar. Criar `tests/webview/bundle-smoke.test.ts`:
```ts
import { it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

it('o bundle da webview existe, não referencia eval e inclui o app', () => {
  expect(existsSync('dist/webview.js')).toBe(true);
  const js = readFileSync('dist/webview.js', 'utf8');
  expect(js).not.toMatch(/\beval\(/);
  expect(js).toContain('Aguardando o agente iniciar');
  expect(existsSync('dist/webview.css')).toBe(true);
});
```
Run: `npm run build && npx vitest run tests/webview/bundle-smoke.test.ts`
Expected: PASS. (Se `React Flow` usar `new Function`, a CSP sem `unsafe-eval` quebraria; o `grep -c "new Function" dist/webview.js` deve ser 0. Se não for, registrar um achado e avaliar.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(webview): canvas React Flow, toolbar, avisos e estado puro testado"
```

---

### Task 9: Roteiro de smoke manual e fechamento do M1

**Files:**
- Create: `docs/m1-smoke.md`
- Modify: `docs/m0-findings.md` (nada), `spec-harness-multiagentes-v0.4.md` (status)

- [ ] **Step 1: Escrever `docs/m1-smoke.md`**

```markdown
# Smoke manual do M1

Pré-requisitos: `npm run build`; `claude` instalado e autenticado.

1. Abra este repositório no VS Code e pressione F5 ("Executar extensão"). Abre uma janela com `fixtures/project` como workspace.
2. Paleta de comandos → **Visor: Abrir canvas de agentes**. Esperado: nova **aba do editor** "Visor — Agentes" (não sidebar).
3. Prompt: `Use the echo subagent twice, in parallel, with the texts 'alpha' and 'beta', then summarize.` → Executar. Esperado:
   - banner "Autenticação: … via CLI do Claude Code …";
   - o nó Orquestrador aparece e depois dois nós `echo` abaixo dele, ligados por arestas;
   - nós mudam de "executando" para "concluído"; o botão volta de "Cancelar" para "Executar".
4. Rode de novo com `Write a 300-word story about a robot.` e clique **Cancelar** logo no início. Esperado: nós em "cancelado", aviso "Execução cancelada.", e `pgrep -fl "claude.*stream-json"` não lista nada.
5. Com um run em andamento, feche a aba do canvas e reabra pelo comando. Esperado: o canvas volta com o estado atual do run.
6. Configurações → Visor: `Claude Path` = `/caminho/que/nao/existe`; Executar. Esperado: aviso pedindo para instalar/configurar, nenhum processo criado.
7. Volte o caminho ao padrão; mude `Permission Mode` para `bypassPermissions`; Executar. Esperado: diálogo modal de confirmação; "Cancelar" no diálogo não inicia o run.
8. Janela estreita (< 480 px): toolbar empilha, sem rolagem horizontal. Tema claro e escuro legíveis.
9. Fechar a janela do Extension Development Host com um run ativo não deixa processo `claude` órfão.

Registre o resultado (✓/✗ e observações) em `docs/m1-findings.md`.
```

- [ ] **Step 2: Rodar tudo que é automatizável**

Run: `npm run build && npm run typecheck && npm test`
Expected: build sem erros, typecheck limpo, suíte verde. Registrar a contagem de testes.

- [ ] **Step 3: Tentar o smoke com o VS Code real, se houver `code` no PATH**

Run: `which code && code --version`
Se existir, abrir o Extension Development Host com `code --extensionDevelopmentPath=$PWD fixtures/project` e pedir à pessoa responsável que percorra o roteiro (esta etapa precisa de uma pessoa: janelas gráficas não são operáveis aqui). Se não existir, registrar "smoke manual pendente" em `docs/m1-findings.md`. **Não** marcar o M1 como validado sem esse resultado.

- [ ] **Step 4: Atualizar a spec**

No cabeçalho de `spec-harness-multiagentes-v0.4.md`, acrescentar uma linha: `M1 implementado; smoke manual: <pendente|ok em data>`. Atualizar a seção 7 com o uso de `claude auth status --json` (só `loggedIn` e `authMethod`). Atualizar a seção 7.1 com os seis modos de permissão do CLI 2.1.267.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: roteiro de smoke do M1 e spec atualizada"
```

---

## Self-Review

**Cobertura da spec (M1 e dependências):**
- RF-01 aba do editor → Task 7 (`ViewColumn.Active`, `createWebviewPanel`).
- RF-02 prompt cria run com o workspace como `cwd` → Tasks 6 e 7.
- RF-05/06/07 nodes, arestas e estados em tempo real → Tasks 5, 6, 8.
- RF-09 cancelar → Task 6 (`cancel`, `dispose`) + M0 (árvore de processos).
- RF-10 CLI instalado e autenticado sem ler credenciais → Task 2.
- RF-14 permissões configuráveis → Tasks 3, 6, 7.
- Spec §3.7 UI informa método de autenticação → Task 8 (`Banner`).
- Spec §7.1 `bypassPermissions` com confirmação → Task 6.
- Spec §12 Windows → Global Constraints e Task 2 (limitação declarada, não verificável aqui).
- Spec §12 faixa de versões do CLI com mensagem fora dela → **não coberto**: M1 só exibe a versão. Fica como item para o M2 (registrado aqui para não se perder).
- Fixtures com dados pessoais → Task 1.
- Itens fora do M1: inspetor (M2), presets (M2), `--resume` (M2), runs simultâneos (M4), terminal (M3).

**Consistência de tipos:** `CliCheck`, `RunView`/`NodeView`, `HostMessage`/`WebviewMessage`, `VisorSettings`, `ControllerDeps`, `toRunView`, `layoutTree`, `toFlow`, `reduce`/`Action` usam os mesmos nomes e formas em todos os tasks. `AgentNodeCard` recebe `now` dentro de `data` (injetado em `GraphView`).

**Pontos de atenção:** o smoke manual (Task 9) precisa de uma pessoa; o histórico git ainda contém as fixtures não sanitizadas (item no `release-checklist`); o suporte a `claude.cmd` no Windows fica fora do M1.
