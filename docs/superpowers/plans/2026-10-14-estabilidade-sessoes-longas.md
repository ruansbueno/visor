# Estabilidade em sessões longas — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O Visor aguenta horas de uso com várias conversas em paralelo: a pergunta do agente sempre aceita resposta, processo parado é avisado, login perdido é reconhecido e nenhum processo sobra depois de fechar o VS Code.

**Architecture:** O host passa a distinguir "turno em andamento" de "processo vivo depois do fim do turno" (`turnOver`). Neste segundo estado a resposta vai pelo stdin do mesmo processo, o que o spike confirmou que funciona. Um watchdog avisa quando o processo fica parado. O `StreamAdapter` emite `auth_lost` a partir do campo estruturado `assistant.error`. Um registro de processos em `globalStorage`, com o dono (pid do extension host) em cada entrada, permite encerrar órfãos na ativação sem tocar nas outras janelas.

**Tech Stack:** TypeScript, Node ≥ 20, API de extensão do VS Code ≥ 1.90, React 18 + @xyflow/react (Webview), vitest + jsdom, `fixtures/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-14-estabilidade-sessoes-longas-design.md` (ler as seções "Resultados do spike" e "Ajustes ao desenho" antes de começar).

## Global Constraints

- Textos de interface e comentários em português, no tom do código vizinho; nada de inglês na UI.
- Nunca registrar no log prompts, conteúdo de mensagens, tokens, e-mail ou caminhos de credencial.
- O Visor nunca encerra processo sozinho quando o watchdog dispara: só avisa e oferece **Encerrar processo** / **Continuar esperando**.
- Sem dependências novas no `package.json`.
- Configurações novas: `visor.debugLog` (boolean, padrão `false`) e `visor.lingerTimeoutMinutes` (número ≥ 0, padrão `10`, `0` desliga).
- `lingerCloseMs` padrão `30000`.
- Limpeza de órfãos só mata quando o pid **e** a linha de comando conferem **e** o dono (extension host) já morreu. No Windows não há conferência: a entrada é descartada sem matar.
- Rodar `npm run typecheck` e `npm test` ao fim de cada tarefa. O `pretest` faz o build.

## Review Focus

1. **Várias janelas do VS Code abertas:** abrir uma segunda janela não pode matar as conversas da primeira. O registro guarda `owner` e só limpa entradas de dono morto. O teste fica na Task 8.
2. **Clique na janela de ~50 ms entre o `result` e a saída do processo** (sem tarefa em background, stdin já fechado): a resposta não pode se perder. O controller espera o processo sair e retoma com `--resume`. O teste fica na Task 5 ("stdin já fechado").
3. **Login perdido num processo que segue vivo por tarefas em background:** a próxima resposta não pode ir pelo stdin desse processo. O controller força um processo novo. O teste fica na Task 7.
4. **Resposta com opções trocadas (modelo/permissões) ou anexos de fora do projeto enquanto o processo segue vivo:** o processo vivo não tem essas opções, então ele é encerrado e o turno é retomado num novo, sem o aviso falso de "Execução cancelada". O teste fica na Task 5.
5. **Tarefas em background zeradas sem o CLI abrir um turno novo:** o processo não pode ficar vivo para sempre. O stdin fecha depois de `lingerCloseMs`. O teste fica na Task 3.

---

### Task 1: Configurações novas

**Files:**
- Modify: `src/ext/settings.ts`
- Modify: `package.json` (bloco `contributes.configuration.properties`, perto de `visor.parallelWarningThreshold`)
- Test: `tests/ext/settings.test.ts`

**Interfaces:**
- Produces: `VisorSettings.debugLog: boolean`, `VisorSettings.lingerTimeoutMinutes: number`; `DEFAULT_SETTINGS.debugLog === false`, `DEFAULT_SETTINGS.lingerTimeoutMinutes === 10`.

- [ ] **Step 1: Atualizar os testes**

Em `tests/ext/settings.test.ts`, os dois primeiros testes comparam o objeto inteiro. Acrescente os campos novos nos dois `toEqual`:

```ts
    expect(DEFAULT_SETTINGS).toEqual({ claudePath: 'claude', permissionMode: 'acceptEdits', allowedTools: [], disallowedTools: [], parallelWarningThreshold: 4, codexPath: 'codex', codexSandbox: 'workspace-write', debugLog: false, lingerTimeoutMinutes: 10 });
```

```ts
      .toEqual({ claudePath: '/opt/claude', permissionMode: 'plan', allowedTools: ['Read', 'Bash(npm test:*)'], disallowedTools: ['WebFetch'], parallelWarningThreshold: 6, codexPath: '/opt/codex', codexSandbox: 'workspace-write', debugLog: false, lingerTimeoutMinutes: 10 });
```

E acrescente ao fim do `describe`:

```ts
  it('debugLog só liga com true de verdade', () => {
    expect(from({ debugLog: true }).debugLog).toBe(true);
    expect(from({ debugLog: 'true' }).debugLog).toBe(false);
    expect(from({ debugLog: 1 }).debugLog).toBe(false);
  });

  it('lingerTimeoutMinutes aceita 0 (desliga) e frações; inválido volta a 10', () => {
    expect(from({ lingerTimeoutMinutes: 0 }).lingerTimeoutMinutes).toBe(0);
    expect(from({ lingerTimeoutMinutes: 2.5 }).lingerTimeoutMinutes).toBe(2.5);
    expect(from({ lingerTimeoutMinutes: -1 }).lingerTimeoutMinutes).toBe(10);
    expect(from({ lingerTimeoutMinutes: Number.NaN }).lingerTimeoutMinutes).toBe(10);
    expect(from({ lingerTimeoutMinutes: '5' }).lingerTimeoutMinutes).toBe(10);
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/settings.test.ts`
Expected: FAIL (os campos `debugLog` e `lingerTimeoutMinutes` não existem).

- [ ] **Step 3: Implementar**

Em `src/ext/settings.ts`, no `interface VisorSettings`, depois de `parallelWarningThreshold`:

```ts
  /** Log de diagnóstico detalhado no canal "Visor" (spawn/exit sempre vão; isto liga os eventos de debug). */
  debugLog: boolean;
  /** Minutos sem eventos, com o turno encerrado e o processo vivo, até avisar que travou (0 desliga). */
  lingerTimeoutMinutes: number;
```

Em `DEFAULT_SETTINGS`, depois de `parallelWarningThreshold: 4,`:

```ts
  debugLog: false,
  lingerTimeoutMinutes: 10,
```

Depois da função `threshold`:

```ts
const minutes = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_SETTINGS.lingerTimeoutMinutes;
```

No objeto devolvido por `parseSettings`, depois de `parallelWarningThreshold: ...`:

```ts
    debugLog: get('debugLog') === true,
    lingerTimeoutMinutes: minutes(get('lingerTimeoutMinutes')),
```

Em `package.json`, logo depois do bloco `"visor.parallelWarningThreshold": { ... },`:

```json
        "visor.debugLog": {
          "type": "boolean",
          "default": false,
          "markdownDescription": "Grava no canal de saída **Visor** os eventos detalhados de diagnóstico (tarefas em segundo plano, tamanho do snapshot). Início e fim de cada processo são sempre registrados. Nunca registra mensagens nem credenciais."
        },
        "visor.lingerTimeoutMinutes": {
          "type": "number",
          "default": 10,
          "minimum": 0,
          "markdownDescription": "Minutos que um processo pode ficar sem dar sinal depois de o agente terminar de responder (com tarefa em segundo plano pendente) antes de o Visor avisar que travou. `0` desliga o aviso. O Visor nunca encerra o processo sozinho."
        },
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/ext/settings.test.ts tests/manifest.test.ts`
Expected: PASS. Se o `manifest.test.ts` comparar as configurações do `package.json` com `DEFAULT_SETTINGS`, ele também deve passar, porque os padrões batem.

- [ ] **Step 5: Commit**

```bash
git add src/ext/settings.ts package.json tests/ext/settings.test.ts
git commit -m "feat: configurações visor.debugLog e visor.lingerTimeoutMinutes"
```

---

### Task 2: Log de diagnóstico

**Files:**
- Create: `src/ext/diag-log.ts`
- Test: `tests/ext/diag-log.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DiagFields = Record<string, string | number | boolean | undefined>;
  export interface DiagLog { info(event: string, fields?: DiagFields): void; debug(event: string, fields?: DiagFields): void; debugEnabled(): boolean }
  export function createDiagLog(append: (line: string) => void, debugOn: () => boolean, now?: () => Date): DiagLog;
  export const NO_LOG: DiagLog;
  ```

- [ ] **Step 1: Escrever o teste**

```ts
import { describe, it, expect } from 'vitest';
import { createDiagLog, NO_LOG } from '../../src/ext/diag-log';

const at = () => new Date('2026-10-14T12:00:00.000Z');

describe('createDiagLog', () => {
  it('info: horário ISO, evento e campos k=v; undefined some; texto com espaço vai entre aspas', () => {
    const lines: string[] = [];
    const log = createDiagLog((l) => lines.push(l), () => false, at);
    log.info('exit', { pid: 42, code: 0, cancelled: false, signal: undefined, stderr: 'deu ruim aqui' });
    expect(lines).toEqual(['2026-10-14T12:00:00.000Z exit pid=42 code=0 cancelled=false stderr="deu ruim aqui"']);
  });

  it('debug só escreve com debugOn() verdadeiro, lido a cada chamada', () => {
    const lines: string[] = [];
    let on = false;
    const log = createDiagLog((l) => lines.push(l), () => on, at);
    log.debug('snapshot', { bytes: 10 });
    on = true;
    log.debug('snapshot', { bytes: 20 });
    expect(lines).toEqual(['2026-10-14T12:00:00.000Z snapshot bytes=20']);
    expect(log.debugEnabled()).toBe(true);
  });

  it('NO_LOG não faz nada e não lança', () => {
    expect(() => { NO_LOG.info('x'); NO_LOG.debug('y'); }).not.toThrow();
    expect(NO_LOG.debugEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/diag-log.test.ts`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Implementar**

`src/ext/diag-log.ts`:

```ts
/** Campos de uma linha de diagnóstico. Nunca passar prompts, mensagens, tokens, e-mail ou caminhos de credencial. */
export type DiagFields = Record<string, string | number | boolean | undefined>;

export interface DiagLog {
  info(event: string, fields?: DiagFields): void;
  /** Só escreve com `visor.debugLog` ligado. */
  debug(event: string, fields?: DiagFields): void;
  /** Para não calcular campos caros (ex.: tamanho do snapshot) à toa. */
  debugEnabled(): boolean;
}

const value = (v: string | number | boolean) => (typeof v === 'string' && /[\s"=]/.test(v) ? JSON.stringify(v) : String(v));

/** Uma linha por evento: `<ISO> <evento> k=v ...`, fácil de ler no canal de saída e de filtrar com grep. */
export function createDiagLog(append: (line: string) => void, debugOn: () => boolean, now: () => Date = () => new Date()): DiagLog {
  const line = (event: string, fields: DiagFields = {}) =>
    [now().toISOString(), event, ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${value(v!)}`)].join(' ');
  return {
    info: (event, fields) => append(line(event, fields)),
    debug: (event, fields) => {
      if (debugOn()) append(line(event, fields));
    },
    debugEnabled: debugOn,
  };
}

export const NO_LOG: DiagLog = { info() {}, debug() {}, debugEnabled: () => false };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/ext/diag-log.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ext/diag-log.ts tests/ext/diag-log.test.ts
git commit -m "feat: log de diagnóstico de uma linha por evento"
```

---

### Task 3: `process-run`: pid, nova mensagem no processo vivo, cancelamento imediato e fechamento por inatividade

**Files:**
- Modify: `src/cli/process-run.ts`
- Test: `tests/cli/process-run.test.ts` (dentro de `describe('stdin e permissões')`)

**Interfaces:**
- Consumes: `userMessageLine(text)` de `src/cli/claude-input.ts`.
- Produces (em `ProcessRun`):
  ```ts
  readonly pid?: number;
  cancel(how?: { immediate?: boolean }): void;
  sendUserMessage(text: string): boolean;
  hasBackgroundTasks(): boolean;
  ```
  e `ProcessRunOptions.lingerCloseMs?: number`.

- [ ] **Step 1: Escrever os testes**

Dentro de `describe('stdin e permissões', ...)` em `tests/cli/process-run.test.ts`, depois do teste "com tarefa em segundo plano pendente o stdin segue aberto até o run_finished seguinte":

```ts
    const bgLine = (n: number) => L({ type: 'system', subtype: 'background_tasks_changed', tasks: Array.from({ length: n }, (_, k) => ({ task_id: `t${k}` })) });
    const initLine = L({ type: 'system', subtype: 'init', session_id: 's1' });
    const resultLine = L({ type: 'result', is_error: false, session_id: 's1' });

    it('sendUserMessage depois do result, com tarefa em segundo plano, escreve um novo turno no stdin', async () => {
      const dir = tmp();
      const f = path.join(dir, 's.ndjson');
      const stdinFile = path.join(dir, 'stdin.log');
      writeFileSync(f, [initLine, bgLine(1), resultLine].join('\n') + '\n');
      let finished!: () => void;
      const turnOver = new Promise<void>((r) => (finished = r));
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--until-stdin-end', '--stdin-file', stdinFile], cwd: process.cwd(), input: 'primeira\n',
      }, (e) => { if (e.type === 'run_finished') finished(); });
      await turnOver;
      expect(run.hasBackgroundTasks()).toBe(true);
      expect(run.sendUserMessage('segunda')).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      run.cancel();
      await run.done;
      const lines = readFileSync(stdinFile, 'utf8').trim().split('\n');
      expect(JSON.parse(lines.at(-1)!)).toEqual({ type: 'user', message: { role: 'user', content: 'segunda' } });
    });

    it('sendUserMessage com o processo já encerrado devolve false', async () => {
      const f = path.join(tmp(), 's.ndjson');
      writeFileSync(f, happy);
      const run = startProcessRun('r1', { command: process.execPath, args: [fake, f, '--until-stdin-end'], cwd: process.cwd(), input: 'x\n' }, () => {});
      await run.done;
      expect(run.sendUserMessage('tarde')).toBe(false);
    });

    it('tarefas zeradas sem turno novo: o stdin fecha depois de lingerCloseMs e o processo sai sozinho', async () => {
      const f = path.join(tmp(), 's.ndjson');
      writeFileSync(f, [initLine, bgLine(1), resultLine, bgLine(0)].join('\n') + '\n');
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--until-stdin-end'], cwd: process.cwd(), input: 'x\n', lingerCloseMs: 100,
      }, () => {});
      const r = await run.done;
      expect(r.cancelled).toBe(false);
      expect(r.exitCode).toBe(0);
    });

    it.skipIf(process.platform === 'win32')('cancel({ immediate: true }) mata na hora, mesmo se o CLI ignora SIGTERM', async () => {
      const f = path.join(tmp(), 's.ndjson');
      writeFileSync(f, happy.split('\n').slice(0, 2).join('\n') + '\n');
      const run = startProcessRun('r1', {
        command: process.execPath, args: [fake, f, '--hang', '--ignore-sigterm'], cwd: process.cwd(), cancelGraceMs: 10_000,
      }, () => {});
      expect(typeof run.pid).toBe('number');
      await new Promise((r) => setTimeout(r, 150));
      const t0 = Date.now();
      run.cancel({ immediate: true });
      const r = await run.done;
      expect(r.cancelled).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
    });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/cli/process-run.test.ts`
Expected: FAIL. `sendUserMessage`/`hasBackgroundTasks` não existem, e o teste de inatividade estoura o tempo de 5 s.

- [ ] **Step 3: Implementar**

Em `src/cli/process-run.ts`:

1. Import: `import { permissionResponseLine, userMessageLine, type PermissionDecision } from './claude-input';`
2. Em `ProcessRunOptions`, depois de `resume?`:
   ```ts
   /** Fim do turno com as tarefas em segundo plano já zeradas e nenhum turno novo: fecha o stdin depois deste tempo (padrão 30000 ms). */
   lingerCloseMs?: number;
   ```
3. Troque o `interface ProcessRun` por:
   ```ts
   export interface ProcessRun {
     /** pid do processo (undefined se o spawn falhou) */
     readonly pid?: number;
     /** `immediate`: SIGKILL junto com o SIGTERM, sem esperar (fechamento do VS Code, quando não há tempo para o timer). */
     cancel(how?: { immediate?: boolean }): void;
     /** Responde a um pedido de permissão pelo stdin. false se o stdin já não está disponível. */
     respond(requestId: string, decision: PermissionDecision): boolean;
     /** Novo turno no MESMO processo (o CLI segue em --input-format stream-json). false se o stdin já fechou. */
     sendUserMessage(text: string): boolean;
     /** O CLI informou tarefas em segundo plano pendentes. */
     hasBackgroundTasks(): boolean;
     done: Promise<ProcessRunResult>;
   }
   ```
4. Troque o bloco do `emit` (da linha `let closeStdin` até o fim da função `emit`) por:
   ```ts
   let closeStdin: () => void = () => {};
   /** o turno atual já emitiu run_finished (o processo pode seguir vivo por tarefas em segundo plano) */
   let turnOver = false;
   let idleTimer: NodeJS.Timeout | undefined;
   const clearIdle = () => {
     clearTimeout(idleTimer);
     idleTimer = undefined;
   };
   const emit = (events: NormalizedEvent[]) => {
     events.forEach(onEvent);
     if (events.some((e) => e.type === 'run_resumed')) {
       turnOver = false;
       clearIdle();
     }
     // O turno acabou e não há tarefa em segundo plano esperando: sem mais o que responder, fechar o stdin deixa o CLI sair.
     // Com tarefa pendente o processo precisa seguir vivo; o run_finished do turno seguinte fecha.
     if (events.some((e) => e.type === 'run_finished')) {
       turnOver = true;
       if (!adapter.hasBackgroundTasks?.()) closeStdin();
     }
   };
   ```
5. Troque a linha do `createInterface(...)` por:
   ```ts
   createInterface({ input: child.stdout! }).on('line', (line) => {
     emit(adapter.push(line));
     // As tarefas zeraram depois do fim do turno, mas o CLI não abriu turno novo: não deixar o processo vivo para sempre.
     if (turnOver && stdinOpen && !adapter.hasBackgroundTasks?.() && !idleTimer) {
       idleTimer = setTimeout(() => {
         idleTimer = undefined;
         if (turnOver) closeStdin();
       }, opts.lingerCloseMs ?? 30_000);
     }
   });
   ```
6. Em `finish`, depois de `clearTimeout(killTimer);`, acrescente `clearIdle();`.
7. Troque o objeto devolvido (`return { done, respond, cancel }`) por:
   ```ts
   return {
     pid: child.pid,
     done,
     respond(requestId, decision) {
       if (!stdinOpen || !child.stdin || child.stdin.destroyed) return false;
       child.stdin.write(permissionResponseLine(requestId, decision));
       return true;
     },
     sendUserMessage(text) {
       if (!stdinOpen || !child.stdin || child.stdin.destroyed) return false;
       clearIdle();
       turnOver = false;
       child.stdin.write(userMessageLine(text));
       return true;
     },
     hasBackgroundTasks: () => adapter.hasBackgroundTasks?.() ?? false,
     cancel(how) {
       if (child.pid === undefined) return;
       if (cancelled && !how?.immediate) return;
       cancelled = true;
       closeStdin();
       if (isWin) {
         spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
         return;
       }
       const pid = child.pid;
       const kill = (signal: NodeJS.Signals) => {
         try {
           process.kill(-pid, signal);
         } catch {
           /* já terminou */
         }
       };
       kill('SIGTERM');
       if (how?.immediate) {
         kill('SIGKILL');
         return;
       }
       // Se o CLI ignorar o SIGTERM, não deixamos o run pendurado.
       clearTimeout(killTimer);
       killTimer = setTimeout(() => kill('SIGKILL'), opts.cancelGraceMs ?? 3000);
     },
   };
   ```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/cli/process-run.test.ts && npm run typecheck`
Expected: PASS. Se o typecheck reclamar de fakes de `ProcessRun` em `tests/ext/run-controller.test.ts`, a Task 5 resolve isso; por ora, rode só o vitest deste arquivo.

- [ ] **Step 5: Commit**

```bash
git add src/cli/process-run.ts tests/cli/process-run.test.ts
git commit -m "feat(process-run): nova mensagem no processo vivo, cancelamento imediato e fechamento por inatividade"
```

---

### Task 4: Evento `auth_lost` no StreamAdapter

**Files:**
- Modify: `src/core/schema.ts`, `src/core/store.ts`, `src/cli/stream-adapter.ts`
- Create: `fixtures/turns/auth-lost.ndjson`
- Test: `tests/cli/stream-adapter.test.ts`

**Interfaces:**
- Produces: `NormalizedEvent` ganha `{ type: 'auth_lost'; runId: string; ts: number }`. `RunStore.apply` ignora esse evento.

- [ ] **Step 1: Criar a fixture (sanitizada, a partir do spike)**

`fixtures/turns/auth-lost.ndjson`, com exatamente estas 3 linhas:

```
{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-0000000000a1"}
{"type":"assistant","parent_tool_use_id":null,"error":"authentication_failed","message":{"id":"00000000-0000-4000-8000-0000000000a2","model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"session_id":"00000000-0000-4000-8000-0000000000a1"}
{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"00000000-0000-4000-8000-0000000000a1"}
```

- [ ] **Step 2: Escrever os testes**

No topo de `tests/cli/stream-adapter.test.ts`, acrescente `import { readFileSync } from 'node:fs';`. Ao fim do `describe('StreamAdapter', ...)`:

```ts
  describe('auth_lost', () => {
    const authAssistant = L({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
    const authResult = (text = 'Not logged in · Please run /login') => L({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: 's1' });
    const types = (lines: string[]) => {
      const a = new StreamAdapter('r1');
      return lines.flatMap((l) => a.push(l)).map((e) => e.type);
    };

    it('assistant com error "authentication_failed" emite auth_lost uma vez só', () => {
      const t = types([init, authAssistant, authResult()]);
      expect(t.filter((x) => x === 'auth_lost')).toHaveLength(1);
      expect(t.at(-1)).toBe('run_finished');
    });

    it('result com erro de 401 também conta', () => {
      expect(types([init, authResult('Failed to authenticate. API Error: 401 OAuth access token is invalid.')])).toContain('auth_lost');
    });

    it('result sem erro que cita /login não é auth_lost', () => {
      expect(types([init, L({ type: 'result', subtype: 'success', is_error: false, result: 'Please run /login to continue', session_id: 's1' })])).not.toContain('auth_lost');
    });

    it('erro que não é de autenticação não é auth_lost', () => {
      expect(types([init, authResult('Prompt is too long')])).not.toContain('auth_lost');
    });

    it('fixture real (sanitizada): auth_lost e run em error', () => {
      const a = new StreamAdapter('r1');
      const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
      const seen: string[] = [];
      for (const line of readFileSync('fixtures/turns/auth-lost.ndjson', 'utf8').split('\n')) {
        for (const e of a.push(line)) {
          seen.push(e.type);
          s.apply(e);
        }
      }
      expect(seen.filter((x) => x === 'auth_lost')).toHaveLength(1);
      expect(s.run.status).toBe('error');
    });
  });
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run tests/cli/stream-adapter.test.ts`
Expected: FAIL (nenhum `auth_lost` emitido).

- [ ] **Step 4: Implementar**

`src/core/schema.ts`: no union `NormalizedEvent`, antes da linha de `usage`:

```ts
  /** o CLI respondeu que está sem login (ou com o token recusado) neste processo; não pertence ao grafo do run */
  | { type: 'auth_lost'; runId: string; ts: number }
```

`src/core/store.ts`, no `switch` de `apply`, junto de `case 'usage':`:

```ts
      case 'usage':
      case 'auth_lost':
        return;
```

`src/cli/stream-adapter.ts`:

1. Depois dos imports, acrescente:
   ```ts
   /** Texto do `result` de erro quando o CLI está sem login ou com o token recusado (visto no 2.1.287). */
   const AUTH_LOST_TEXT = /not logged in|please run \/login|failed to authenticate|oauth (access )?token (is invalid|has expired)|invalid api key/i;
   ```
2. Na classe, junto de `private backgroundTasks = 0;`:
   ```ts
   private authLostSent = false;
   ```
3. No ramo `else if (m.type === 'assistant' || m.type === 'user') {`, depois de `out.push(...this.start(m.session_id, ts));`:
   ```ts
   if (m.type === 'assistant' && m.error === 'authentication_failed') out.push(...this.authLost(ts));
   ```
4. No ramo `else if (m.type === 'result') {`, depois de `out.push(...this.start(m.session_id, ts));`:
   ```ts
   if (m.is_error && typeof m.result === 'string' && AUTH_LOST_TEXT.test(m.result)) out.push(...this.authLost(ts));
   ```
5. Novo método, ao lado de `hasBackgroundTasks()`:
   ```ts
   /** Uma vez por processo: o host reverifica o login e mostra o aviso. */
   private authLost(ts: number): NormalizedEvent[] {
     if (this.authLostSent) return [];
     this.authLostSent = true;
     return [{ type: 'auth_lost', runId: this.runId, ts }];
   }
   ```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/cli/stream-adapter.test.ts tests/fixtures-clean.test.ts tests/cli/turns.test.ts`
Expected: PASS. O `fixtures-clean` também roda sobre a fixture nova.

- [ ] **Step 6: Commit**

```bash
git add src/core/schema.ts src/core/store.ts src/cli/stream-adapter.ts fixtures/turns/auth-lost.ndjson tests/cli/stream-adapter.test.ts
git commit -m "feat(stream-adapter): evento auth_lost quando o CLI perde o login"
```

---

### Task 5: Controller responde pelo processo vivo (pergunta sempre respondível)

**Files:**
- Modify: `src/ext/run-controller.ts`, `src/core/snapshot.ts`, `src/protocol.ts`, `webview/state.ts` (só um `case` neutro)
- Test: `tests/ext/run-controller.test.ts`

**Interfaces:**
- Consumes: `ProcessRun.sendUserMessage`, `ProcessRun.hasBackgroundTasks`, `ProcessRun.pid` (Task 3).
- Produces:
  - `RunView.lingering?: boolean`. Só aparece quando é `true`: o turno acabou e o processo segue vivo. Nesse estado, `RunView.busy` é `false`.
  - `HostMessage` ganha `{ type: 'answer_ack'; nodeId: string; ok: boolean }`, enviado uma vez por `send`.
  - `toRunView(store, busy?, extra?: { lingering?: boolean; stalled?: boolean })`.
  - Campos internos de `Chat`: `turnOver`, `activeOptions`, `turn`, `replacing`. As Tasks 6 e 7 acrescentam outros.

- [ ] **Step 1: Atualizar o fake e escrever os testes**

Em `tests/ext/run-controller.test.ts`:

1. Em `interface FakeRun`, acrescente:
   ```ts
   sendUserMessage: ReturnType<typeof vi.fn>;
   hasBackgroundTasks: ReturnType<typeof vi.fn>;
   ```
2. No `startRun` do `setup`, troque o corpo por:
   ```ts
   const cancel = vi.fn();
   const respond = vi.fn(() => true);
   const sendUserMessage = vi.fn(() => true);
   const hasBackgroundTasks = vi.fn(() => false);
   const pid = 1000 + runs.length;
   let finish: (r: ProcessRunResult) => void = () => {};
   const done = new Promise<ProcessRunResult>((res) => (finish = res));
   runs.push({ runId, opts, emit: on, finish: (r) => finish(r ?? result()), cancel, respond, sendUserMessage, hasBackgroundTasks });
   return { pid, cancel, respond, sendUserMessage, hasBackgroundTasks, done };
   ```
3. Depois de `waitingChat`, acrescente os helpers:
   ```ts
   /** chat que terminou o turno com uma pergunta, mas cujo processo segue vivo (tarefa em segundo plano) */
   async function lingeringChat(t: T) {
     const done = (await startChat(t)).done;
     const run = t.runs.at(-1)!;
     run.hasBackgroundTasks.mockReturnValue(true);
     run.emit(init(run.runId));
     run.emit(finishedWithQuestion(run.runId, Q));
     await t.tick();
     return { run, done, runId: run.runId };
   }
   const acks = (t: T) => t.posted.filter((m) => m.type === 'answer_ack') as Extract<HostMessage, { type: 'answer_ack' }>[];
   ```
4. Ao fim do arquivo:
   ```ts
   describe('RunController: processo vivo depois do fim do turno', () => {
     it('a pergunta fica respondível: busy false e lingering true', async () => {
       const t = setup();
       const { runId } = await lingeringChat(t);
       const v = t.view(runId);
       expect(v.status).toBe('waiting');
       expect(v.busy).toBe(false);
       expect(v.lingering).toBe(true);
     });

     it('responder escreve no stdin do processo vivo, sem processo novo', async () => {
       const t = setup();
       const { run, runId } = await lingeringChat(t);
       await t.c.handle({ type: 'send', nodeId: `${runId}:root`, text: 'Azul' });
       await t.tick();
       expect(run.sendUserMessage).toHaveBeenCalledWith('Azul');
       expect(t.startRun).toHaveBeenCalledTimes(1);
       expect(t.view(runId).status).toBe('running');
       expect(t.view(runId).lingering).toBeUndefined();
       expect(acks(t).at(-1)).toEqual({ type: 'answer_ack', nodeId: `${runId}:root`, ok: true });
     });

     it('stdin já fechado (processo saindo): espera o processo sair e retoma com --resume', async () => {
       const t = setup();
       const { run, runId } = await lingeringChat(t);
       run.sendUserMessage.mockReturnValue(false);
       run.hasBackgroundTasks.mockReturnValue(false);
       const p = t.c.handle({ type: 'send', nodeId: `${runId}:root`, text: 'Azul' });
       await t.tick();
       expect(t.startRun).toHaveBeenCalledTimes(1);
       run.finish(result({ cancelled: true }));
       await t.tick();
       expect(t.startRun).toHaveBeenCalledTimes(2);
       expect(t.runs[1]!.opts.args).toContain('--resume');
       expect(promptOf(t.runs[1]!.opts)).toBe('Azul');
       expect(t.notices().some((n) => n.text.includes('Execução cancelada'))).toBe(false);
       t.runs[1]!.finish();
       await p;
     });

     it('opções trocadas com tarefa em segundo plano: interrompe, avisa e retoma num processo novo', async () => {
       const t = setup();
       const { run, runId } = await lingeringChat(t);
       await t.c.handle({ type: 'setOptions', runId, options: { model: 'opus' } });
       const p = t.c.handle({ type: 'send', nodeId: `${runId}:root`, text: 'Azul' });
       await t.tick();
       expect(run.sendUserMessage).not.toHaveBeenCalled();
       expect(run.cancel).toHaveBeenCalled();
       expect(t.notices().some((n) => /segundo plano/.test(n.text))).toBe(true);
       run.finish(result({ cancelled: true }));
       await t.tick();
       expect(t.startRun).toHaveBeenCalledTimes(2);
       expect(t.runs[1]!.opts.args).toEqual(expect.arrayContaining(['--model', 'opus']));
       expect(t.notices().some((n) => n.text.includes('Execução cancelada'))).toBe(false);
       t.runs[1]!.finish();
       await p;
     });

     it('send para node inexistente devolve answer_ack ok false', async () => {
       const t = setup();
       await t.c.handle({ type: 'send', nodeId: 'nada:root', text: 'oi' });
       expect(acks(t)).toEqual([{ type: 'answer_ack', nodeId: 'nada:root', ok: false }]);
     });

     it('turno retomado normal confirma com answer_ack ok true quando o processo inicia', async () => {
       const t = setup();
       const runId = await waitingChat(t);
       const p = t.c.handle({ type: 'send', nodeId: `${runId}:root`, text: 'Azul' });
       await t.tick();
       expect(acks(t).at(-1)).toEqual({ type: 'answer_ack', nodeId: `${runId}:root`, ok: true });
       t.runs[1]!.finish();
       await p;
     });

     it('"Marcar como concluído" funciona com o processo vivo', async () => {
       const t = setup();
       const { runId } = await lingeringChat(t);
       await t.c.handle({ type: 'markDone', runId });
       expect(t.view(runId).status).toBe('done');
     });
   });
   ```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/run-controller.test.ts`
Expected: os testes novos FALHAM (`lingering` indefinido, `sendUserMessage` não chamado, nenhum `answer_ack`). Os antigos continuam passando.

- [ ] **Step 3: Protocolo e snapshot**

`src/protocol.ts`, em `RunView`, depois de `busy: boolean;`:

```ts
  /** O agente terminou o turno, mas o processo segue vivo (tarefas em segundo plano): dá para responder (vai pelo stdin). */
  lingering?: boolean;
```

Em `HostMessage`, antes de `| { type: 'notice'; ... }`:

```ts
  /** resultado de um `send`: ok = a mensagem foi entregue a um processo (novo ou vivo) */
  | { type: 'answer_ack'; nodeId: string; ok: boolean }
```

`src/core/snapshot.ts`, troque a assinatura e o começo do objeto de `toRunView`:

```ts
export function toRunView(store: RunStore, busy = false, extra: { lingering?: boolean; stalled?: boolean } = {}): RunView {
  return {
    id: store.run.id,
    title: store.run.title,
    ...(store.run.options ? { options: store.run.options } : {}),
    busy,
    ...(extra.lingering ? { lingering: true } : {}),
    ...(extra.stalled ? { stalled: true } : {}),
```

(`stalled` entra no `RunView` na Task 6. Até lá, o typecheck reclama do campo, então acrescente já em `RunView`, logo depois de `lingering`:)

```ts
  /** Watchdog: com o turno encerrado, o processo vivo ficou sem dar sinal por `visor.lingerTimeoutMinutes`. */
  stalled?: boolean;
```

`webview/state.ts`, no `switch` de `reduce`, antes de `case 'dismiss':`:

```ts
    case 'answer_ack':
      return state;
```

- [ ] **Step 4: Controller**

Em `src/ext/run-controller.ts`:

1. Em `interface Chat`, depois de `pending`:
   ```ts
   /** o processo ativo já emitiu o fim do turno, mas segue vivo (tarefas em segundo plano) */
   turnOver: boolean;
   /** opções com que o processo ativo foi iniciado (a resposta pelo stdin só vale se não mudaram) */
   activeOptions?: string;
   /** termina quando o turno em andamento termina (para esperar o processo sair antes de retomar) */
   turn?: Promise<void>;
   /** o processo ativo está sendo trocado por outro: o cancelamento não é da pessoa, então sem aviso */
   replacing?: boolean;
   ```
2. Em `interface Turn`, acrescente:
   ```ts
   /** node que enviou a mensagem: recebe um answer_ack */
   ack?: string;
   ```
3. Em `postSnapshot`, troque `toRunView(c.store, c.busy)` por:
   ```ts
   toRunView(c.store, c.busy && !c.turnOver, { lingering: c.busy && c.turnOver })
   ```
4. Em `markDone`, troque a condição por:
   ```ts
   if (!chat || (chat.busy && !chat.turnOver) || chat.store.run.status !== 'waiting') return;
   ```
5. Em `startChat`, troque a criação do chat por:
   ```ts
   chat = { store, busy: true, cancelRequested: false, pending: new Map(), turnOver: false };
   ```
6. Troque o método `send` inteiro por:
   ```ts
   private async send(nodeId: string, text: string, attachmentPaths?: string[]): Promise<void> {
     const chat = this.chatOfNode(nodeId);
     const node = chat?.store.nodes.get(nodeId);
     if (!chat || !node) {
       this.notice('error', 'Não encontrei esse node para enviar a mensagem.');
       this.deps.post({ type: 'answer_ack', nodeId, ok: false });
       return;
     }
     const files = await this.resolveAttachments(attachmentPaths, chat);
     if (!files) {
       this.deps.post({ type: 'answer_ack', nodeId, ok: false });
       return;
     }
     const names = files.map((f) => f.name);
     const echo = { nodeId, text, ...(names.length ? { attachments: names } : {}) };
     const message = withAttachments(text, files);
     if (node.parentId === null) return this.runTurn(chat, { prompt: message, fresh: false, echo, attachments: files, ack: nodeId });
     // Com o agentId dá para pedir a continuação exata; sem ele só dá para pedir ao orquestrador que tente.
     const prompt = node.agentId
       ? `Send a follow-up to the existing "${node.agentType}" subagent (agentId ${node.agentId}) using the SendMessage tool, ` +
         `with exactly this message. Do not start a new subagent. Then report what it replied.\n\nMessage:\n${message}`
       : `Continue the work of the "${node.agentType}" subagent you started earlier, passing it exactly this message ` +
         `(if you cannot continue it, start a new "${node.agentType}" subagent). Then report what it replied.\n\nMessage:\n${message}`;
     return this.runTurn(chat, { prompt, fresh: false, echo, attachments: files, ack: nodeId });
   }
   ```
7. Logo antes de `private async runTurn`, acrescente:
   ```ts
   private applyEcho(store: RunStore, t: Turn): void {
     if (!t.echo) return;
     store.apply({
       type: 'node_event', runId: store.run.id, nodeId: t.echo.nodeId, kind: 'message',
       payload: { role: 'user', text: t.echo.text, ...(t.echo.attachments?.length ? { attachments: t.echo.attachments } : {}) }, ts: Date.now(),
     });
   }

   /**
    * O turno acabou, mas o processo segue vivo (tarefas em segundo plano): a resposta vai pelo stdin dele, sem matar as tarefas.
    * Se o stdin já fechou, ou se a resposta precisa de opções/anexos que o processo não tem, encerra-o e retoma num processo novo.
    */
   private async answerLive(chat: Chat, t: Turn): Promise<void> {
     const store = chat.store;
     const active = chat.active!;
     const sameOptions = chat.activeOptions === JSON.stringify(store.run.options ?? {});
     const newRules = outsideFiles(t.attachments ?? [], store.run.cwd).length > 0;
     if (sameOptions && !newRules && active.sendUserMessage(t.prompt)) {
       this.applyEcho(store, t);
       store.apply({ type: 'run_resumed', runId: store.run.id, ts: Date.now() });
       chat.turnOver = false;
       this.dirty.add(store.run.id);
       if (t.ack) this.deps.post({ type: 'answer_ack', nodeId: t.ack, ok: true });
       this.flush();
       return;
     }
     if (active.hasBackgroundTasks()) {
       this.notice('info', 'Havia tarefas em segundo plano neste chat: elas foram interrompidas para enviar a resposta num processo novo.', chat);
     }
     chat.replacing = true;
     active.cancel();
     await chat.turn;
     chat.replacing = false;
     return this.runTurn(chat, t);
   }
   ```
8. Troque o método `runTurn` inteiro por:
   ```ts
   /** Um turno do chat: o primeiro (fresh) ou uma continuação da mesma sessão (--resume). */
   private async runTurn(chat: Chat, t: Turn): Promise<void> {
     const store = chat.store;
     let acked = false;
     const ack = (ok: boolean) => {
       if (acked || !t.ack) return;
       acked = true;
       this.deps.post({ type: 'answer_ack', nodeId: t.ack, ok });
     };
     if (!t.fresh) {
       if (chat.busy) {
         if (chat.turnOver && chat.active) return this.answerLive(chat, t);
         this.notice('warn', 'Esta conversa ainda está executando. Cancele-a ou espere terminar.', chat);
         ack(false);
         return;
       }
       chat.busy = true;
       chat.cancelRequested = false;
       this.postSnapshot(); // a Webview passa a saber que este chat está ocupado
     }
     let release!: () => void;
     chat.turn = new Promise<void>((r) => (release = r));
     try {
       const settings = this.deps.settings();
       const options = store.run.options;
       const cli: CliId = options?.cli ?? 'claude';
       const effectiveMode = options?.permissionMode ?? settings.permissionMode;
       let resume: ResumeSeed | undefined;
       let sessionId: string | undefined;

       if (!t.fresh) {
         sessionId = store.run.sessionId;
         if (!sessionId) {
           this.notice('error', 'Não há uma sessão para continuar nesta conversa. Inicie uma execução primeiro.', chat);
           ack(false);
           return;
         }
         // Em turnos retomados reaproveita o diagnóstico do CLI, para não pagar duas chamadas a cada mensagem.
         const known = this.lastChecks.get(cli);
         if (!(known && (known.state === 'ok' || known.state === 'unknown'))) {
           const check = await this.deps.detect(cli === 'codex' ? settings.codexPath : settings.claudePath, cli);
           this.lastChecks.set(cli, check);
           this.deps.post({ type: 'cli', check, cli });
           if (this.blockedByCli(check, cli, chat)) {
             ack(false);
             return;
           }
         }
         if (chat.cancelRequested) {
           this.notice('info', 'Execução cancelada.', chat);
           ack(false);
           return;
         }
         const nodes = cli === 'codex' ? [] : [...store.nodes.values()].filter((n) => n.invocationId);
         resume = {
           subagents: nodes.map((n) => n.invocationId!),
           tasks: Object.fromEntries(nodes.filter((n) => n.agentId).map((n) => [n.agentId!, n.invocationId!])),
         };
         this.applyEcho(store, t);
         if (cli === 'claude') this.noticeOutside(t.attachments ?? [], store.run.cwd, chat);
         // O loading aparece na hora, antes de o processo emitir o primeiro evento.
         store.apply({ type: 'run_resumed', runId: store.run.id, ts: Date.now() });
         this.dirty.add(store.run.id);
         this.warnIfManyInParallel(settings);
       }

       let command: string;
       let args: string[];
       let input: string | undefined;
       if (cli === 'codex') {
         command = settings.codexPath;
         // O Codex não tem --append-system-prompt: a instrução de pergunta vai no começo da primeira mensagem
         // (a sessão guarda o contexto, então não se repete nas retomadas).
         args = buildCodexArgs({
           prompt: t.fresh ? `${QUESTION_INSTRUCTION}\n\n${t.prompt}` : t.prompt,
           sandbox: options?.sandbox ?? settings.codexSandbox,
           ...(options?.model ? { model: options.model } : {}),
           ...(options?.effort ? { effort: options.effort } : {}),
           ...(sessionId ? { resume: sessionId } : {}),
         });
       } else {
         command = settings.claudePath;
         input = userMessageLine(t.prompt);
         args = buildClaudeArgs({
           permissionMode: effectiveMode,
           // Só LEITURA dos anexos de fora do projeto, e só nesta mensagem (nunca a pasta pai, nunca escrita).
           allowedTools: [...settings.allowedTools, ...outsideFiles(t.attachments ?? [], store.run.cwd).map(readRule)],
           disallowedTools: settings.disallowedTools,
           ...(options?.model ? { model: options.model } : {}),
           ...(options?.effort ? { effort: options.effort } : {}),
           resume: sessionId,
           appendSystemPrompt: QUESTION_INSTRUCTION,
         });
       }
       chat.turnOver = false;
       chat.activeOptions = JSON.stringify(options ?? {});
       const run: ProcessRun = this.deps.startRun(
         store.run.id,
         {
           command, args, cwd: store.run.cwd,
           ...(cli === 'codex' ? { adapter: 'codex' as const } : {}),
           ...(input !== undefined ? { input } : {}),
           ...(resume ? { resume } : {}),
         },
         (e) => {
           if (e.type === 'usage') {
             this.deps.post({ type: 'usage', ...(e.fiveHour !== undefined ? { fiveHour: e.fiveHour } : {}), ...(e.sevenDay !== undefined ? { sevenDay: e.sevenDay } : {}), ...(e.fiveHourResetsAt !== undefined ? { fiveHourResetsAt: e.fiveHourResetsAt } : {}), ...(e.sevenDayResetsAt !== undefined ? { sevenDayResetsAt: e.sevenDayResetsAt } : {}) });
             return;
           }
           if (e.type === 'permission_request') chat.pending.set(e.requestId, e);
           // Só o processo atual decide se o turno acabou (um processo antigo, sendo trocado, não conta).
           if (chat.active === run) {
             if (e.type === 'run_finished') chat.turnOver = true;
             if (e.type === 'run_resumed') chat.turnOver = false;
           }
           store.apply(e);
           this.dirty.add(store.run.id);
           this.schedule();
         },
       );
       chat.active = run;
       ack(true);
       this.postSnapshot();

       const result = await run.done;
       chat.active = undefined;
       chat.turnOver = false;
       this.dropPendingPermissions(chat);
       this.flush();

       if (result.cancelled) {
         if (!chat.replacing) this.notice('info', 'Execução cancelada.', chat);
       } else if (result.spawnError) {
         this.notice('error', `Não consegui executar o CLI: ${result.spawnError}`, chat);
       } else if (store.run.status === 'error') {
         // O Codex informa o motivo num evento de erro; o stderr dele só tem ruído. Sem evento, vale o stderr.
         const reason = lastErrorEvent(store) ?? result.stderrTail.trim().slice(-500);
         this.notice('error', `A execução terminou com erro (código ${result.exitCode}).${reason ? ` ${reason}` : ''}`, chat);
       }
     } catch (err) {
       ack(false);
       chat.active = undefined;
       chat.turnOver = false;
       this.dropPendingPermissions(chat);
       this.closeStore(chat);
       this.notice('error', `Falha inesperada: ${err instanceof Error ? err.message : String(err)}`, chat);
     } finally {
       chat.busy = false;
       chat.cancelRequested = false;
       this.dirty.add(store.run.id);
       if (this.chats.get(store.run.id) === chat) this.flush();
       release();
     }
   }
   ```

> Note: no `catch` do `startChat`, a linha `chat.active = undefined;` continua igual. `ProcessRun` já está importado como tipo.

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/ext/run-controller.test.ts tests/core/snapshot.test.ts && npm run typecheck`
Expected: PASS. Se algum teste antigo comparar a lista inteira de `posted` e agora vir um `answer_ack` a mais, ajuste esse teste para filtrar por tipo, como os helpers `snaps()`/`notices()` já fazem. Não mude o comportamento.

- [ ] **Step 6: Commit**

```bash
git add src/ext/run-controller.ts src/core/snapshot.ts src/protocol.ts webview/state.ts tests/ext/run-controller.test.ts
git commit -m "fix: pergunta respondível com o processo vivo (resposta pelo stdin) e answer_ack"
```

---

### Task 6: Watchdog de processo parado

**Files:**
- Modify: `src/ext/run-controller.ts`, `src/protocol.ts`
- Test: `tests/ext/run-controller.test.ts`, `tests/protocol.test.ts`

**Interfaces:**
- Consumes: `VisorSettings.lingerTimeoutMinutes` (Task 1), `DiagLog`/`NO_LOG` (Task 2), `RunView.stalled` (Task 5).
- Produces: `ControllerDeps.log?: DiagLog`; `WebviewMessage` ganha `{ type: 'keepWaiting'; runId: string }`; `RunView.stalled === true` quando o watchdog dispara.

- [ ] **Step 1: Escrever os testes**

`tests/protocol.test.ts`, ao lado dos outros casos de `parseWebviewMessage`:

```ts
  it('keepWaiting exige runId válido', () => {
    expect(parseWebviewMessage({ type: 'keepWaiting', runId: 'r1' })).toEqual({ type: 'keepWaiting', runId: 'r1' });
    expect(parseWebviewMessage({ type: 'keepWaiting' })).toBeNull();
    expect(parseWebviewMessage({ type: 'keepWaiting', runId: '' })).toBeNull();
  });
```

(Se o arquivo não importar `parseWebviewMessage`, acrescente `import { parseWebviewMessage } from '../src/protocol';`.)

`tests/ext/run-controller.test.ts`, ao fim:

```ts
describe('RunController: watchdog do processo parado', () => {
  const FAST = { lingerTimeoutMinutes: 0.001 }; // 60 ms

  it('sem eventos depois do fim do turno, marca stalled', async () => {
    const t = setup({}, FAST);
    const { runId } = await lingeringChat(t);
    await t.tick(120);
    expect(t.view(runId).stalled).toBe(true);
  });

  it('evento novo do processo adia o aviso', async () => {
    const t = setup({}, FAST);
    const { run, runId } = await lingeringChat(t);
    await t.tick(30);
    run.emit(msg(runId, 'ainda aqui'));
    await t.tick(30);
    run.emit(msg(runId, 'ainda aqui 2'));
    await t.tick(30);
    expect(t.view(runId).stalled).toBeUndefined();
  });

  it('keepWaiting limpa o aviso e rearma', async () => {
    const t = setup({}, FAST);
    const { runId } = await lingeringChat(t);
    await t.tick(120);
    await t.c.handle({ type: 'keepWaiting', runId });
    await t.tick(10);
    expect(t.view(runId).stalled).toBeUndefined();
    await t.tick(120);
    expect(t.view(runId).stalled).toBe(true);
  });

  it('com permissão pendente não marca stalled (o processo espera a pessoa)', async () => {
    const t = setup({}, FAST);
    const { run, runId } = await lingeringChat(t);
    run.emit({ type: 'permission_request', runId, nodeId: `${runId}:root`, requestId: 'q1', tool: 'Bash', input: {}, suggestions: [], ts: 9 });
    await t.tick(120);
    expect(t.view(runId).stalled).toBeUndefined();
  });

  it('lingerTimeoutMinutes 0 desliga', async () => {
    const t = setup({}, { lingerTimeoutMinutes: 0 });
    const { runId } = await lingeringChat(t);
    await t.tick(120);
    expect(t.view(runId).stalled).toBeUndefined();
  });

  it('quando o processo sai, o aviso some', async () => {
    const t = setup({}, FAST);
    const { run, runId, done } = await lingeringChat(t);
    await t.tick(120);
    run.finish();
    await done;
    expect(t.view(runId).stalled).toBeUndefined();
  });

  it('registra stall no log', async () => {
    const lines: string[] = [];
    const t = setup({ log: { info: (e) => lines.push(e), debug: () => {}, debugEnabled: () => false } }, FAST);
    await lingeringChat(t);
    await t.tick(120);
    expect(lines).toContain('stall');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/run-controller.test.ts tests/protocol.test.ts`
Expected: FAIL (`stalled` nunca é marcado; `keepWaiting` é rejeitado).

- [ ] **Step 3: Protocolo**

`src/protocol.ts`, em `WebviewMessage`, depois da linha de `permission`:

```ts
  /** o watchdog avisou que o processo parou; a pessoa prefere esperar mais */
  | { type: 'keepWaiting'; runId: string }
```

Em `parseWebviewMessage`, depois de `case 'markDone':`:

```ts
    case 'keepWaiting':
      return validNodeId(m.runId) ? { type: 'keepWaiting', runId: m.runId } : null;
```

- [ ] **Step 4: Controller**

Em `src/ext/run-controller.ts`:

1. Import: `import { NO_LOG, type DiagLog } from './diag-log';`
2. Em `ControllerDeps`, depois de `newRunId?(): string;`:
   ```ts
   /** log de diagnóstico (canal "Visor"); ausente nos testes que não o verificam */
   log?: DiagLog;
   ```
3. Em `interface Chat`:
   ```ts
   /** watchdog: com o turno encerrado, o processo vivo ficou sem dar sinal */
   stalled?: boolean;
   stallTimer?: NodeJS.Timeout;
   ```
4. Na classe, depois do `constructor`:
   ```ts
   private get log(): DiagLog {
     return this.deps.log ?? NO_LOG;
   }
   ```
5. Em `handle`, depois do `case 'markDone':`:
   ```ts
   case 'keepWaiting': {
     const chat = this.chats.get(msg.runId);
     if (!chat) return;
     this.clearStall(chat);
     this.armStall(chat);
     this.flush();
     return;
   }
   ```
6. Em `postSnapshot`, troque o `toRunView(...)` por:
   ```ts
   toRunView(c.store, c.busy && !c.turnOver, { lingering: c.busy && c.turnOver, stalled: !!c.stalled })
   ```
7. Novos métodos, ao lado de `dropPendingPermissions`:
   ```ts
   /** Rearma o watchdog a cada sinal do processo; só conta com o turno encerrado e o processo vivo. */
   private armStall(chat: Chat): void {
     clearTimeout(chat.stallTimer);
     chat.stallTimer = undefined;
     const minutes = this.deps.settings().lingerTimeoutMinutes;
     if (!chat.turnOver || !chat.active || minutes <= 0) return;
     chat.stallTimer = setTimeout(() => {
       chat.stallTimer = undefined;
       // Com permissão pendente o processo espera a pessoa, não está travado.
       if (!chat.turnOver || !chat.active || chat.pending.size > 0) return;
       chat.stalled = true;
       this.log.info('stall', { runId: chat.store.run.id.slice(0, 8), pid: chat.active.pid, minutes });
       this.dirty.add(chat.store.run.id);
       this.flush();
     }, minutes * 60_000);
   }

   private clearStall(chat: Chat): void {
     clearTimeout(chat.stallTimer);
     chat.stallTimer = undefined;
     if (chat.stalled) {
       chat.stalled = false;
       this.dirty.add(chat.store.run.id);
     }
   }
   ```
8. No `onEvent` de `runTurn`, depois do bloco `if (chat.active === run) { ... }`:
   ```ts
   if (chat.active === run) {
     this.clearStall(chat);
     this.armStall(chat);
   }
   ```
9. Em `answerLive`, no caminho do stdin, depois de `chat.turnOver = false;`:
   ```ts
   this.clearStall(chat);
   this.armStall(chat);
   ```
10. Em `answerPermission`, depois de `chat.pending.delete(requestId);`:
    ```ts
    this.armStall(chat);
    ```
11. Em `runTurn`, depois de `const result = await run.done;` e de `chat.turnOver = false;`:
    ```ts
    this.clearStall(chat);
    ```
    E no `catch` de `runTurn`, depois de `chat.turnOver = false;`:
    ```ts
    this.clearStall(chat);
    ```
12. Em `dispose()`, antes de `this.cancelAll();`:
    ```ts
    for (const chat of this.chats.values()) clearTimeout(chat.stallTimer);
    ```

> Note: o watchdog é armado no `onEvent` *depois* de o `run_finished` virar `turnOver = true`. Por isso o primeiro disparo conta a partir do fim do turno.

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run tests/ext/run-controller.test.ts tests/protocol.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ext/run-controller.ts src/protocol.ts tests/ext/run-controller.test.ts tests/protocol.test.ts
git commit -m "feat: watchdog avisa quando o processo fica parado depois do fim do turno"
```

---

### Task 7: Login perdido, reverificação depois de erro e logs do turno

**Files:**
- Modify: `src/ext/run-controller.ts`
- Test: `tests/ext/run-controller.test.ts`

**Interfaces:**
- Consumes: evento `auth_lost` (Task 4), `DiagLog` (Tasks 2 e 6), `answerLive` (Task 5).
- Produces: o campo interno `Chat.authLost?: boolean`. No log, os eventos `result`, `auth_lost` e `snapshot` (debug).

- [ ] **Step 1: Escrever os testes**

```ts
describe('RunController: login perdido no meio da sessão', () => {
  const authLost = (runId: string): NormalizedEvent => ({ type: 'auth_lost', runId, ts: 2 });
  const clis = (t: T) => t.posted.filter((m) => m.type === 'cli') as Extract<HostMessage, { type: 'cli' }>[];

  it('auth_lost mostra o banner de login e avisa no chat', async () => {
    const detect = vi.fn(async (): Promise<CliCheck> => OK);
    const t = setup({ detect });
    const p = (await startChat(t)).done;
    const run = t.runs[0]!;
    detect.mockResolvedValueOnce({ state: 'not_authenticated', version: '2.1.287', message: 'login' });
    run.emit(init(run.runId));
    run.emit(authLost(run.runId));
    await t.tick();
    expect(clis(t).some((m) => m.check.state === 'not_authenticated')).toBe(true);
    expect(t.notices().some((n) => n.level === 'error' && n.text.includes('Not logged in'))).toBe(true);
    run.finish();
    await p;
  });

  it('se o CLI diz que o login está ok, o banner some e pede para enviar de novo', async () => {
    const t = setup();
    const p = (await startChat(t)).done;
    const run = t.runs[0]!;
    run.emit(init(run.runId));
    run.emit(authLost(run.runId));
    await t.tick();
    expect(clis(t).at(-1)!.check.state).toBe('ok');
    expect(t.notices().some((n) => n.text.includes('login do CLI está ok'))).toBe(true);
    run.finish();
    await p;
  });

  it('vários auth_lost ao mesmo tempo fazem uma só reverificação', async () => {
    const detect = vi.fn(async (): Promise<CliCheck> => OK);
    const t = setup({ detect });
    const a = (await startChat(t)).done;
    const b = (await startChat(t)).done;
    const before = detect.mock.calls.length;
    for (const run of t.runs) run.emit(authLost(run.runId));
    await t.tick();
    expect(detect.mock.calls.length - before).toBe(1);
    for (const run of t.runs) run.finish();
    await Promise.all([a, b]);
  });

  it('depois de auth_lost, a resposta não vai pelo stdin do processo quebrado', async () => {
    const t = setup();
    const { run, runId } = await lingeringChat(t);
    run.emit(authLost(runId));
    await t.tick();
    const p = t.c.handle({ type: 'send', nodeId: `${runId}:root`, text: 'Azul' });
    await t.tick();
    expect(run.sendUserMessage).not.toHaveBeenCalled();
    run.finish(result({ cancelled: true }));
    await t.tick();
    expect(t.startRun).toHaveBeenCalledTimes(2);
    t.runs[1]!.finish();
    await p;
  });

  it('turno que terminou em erro faz o próximo turno reverificar o CLI', async () => {
    const detect = vi.fn(async (): Promise<CliCheck> => OK);
    const t = setup({ detect });
    const p = (await startChat(t)).done;
    const run = t.runs[0]!;
    run.emit(init(run.runId));
    run.emit({ type: 'run_finished', runId: run.runId, status: 'error', ts: 3 });
    run.finish(result({ exitCode: 1 }));
    await p;
    const before = detect.mock.calls.length;
    const p2 = t.c.handle({ type: 'send', nodeId: `${run.runId}:root`, text: 'de novo' });
    await t.tick();
    expect(detect.mock.calls.length).toBe(before + 1);
    t.runs[1]!.finish();
    await p2;
  });

  it('registra o result com a flag de tarefas em segundo plano', async () => {
    const lines: string[] = [];
    const t = setup({ log: { info: (e, f) => lines.push(`${e} ${JSON.stringify(f)}`), debug: () => {}, debugEnabled: () => false } });
    await lingeringChat(t);
    expect(lines.some((l) => l.startsWith('result ') && l.includes('"bg":true') && l.includes('"question":true'))).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/run-controller.test.ts`
Expected: os testes novos FALHAM. Hoje `auth_lost` só passa pelo `store.apply`, que o ignora.

- [ ] **Step 3: Implementar**

Em `src/ext/run-controller.ts`:

1. Na classe, junto de `private readonly capsInflight ...`:
   ```ts
   /** reverificação do login em voo (vários chats perdendo o login ao mesmo tempo dividem uma só) */
   private authRecheck?: Promise<void>;
   ```
2. Em `interface Chat`:
   ```ts
   /** o processo ativo respondeu "sem login": a próxima mensagem vai para um processo novo */
   authLost?: boolean;
   ```
3. Novo método, ao lado de `blockedByCli`:
   ```ts
   /** O CLI respondeu "Not logged in" (ou 401) neste processo: banner de login, aviso no chat e uma reverificação. */
   private onAuthLost(chat: Chat): void {
     chat.authLost = true;
     this.log.info('auth_lost', { runId: chat.store.run.id.slice(0, 8), pid: chat.active?.pid });
     const prev = this.lastChecks.get('claude');
     const check: CliCheck = {
       state: 'not_authenticated',
       version: prev && 'version' in prev ? prev.version : '',
       message: 'O Claude Code perdeu o login neste processo (o terminal pode continuar logado). Clique em Verificar de novo; se continuar, faça login.',
     };
     this.lastChecks.set('claude', check);
     this.deps.post({ type: 'cli', check, cli: 'claude' });
     this.notice('error', 'O Claude Code respondeu "Not logged in". Use o aviso no topo: Verificar de novo / Fazer login.', chat);
     if (this.authRecheck) return;
     this.authRecheck = this.checkCli('claude')
       .then((c) => {
         this.deps.post({ type: 'cli', check: c, cli: 'claude' });
         if (c.state === 'ok') this.notice('info', 'Claude Code: o login do CLI está ok. Envie a mensagem de novo (o próximo turno usa um processo novo).');
       }, () => undefined)
       .finally(() => {
         this.authRecheck = undefined;
       });
   }
   ```
4. No `onEvent` de `runTurn`, logo depois do bloco `if (e.type === 'usage') { ... return; }`:
   ```ts
   if (e.type === 'auth_lost') {
     this.onAuthLost(chat);
     return;
   }
   if (e.type === 'run_finished' && chat.active === run) {
     this.log.info('result', { runId: store.run.id.slice(0, 8), pid: run.pid, status: e.status, bg: run.hasBackgroundTasks(), question: !!e.question });
   }
   ```
5. Em `answerLive`, troque a condição do caminho do stdin por:
   ```ts
   if (sameOptions && !newRules && !chat.authLost && active.sendUserMessage(t.prompt)) {
   ```
6. Em `runTurn`, junto de `chat.turnOver = false;` e `chat.activeOptions = ...` (antes do `startRun`):
   ```ts
   chat.authLost = false;
   ```
7. Em `runTurn`, depois do bloco `if (result.cancelled) { ... } else if ... { ... }`:
   ```ts
   // Turno com erro: o próximo reconfere o CLI (o login pode ter caído no meio).
   if (store.run.status === 'error') this.lastChecks.delete(cli);
   ```
8. Medição do snapshot (H4), em `postSnapshot`: troque a primeira linha por:
   ```ts
   const t0 = Date.now();
   const runs = [...this.chats.values()].map((c) => toRunView(c.store, c.busy && !c.turnOver, { lingering: c.busy && c.turnOver, stalled: !!c.stalled }));
   this.deps.post({ type: 'snapshot', runs });
   if (this.log.debugEnabled()) {
     this.log.debug('snapshot', { chats: runs.length, bytes: JSON.stringify(runs).length, ms: Date.now() - t0 });
   }
   ```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/ext/run-controller.test.ts && npm run typecheck`
Expected: PASS. O teste antigo "turno retomado reaproveita o diagnóstico do CLI" (se existir) continua passando, porque só turnos com erro apagam o cache.

- [ ] **Step 5: Commit**

```bash
git add src/ext/run-controller.ts tests/ext/run-controller.test.ts
git commit -m "fix: reconhece o login perdido no meio da sessão e reconfere o CLI depois de erro"
```

---

### Task 8: Registro de processos e limpeza de órfãos

**Files:**
- Create: `src/ext/process-registry.ts`
- Test: `tests/ext/process-registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProcEntry { pid: number; owner: number; startedAt: number; signature: string }
  export interface RegistryOs { commandOf(pid: number): string | undefined; isAlive(pid: number): boolean; killGroup(pid: number, signal: NodeJS.Signals): void; later(fn: () => void, ms: number): void }
  export class ProcessRegistry { constructor(file: string, os: RegistryOs, owner: number); add(e: Omit<ProcEntry, 'owner'>): void; remove(pid: number): void; get size(): number; reapOrphans(): number }
  export const nodeRegistryOs: RegistryOs;
  export function signatureOf(args: string[]): string;
  ```

- [ ] **Step 1: Escrever o teste**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessRegistry, signatureOf, type RegistryOs } from '../../src/ext/process-registry';

const SIG = '-p --output-format stream-json';

function fakeOs(procs: Record<number, string>, alive: number[] = []) {
  const killed: [number, string][] = [];
  const later: (() => void)[] = [];
  const o: RegistryOs = {
    commandOf: (pid) => procs[pid],
    isAlive: (pid) => alive.includes(pid) || pid in procs,
    killGroup: (pid, signal) => { killed.push([pid, signal]); },
    later: (fn) => { later.push(fn); },
  };
  return { o, killed, runLater: () => later.splice(0).forEach((f) => f()) };
}
const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'visor-reg-')), 'sub', 'processes.json');

describe('ProcessRegistry', () => {
  it('signatureOf usa os 3 primeiros argumentos (nunca o prompt)', () => {
    expect(signatureOf(['-p', '--output-format', 'stream-json', '--verbose'])).toBe(SIG);
    expect(signatureOf(['exec', '--json', '--skip-git-repo-check', '-s', 'x', '--', 'prompt secreto'])).toBe('exec --json --skip-git-repo-check');
  });

  it('add/remove gravam no arquivo (criando a pasta)', () => {
    const f = file();
    const r = new ProcessRegistry(f, fakeOs({}).o, 10);
    r.add({ pid: 500, startedAt: 1, signature: SIG });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([{ pid: 500, owner: 10, startedAt: 1, signature: SIG }]);
    expect(r.size).toBe(1);
    r.remove(500);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([]);
  });

  it('não apaga as entradas de outra janela ao gravar', () => {
    const f = file();
    new ProcessRegistry(f, fakeOs({}).o, 10).add({ pid: 500, startedAt: 1, signature: SIG });
    new ProcessRegistry(f, fakeOs({}).o, 20).add({ pid: 600, startedAt: 2, signature: SIG });
    expect(JSON.parse(readFileSync(f, 'utf8')).map((e: { pid: number }) => e.pid).sort()).toEqual([500, 600]);
  });

  it('reapOrphans mata só o que é de dono morto e com o comando conferindo (SIGTERM e depois SIGKILL)', () => {
    const f = file();
    writeFileSync(f, JSON.stringify([
      { pid: 500, owner: 10, startedAt: 1, signature: SIG },              // dono morto, comando confere → mata
      { pid: 501, owner: 10, startedAt: 1, signature: SIG },              // pid reaproveitado por outro programa → não mata
      { pid: 502, owner: 20, startedAt: 1, signature: SIG },              // dono vivo (outra janela) → não mata, fica
      { pid: 503, owner: 10, startedAt: 1, signature: SIG },              // já morreu → some
    ]));
    const { o, killed, runLater } = fakeOs({ 500: `claude ${SIG} --verbose`, 501: '/usr/bin/vim', 502: `claude ${SIG}` }, [20]);
    const r = new ProcessRegistry(f, o, 30);
    expect(r.reapOrphans()).toBe(1);
    expect(killed).toEqual([[500, 'SIGTERM']]);
    runLater();
    expect(killed).toEqual([[500, 'SIGTERM'], [500, 'SIGKILL']]);
    expect(JSON.parse(readFileSync(f, 'utf8')).map((e: { pid: number }) => e.pid)).toEqual([502]);
  });

  it('sem como conferir o comando (Windows), descarta a entrada sem matar', () => {
    const f = file();
    writeFileSync(f, JSON.stringify([{ pid: 500, owner: 10, startedAt: 1, signature: SIG }]));
    const { o, killed } = fakeOs({});
    o.isAlive = (pid) => pid === 500;
    const r = new ProcessRegistry(f, o, 30);
    expect(r.reapOrphans()).toBe(0);
    expect(killed).toEqual([]);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([]);
  });

  it('arquivo corrompido ou ausente não lança', () => {
    const f = file();
    expect(new ProcessRegistry(f, fakeOs({}).o, 30).reapOrphans()).toBe(0);
    writeFileSync(f, '{ isto não é json');
    expect(() => new ProcessRegistry(f, fakeOs({}).o, 30).reapOrphans()).not.toThrow();
    writeFileSync(f, JSON.stringify([{ pid: 'x' }, null, { pid: 1, owner: 2, startedAt: 3, signature: '' }]));
    expect(new ProcessRegistry(f, fakeOs({}).o, 30).reapOrphans()).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/process-registry.test.ts`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Implementar**

`src/ext/process-registry.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Um processo do CLI iniciado pelo Visor. `owner` é o pid do extension host (cada janela do VS Code tem o seu). */
export interface ProcEntry {
  pid: number;
  owner: number;
  startedAt: number;
  /** começo da linha de comando (os 3 primeiros argumentos), para não matar um pid reaproveitado */
  signature: string;
}

export interface RegistryOs {
  /** linha de comando atual do pid; undefined se não existe ou não dá para conferir */
  commandOf(pid: number): string | undefined;
  isAlive(pid: number): boolean;
  /** encerra o grupo do processo (o CLI é líder de grupo: `detached`) */
  killGroup(pid: number, signal: NodeJS.Signals): void;
  later(fn: () => void, ms: number): void;
}

/** Os 3 primeiros argumentos: identificam o modo do CLI (`-p --output-format stream-json`, `exec --json ...`), nunca o prompt. */
export const signatureOf = (args: string[]): string => args.slice(0, 3).join(' ');

const isEntry = (e: unknown): e is ProcEntry => {
  const x = e as ProcEntry;
  return !!x && typeof x === 'object' && Number.isInteger(x.pid) && x.pid > 1 && Number.isInteger(x.owner)
    && typeof x.startedAt === 'number' && typeof x.signature === 'string' && x.signature.length > 0;
};

/**
 * Lista, em disco, dos processos do CLI que o Visor iniciou. Sobrevive ao VS Code: na ativação seguinte, os que ficaram
 * vivos com o dono já morto (host que caiu, VS Code fechado à força) são encerrados. Entradas de outras janelas vivas
 * nunca são tocadas. Nenhum erro de disco impede a extensão de funcionar.
 */
export class ProcessRegistry {
  private readonly mine = new Map<number, ProcEntry>();

  constructor(private readonly file: string, private readonly os: RegistryOs, private readonly owner: number) {}

  get size(): number {
    return this.mine.size;
  }

  add(e: Omit<ProcEntry, 'owner'>): void {
    this.mine.set(e.pid, { ...e, owner: this.owner });
    this.save();
  }

  remove(pid: number): void {
    if (this.mine.delete(pid)) this.save();
  }

  /** Encerra os órfãos de ativações anteriores. Devolve quantos foram encerrados. */
  reapOrphans(): number {
    let killed = 0;
    const keep: ProcEntry[] = [];
    for (const e of this.load()) {
      if (e.owner === this.owner) continue;
      if (this.os.isAlive(e.owner)) {
        keep.push(e); // outra janela do VS Code, ainda aberta: os processos são dela
        continue;
      }
      const cmd = this.os.commandOf(e.pid);
      if (!cmd || !cmd.includes(e.signature)) continue; // já morreu, pid reaproveitado ou sem como conferir
      try {
        this.os.killGroup(e.pid, 'SIGTERM');
        this.os.later(() => {
          try {
            this.os.killGroup(e.pid, 'SIGKILL');
          } catch {
            /* saiu com o SIGTERM */
          }
        }, 2000);
        killed += 1;
      } catch {
        /* já terminou */
      }
    }
    this.write([...keep, ...this.mine.values()]);
    return killed;
  }

  private load(): ProcEntry[] {
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(data) ? data.filter(isEntry) : [];
    } catch {
      return [];
    }
  }

  /** Regrava as entradas das outras janelas como estão e as desta janela como estão agora. */
  private save(): void {
    this.write([...this.load().filter((e) => e.owner !== this.owner), ...this.mine.values()]);
  }

  private write(entries: ProcEntry[]): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${this.owner}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries));
      renameSync(tmp, this.file);
    } catch {
      /* sem disco: segue sem registro */
    }
  }
}

export const nodeRegistryOs: RegistryOs = {
  commandOf(pid) {
    // No Windows não há como conferir a linha de comando com segurança: a entrada é descartada, nada é encerrado.
    if (process.platform === 'win32') return undefined;
    const r = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const out = r.status === 0 ? r.stdout.trim() : '';
    return out || undefined;
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  killGroup(pid, signal) {
    process.kill(-pid, signal);
  },
  later(fn, ms) {
    setTimeout(fn, ms).unref();
  },
};
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run tests/ext/process-registry.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ext/process-registry.ts tests/ext/process-registry.test.ts
git commit -m "feat: registro de processos do CLI e limpeza de órfãos de janelas fechadas"
```

---

### Task 9: Ligar tudo na extensão e encerrar na hora ao fechar

**Files:**
- Modify: `src/ext/run-controller.ts` (`cancelAll`, `cancelChat`, `dispose`), `src/ext/extension.ts`
- Test: `tests/ext/run-controller.test.ts`

**Interfaces:**
- Consumes: `createDiagLog` (Task 2), `ProcessRegistry`, `nodeRegistryOs`, `signatureOf` (Task 8), `ProcessRun.pid`/`cancel({ immediate })` (Task 3).
- Produces: `RunController.cancelAll(immediate?: boolean)`.

- [ ] **Step 1: Escrever o teste**

```ts
describe('RunController: fechamento', () => {
  it('dispose encerra os processos na hora (immediate)', async () => {
    const t = setup();
    const p = (await startChat(t)).done;
    t.c.dispose();
    expect(t.runs[0]!.cancel).toHaveBeenCalledWith({ immediate: true });
    t.runs[0]!.finish(result({ cancelled: true }));
    await p;
  });

  it('cancelar pela tela continua com a espera do SIGTERM (sem immediate)', async () => {
    const t = setup();
    const p = (await startChat(t)).done;
    await t.c.handle({ type: 'cancel', runId: t.runs[0]!.runId });
    expect(t.runs[0]!.cancel).toHaveBeenCalledWith();
    t.runs[0]!.finish(result({ cancelled: true }));
    await p;
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/ext/run-controller.test.ts -t "fechamento"`
Expected: o primeiro teste FALHA (`cancel` chamado sem argumentos).

- [ ] **Step 3: Controller**

Em `src/ext/run-controller.ts`:

```ts
  /** Cancela todas as conversas ativas (e inícios ainda em andamento). `immediate`: sem esperar o SIGTERM (fechamento). */
  cancelAll(immediate = false): void {
    for (const token of this.pendingStarts) token.cancelled = true;
    for (const id of this.chats.keys()) this.cancelChat(id, immediate);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const chat of this.chats.values()) clearTimeout(chat.stallTimer);
    // O host pode encerrar antes de um timer de SIGKILL disparar: mata na hora.
    this.cancelAll(true);
  }
```

```ts
  private cancelChat(runId: string, immediate = false): void {
    const chat = this.chats.get(runId);
    if (!chat) return;
    if (chat.active) {
      if (immediate) chat.active.cancel({ immediate: true });
      else chat.active.cancel();
    } else if (chat.busy) chat.cancelRequested = true;
  }
```

- [ ] **Step 4: Extensão**

Em `src/ext/extension.ts`:

1. Imports:
   ```ts
   import { createDiagLog } from './diag-log';
   import { ProcessRegistry, nodeRegistryOs, signatureOf } from './process-registry';
   ```
   (Confirme que `path` já está importado; ele é usado em `savePastedImage`.)
2. Logo depois da criação do OutputChannel `log` e de `readSettings` (antes de `new RunController({`):
   ```ts
   const diag = createDiagLog((line) => log.appendLine(line), () => readSettings().debugLog);
   const registry = new ProcessRegistry(path.join(context.globalStorageUri.fsPath, 'processes.json'), nodeRegistryOs, process.pid);
   // Processos de uma sessão anterior que caiu ou foi fechada à força (ficavam vivos até reiniciar a máquina).
   diag.info('orphans', { killed: registry.reapOrphans() });
   ```
3. Troque `startRun: startProcessRun,` por:
   ```ts
   startRun: (runId, opts, onEvent) => {
     const run = startProcessRun(runId, opts, onEvent);
     const pid = run.pid;
     const t0 = Date.now();
     if (pid !== undefined) registry.add({ pid, startedAt: t0, signature: signatureOf(opts.args) });
     diag.info('spawn', { runId: runId.slice(0, 8), pid, cli: opts.adapter ?? 'claude', resume: !!opts.resume, live: registry.size });
     void run.done.then((r) => {
       if (pid !== undefined) registry.remove(pid);
       diag.info('exit', {
         runId: runId.slice(0, 8), pid, code: r.exitCode ?? undefined, signal: r.signal ?? undefined,
         ms: Date.now() - t0, cancelled: r.cancelled, live: registry.size,
         ...(r.exitCode !== 0 && r.stderrTail ? { stderr: r.stderrTail.trim().slice(-300) } : {}),
       });
     });
     return run;
   },
   log: diag,
   ```

> Note: `deactivate()` continua vazio. O VS Code chama o `dispose` de `context.subscriptions` ao desativar, e o `{ dispose: () => controller.dispose() }` já está lá. A mudança necessária era só o `immediate` (ver spec, "Ajustes ao desenho").

- [ ] **Step 5: Rodar tudo**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ext/run-controller.ts src/ext/extension.ts tests/ext/run-controller.test.ts
git commit -m "feat: log de processos, limpeza de órfãos na ativação e encerramento imediato ao fechar"
```

---

### Task 10: Webview: pergunta com "enviando…", "Tentar de novo" e aviso de processo parado

**Files:**
- Modify: `webview/graph.ts`, `webview/state.ts`, `webview/chat-context.ts`, `webview/App.tsx`, `webview/ChatCard.tsx`, `webview/QuestionCard.tsx`, `webview/styles.css`
- Test: `tests/webview/app-render.test.tsx`

**Interfaces:**
- Consumes: `RunView.lingering`, `RunView.stalled`, `HostMessage` `answer_ack`, `WebviewMessage` `keepWaiting`.
- Produces: `ChatNodeData.lingering?`, `ChatNodeData.stalled?`; `ViewState.answerFailed: Record<string, number>`; `ChatCtx.onKeepWaiting(runId)`, `ChatCtx.answerFailures(nodeId): number`.

- [ ] **Step 1: Escrever os testes**

Ao fim de `tests/webview/app-render.test.tsx`:

```ts
const Qv = { text: 'Qual cor?', options: ['Azul', 'Verde'], source: 'marker' as const };
const options = (runId: string) => [...card(runId).querySelectorAll('.question-card button.option')] as HTMLButtonElement[];
const sends = () => posted.filter((m) => m.type === 'send');

it('pergunta com o processo vivo: opção habilitada; o clique envia e mostra "enviando…"', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true }] });
  expect(options('r').every((b) => !b.disabled)).toBe(true);
  await click(options('r')[0]!);
  expect(sends().at(-1)).toMatchObject({ type: 'send', nodeId: 'r:root', text: 'Azul' });
  expect(options('r').every((b) => b.disabled)).toBe(true);
  expect(card('r').textContent).toContain('enviando…');
  await unmount(root);
});

it('answer_ack com falha mostra "Tentar de novo", que reenvia a mesma opção', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true }] });
  await click(options('r')[1]!);
  const before = sends().length;
  await send({ type: 'answer_ack', nodeId: 'r:root', ok: false });
  const retry = [...card('r').querySelectorAll('button')].find((b) => b.textContent === 'Tentar de novo')!;
  expect(retry).toBeTruthy();
  await click(retry);
  expect(sends()).toHaveLength(before + 1);
  expect(sends().at(-1)).toMatchObject({ nodeId: 'r:root', text: 'Verde' });
  await unmount(root);
});

it('turno rodando de verdade: opções desabilitadas com o motivo', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('r', 'P', 'waiting', { question: Qv }, true)] });
  expect(options('r').every((b) => b.disabled)).toBe(true);
  expect(card('r').querySelector('.question-hint')!.textContent).toContain('Aguardando o agente terminar');
  await unmount(root);
});

it('processo parado: "Encerrar processo" cancela e "Continuar esperando" envia keepWaiting', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true, stalled: true }] });
  const stall = card('r').querySelector('.stall-card')!;
  expect(stall.textContent).toContain('tarefa em segundo plano');
  await click([...stall.querySelectorAll('button')].find((b) => b.textContent === 'Encerrar processo')!);
  expect(posted).toContainEqual({ type: 'cancel', runId: 'r' });
  await click([...stall.querySelectorAll('button')].find((b) => b.textContent === 'Continuar esperando')!);
  expect(posted).toContainEqual({ type: 'keepWaiting', runId: 'r' });
  await unmount(root);
});

it('processo vivo: o cartão mostra cancelar e não mostra remover', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true }] });
  expect(byLabel('Cancelar conversa', card('r'))).toBeTruthy();
  expect(byLabel('Remover conversa', card('r'))).toBeNull();
  await unmount(root);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/webview/app-render.test.tsx`
Expected: os testes novos FALHAM.

- [ ] **Step 3: Implementar**

`webview/graph.ts`: em `ChatNodeData`, depois de `busy: boolean;`:

```ts
  /** turno encerrado com o processo vivo: dá para responder */
  lingering?: boolean;
  /** watchdog: o processo vivo ficou parado */
  stalled?: boolean;
```

No `data:` do cartão de chat, depois de `busy: run.busy,`:

```ts
            ...(run.lingering ? { lingering: true } : {}),
            ...(run.stalled ? { stalled: true } : {}),
```

`webview/state.ts`:
- Em `ViewState`, acrescente:
  ```ts
  /** quantas vezes a resposta de cada node não foi entregue (o card da pergunta oferece "Tentar de novo") */
  answerFailed: Record<string, number>;
  ```
- Em `initialState`, acrescente `answerFailed: {}`.
- Troque o `case 'answer_ack': return state;` (da Task 5) por:
  ```ts
  case 'answer_ack':
    return action.ok ? state : { ...state, answerFailed: { ...state.answerFailed, [action.nodeId]: (state.answerFailed[action.nodeId] ?? 0) + 1 } };
  ```

`webview/chat-context.ts`: em `ChatCtx`, acrescente:

```ts
  onKeepWaiting(runId: string): void;
  /** quantas respostas deste node falharam (muda = mostrar "Tentar de novo") */
  answerFailures(nodeId: string): number;
```

No valor padrão do contexto, acrescente `onKeepWaiting: noop, answerFailures: () => 0,`.

`webview/App.tsx`, no `chatCtx`:

```ts
      onKeepWaiting: (runId) => send({ type: 'keepWaiting', runId }),
      answerFailures: (nodeId) => state.answerFailed[nodeId] ?? 0,
```

e acrescente `state.answerFailed` ao array de dependências do `useMemo`: `[openNewAgent, state.clis, state.answerFailed]`.

`webview/QuestionCard.tsx`, inteiro:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { Question } from '../src/core/schema';
import { Markdown } from './markdown';

export function QuestionCard({ question, canSend, failures, onAnswer }: {
  question: Question;
  canSend: boolean;
  /** contador de respostas não entregues deste node: quando muda, a opção enviada volta e aparece "Tentar de novo" */
  failures: number;
  onAnswer(text: string): void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const seen = useRef(failures);
  useEffect(() => {
    if (failures === seen.current) return;
    seen.current = failures;
    if (sent !== null) {
      setFailed(sent);
      setSent(null);
    }
  }, [failures, sent]);
  const answer = (o: string) => {
    setFailed(null);
    setSent(o);
    onAnswer(o);
  };
  return (
    <div className="question-card" role="group" aria-label="Pergunta do agente">
      <div className="question-title"><span className="spinner" aria-hidden="true" /> O agente perguntou</div>
      <div className="question-text md"><Markdown text={question.text} /></div>
      {question.options.length > 0 && (
        <div className="question-options">
          {question.options.map((o) => (
            <button key={o} className={`option${sent === o ? ' is-sending' : ''}`} disabled={!canSend || sent !== null} onClick={() => answer(o)}>
              {sent === o ? `${o} · enviando…` : o}
            </button>
          ))}
        </div>
      )}
      {failed !== null && (
        <div className="question-hint question-failed" role="alert">
          A resposta não foi entregue. <button className="link" onClick={() => answer(failed)}>Tentar de novo</button>
        </div>
      )}
      <div className="question-hint">
        {!canSend
          ? 'Aguardando o agente terminar…'
          : question.options.length > 0 ? 'Escolha uma opção ou escreva sua resposta abaixo.' : 'Escreva sua resposta abaixo.'}
        {question.source === 'heuristic' && ' Pergunta detectada pelo texto da resposta.'}
      </div>
    </div>
  );
}
```

`webview/ChatCard.tsx`:
- Troque `const idle = !running && !d.busy;` por `const idle = !running && !d.busy && !d.lingering;`.
- Troque `{(running || d.busy) && <button className="secondary small" aria-label="Cancelar conversa" ...` por `{(running || d.busy || d.lingering) && <button className="secondary small" aria-label="Cancelar conversa" ...` (o resto da linha fica igual).
- Troque a linha do `QuestionCard` por:
  ```tsx
  {waiting && d.question && <QuestionCard question={d.question} canSend={!d.busy} failures={ctx.answerFailures(d.rootId)} onAnswer={(text) => ctx.onSend(d.rootId, text, [])} />}
  {d.stalled && (
    <div className="question-card stall-card" role="alert">
      <div className="question-title">O agente terminou de responder, mas uma tarefa em segundo plano não terminou.</div>
      <div className="question-options">
        <button className="option" onClick={() => ctx.onCancel(d.runId)}>Encerrar processo</button>
        <button className="option" onClick={() => ctx.onKeepWaiting(d.runId)}>Continuar esperando</button>
      </div>
    </div>
  )}
  ```

`webview/styles.css`, ao fim:

```css
.question-card .option.is-sending { opacity: 0.8; font-style: italic; }
.question-failed { color: var(--vscode-errorForeground); }
.stall-card { border-color: var(--vscode-editorWarning-foreground); }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm run typecheck && npx vitest run tests/webview/`
Expected: PASS. O teste antigo "opções da pergunta" continua passando: sem `lingering` e com `busy` falso, nada muda.

- [ ] **Step 5: Commit**

```bash
git add webview/ tests/webview/app-render.test.tsx
git commit -m "feat(webview): pergunta mostra envio, permite tentar de novo e avisa processo parado"
```

---

### Task 11: Testes de estresse

**Files:**
- Modify: `tests/ext/run-controller.test.ts`

**Interfaces:**
- Consumes: tudo das Tasks 3 a 9; `startProcessRun` real e `fixtures/fake-claude.mjs`.

- [ ] **Step 1: Escrever os testes**

No topo de `tests/ext/run-controller.test.ts`, acrescente:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProcessRun } from '../../src/cli/process-run';
```

Ao fim:

```ts
describe('RunController: estresse', () => {
  it('5 chats × 200 perguntas com o processo vivo: nada perdido, nada preso, um processo por chat; auth_lost isolado', async () => {
    const t = setup({}, { lingerTimeoutMinutes: 0 });
    const chats: { run: FakeRun; done: Promise<void> }[] = [];
    for (let i = 0; i < 5; i++) {
      const done = t.c.handle({ type: 'start', prompt: `chat ${i}` });
      await t.tick();
      const run = t.runs.at(-1)!;
      run.hasBackgroundTasks.mockReturnValue(true);
      run.emit(init(run.runId));
      chats.push({ run, done });
    }
    for (let turn = 0; turn < 200; turn++) {
      // O chat 0 perde o login no meio: os outros seguem sem perceber.
      if (turn === 100) chats[0]!.run.emit({ type: 'auth_lost', runId: chats[0]!.run.runId, ts: 1 });
      const active = turn < 100 ? chats : chats.slice(1);
      for (const { run } of active) run.emit(finishedWithQuestion(run.runId, Q));
      await t.tick(8);
      for (const { run } of active) {
        const v = t.view(run.runId);
        expect(v.status).toBe('waiting');
        expect(v.busy).toBe(false);
        await t.c.handle({ type: 'send', nodeId: `${run.runId}:root`, text: `r${turn}` });
      }
    }
    expect(t.startRun).toHaveBeenCalledTimes(5);
    expect(chats[0]!.run.sendUserMessage).toHaveBeenCalledTimes(100);
    for (const { run } of chats.slice(1)) expect(run.sendUserMessage).toHaveBeenCalledTimes(200);
    const a = acks(t);
    expect(a).toHaveLength(100 + 4 * 200);
    expect(a.every((x) => x.ok)).toBe(true);
    for (const { run, done } of chats) {
      run.finish();
      await done;
    }
    expect(t.snaps().at(-1)!.runs.every((r) => !r.busy && !r.lingering)).toBe(true);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('5 processos reais vivos (ignorando SIGTERM): dispose não deixa nenhum vivo', async () => {
    const fake = path.resolve('fixtures/fake-claude.mjs');
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'visor-stress-')), 'hang.ndjson');
    writeFileSync(f, JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n');
    const pids: number[] = [];
    const t = setup({
      startRun: (runId, _opts, on) => {
        const run = startProcessRun(runId, { command: process.execPath, args: [fake, f, '--hang', '--ignore-sigterm'], cwd: process.cwd() }, on);
        if (run.pid) pids.push(run.pid);
        return run;
      },
    });
    const dones: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      dones.push(t.c.handle({ type: 'start', prompt: `c${i}` }));
      await t.tick(50);
    }
    expect(pids).toHaveLength(5);
    t.c.dispose();
    await Promise.all(dones);
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    expect(alive).toEqual([]);
  }, 15_000);
});
```

- [ ] **Step 2: Rodar**

Run: `npx vitest run tests/ext/run-controller.test.ts -t "estresse"`
Expected: PASS. Se falhar, a falha aponta um defeito real das Tasks 5 a 9. Corrija lá, nunca afrouxando o teste.

- [ ] **Step 3: Suíte completa**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/ext/run-controller.test.ts
git commit -m "test: estresse com 5 chats em paralelo e encerramento de processos reais"
```

---

### Task 12: CHANGELOG e aceite manual de 8 h

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-10-14-estabilidade-sessoes-longas-design.md` (seção nova de resultados)

- [ ] **Step 1: CHANGELOG**

No topo de `CHANGELOG.md`, logo abaixo de `# Changelog`:

```markdown
## Não lançado

- Sessões longas com várias conversas em paralelo: a pergunta do agente sempre aceita resposta, mesmo com tarefa em segundo plano ainda rodando (a resposta vai para o mesmo processo, sem interromper a tarefa).
- Se um processo fica parado depois de responder, o cartão avisa e oferece "Encerrar processo" ou "Continuar esperando" (`visor.lingerTimeoutMinutes`).
- "Not logged in" no meio da sessão agora mostra o aviso de login com "Verificar de novo"; se o terminal continuar logado, o próximo envio já funciona.
- Processos que sobravam depois de fechar o VS Code (e só sumiam reiniciando a máquina) são encerrados ao fechar e, se algum escapar, na próxima abertura.
- Canal de saída "Visor" registra início e fim de cada processo; `visor.debugLog` liga os detalhes.
```

- [ ] **Step 2: Build e instalação local**

Run: `npm run build && npx @vscode/vsce package --no-dependencies`
Expected: gera `visor-for-ai-devs-0.1.8.vsix` (a versão não muda neste plano). Instale com `code --install-extension visor-for-ai-devs-0.1.8.vsix --force` e recarregue a janela.

Se o projeto empacota de outro jeito (ver `docs/release-checklist.md`), siga o checklist em vez deste comando.

- [ ] **Step 3: Sessão manual de 8 h (critério de aceite da spec)**

1. Ligar `visor.debugLog`.
2. Manter **pelo menos 3 conversas em paralelo** por 8 h, com subagentes, `Bash` em background e perguntas com opções.
3. A cada ~2 h, e no fim, rodar `ps -A -o pid,ppid,etime,command | grep -i '[c]laude -p'`. O número de processos deve bater com o `live=` das últimas linhas `spawn`/`exit` do canal "Visor".
4. Fechar o VS Code e rodar o `ps` de novo. O resultado esperado é que nenhum processo `claude -p` apareça.
5. Critérios: nenhum chat preso sem aviso; nenhuma opção de pergunta que não responde ao clique; nenhum "Not logged in", ou, se aparecer, recuperação pelo banner sem reiniciar o VS Code nem a máquina.

- [ ] **Step 4: Registrar o resultado na spec**

Acrescente ao fim da spec:

```markdown
## Resultado da sessão de 8 h (AAAA-MM-DD)

- Conversas em paralelo: N · duração: Xh
- Travamentos: … · avisos de processo parado: … · "Not logged in": …
- Processos vivos depois de fechar o VS Code: …
- Trechos relevantes do canal "Visor" (sem dados pessoais): …
```

Preencha com os valores observados. Se aparecer algum "Not logged in", anexe as linhas `spawn`/`result`/`auth_lost`/`exit` em volta: elas confirmam ou descartam H2 (conflito na renovação do token entre processos de longa duração).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-10-14-estabilidade-sessoes-longas-design.md
git commit -m "docs: changelog e resultado do aceite de sessões longas"
```
