# Permissões interativas no Visor — desenho

Data: 2026-10-12 · Estado: aguardando revisão

## Objetivo

Quando o Claude Code pede permissão para usar uma ferramenta (Bash, Edit, etc.), a pessoa aprova ou nega **no próprio Visor**, como na extensão oficial do VS Code. Hoje o Visor roda `claude -p` com o stdin fechado, então qualquer coisa que pediria permissão é negada sozinha.

**Sucesso:** em um chat com modo de permissão "Padrão", pedir ao Claude algo que exige permissão mostra um card com **Permitir / Permitir sempre / Negar**; a escolha chega ao CLI e o turno continua.

## Fora de escopo

- Processo persistente por chat (`--input-format stream-json` com vários turnos no mesmo processo). Cada turno continua sendo um processo novo com `--resume`.
- Enviar mensagens enquanto o Claude trabalha; fila ou interrupção.
- Codex: nada muda (ele tem modelo próprio de sandbox).
- `AskUserQuestion` e `ExitPlanMode` com tratamento especial: entram como pedidos comuns, se o CLI os enviar por `can_use_tool`.

## Evidência (spike de 2026-10-12)

Com `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool=stdio` e a mensagem enviada por stdin como `{"type":"user","message":{"role":"user","content":"…"}}`, o CLI emite no stdout:

```json
{"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"…"},"description":"…","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"…"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories",…}]}}
```

Responder no stdin com `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"deny","message":"…"}}}` foi honrado: a ferramenta não rodou e o Claude relatou a negação. Sem `--permission-prompt-tool=stdio` nenhum `control_request` é emitido. Esta é a mesma flag que a extensão oficial usa (lida em seu `extension.js`).

## Componentes

### 1. Início do processo (`src/cli/claude-args.ts`, `src/cli/process-run.ts`)

- `buildClaudeArgs` acrescenta `--input-format stream-json` e `--permission-prompt-tool=stdio`. O prompt deixa de ser o argumento posicional depois de `--`.
- `startProcessRun` abre o stdin como `pipe` (hoje `ignore`) e, ao iniciar o Claude, escreve a mensagem do turno como uma linha JSON de usuário. O texto já inclui os anexos (`withAttachments`).
- O stdin é fechado quando chega o `result` (ou quando o processo termina/é cancelado). Ver "Pontos a confirmar".
- O Codex continua com `stdio: ['ignore', …]` e prompt posicional.
- `ProcessRun` ganha `respond(requestId, decision)`, que escreve o `control_response` no stdin. Chamar depois de o stdin fechar é ignorado sem erro.

### 2. Adapter e eventos (`src/cli/stream-adapter.ts`, `src/core/schema.ts`)

- `StreamAdapter.push` reconhece `type: 'control_request'` com `request.subtype === 'can_use_tool'` e emite `permission_request`:
  `{ type: 'permission_request', runId, nodeId, requestId, tool, input, description?, suggestions, ts }`.
  `nodeId` é sempre a raiz do chat (o pedido não identifica o subagente de origem; se o spike mostrar um campo que identifique, passa a usá-lo).
- Subtypes de `control_request` desconhecidos são ignorados (não contam como linha malformada).
- O texto do `input` mostrado na tela é limitado (ex.: 2.000 caracteres) e sem caracteres de controle.

### 3. Estado (`src/core/store.ts`, `src/protocol.ts`)

- O node guarda `permission?: { requestId, tool, summary, hasAlways }`; a fila de pedidos pendentes de um chat é uma lista, e o card mostra o primeiro.
- O status do node e do run **não muda** durante o pedido (o processo continua vivo e o chat continua "executando"); o card aparece porque há pedido pendente. Isso evita mexer nas regras de `waiting` (pergunta/`markDone`). Os pedidos pendentes são limpos ao responder e quando o processo termina (não no `run_finished`: uma tarefa em segundo plano pode pedir permissão depois do fim do turno principal).
- `RunView`/`NodeView` expõem o pedido pendente ao webview. As sugestões completas ficam só no host; o webview só recebe o que precisa exibir.
- Nova mensagem do webview: `{ type: 'permission', runId, requestId, decision: 'allow' | 'allow_always' | 'deny' }`, validada em `protocol.ts` (ids com tamanho máximo, decisão da lista).

### 4. Host (`src/ext/run-controller.ts`)

- Ao receber `permission_request`, registra o pedido (com as sugestões) no chat e publica o snapshot.
- Ao receber a mensagem `permission`:
  - `allow` → `{ behavior: 'allow', updatedInput: <input original> }`;
  - `allow_always` → o mesmo, mais `updatedPermissions` com a **primeira** sugestão de `addRules` do CLI (se não houver, age como `allow`);
  - `deny` → `{ behavior: 'deny', message: 'Negado pelo usuário no Visor.' }`.
- Pedido que não existe mais (turno acabou, já respondido) é ignorado com aviso discreto.

### 5. Tela (`webview/`)

- Novo `PermissionCard` (mesmo padrão visual do `QuestionCard`): título "Permissão necessária", ferramenta, resumo do comando/arquivo e três botões. "Permitir sempre" só aparece se o CLI mandou sugestão.
- Aparece dentro do cartão do chat, acessível por teclado, com foco no primeiro botão.

## Casos de borda

| Situação | Comportamento |
|---|---|
| Cancelar o turno / processo morre com pedido pendente | O processo é encerrado (o stdin é fechado antes do SIGTERM); o `run_finished` limpa o pedido. Remover chat já exige cancelar antes. |
| Vários pedidos (subagentes em paralelo) | Fila; um card por vez, na ordem de chegada. |
| Modos que não perguntam (`bypassPermissions`, `dontAsk`) | O CLI não emite pedido; nada muda. |
| `allowedTools` / `disallowedTools` das configurações | Continuam valendo antes de qualquer pedido. |
| Resposta tardia (processo já terminou) | Ignorada, com aviso. |
| `control_request` sem `request_id` ou malformado | Ignorado; conta como linha malformada. |

## Pontos a confirmar no início da implementação (spike curto)

1. Formato exato da resposta `allow`: `updatedInput` obrigatório? Formato de `updatedPermissions` para "permitir sempre".
2. Se fechar o stdin no `result` atrapalha o acompanhamento de tarefas em segundo plano, hoje tratado pelo adapter como "segundo turno no mesmo processo". Se atrapalhar, manter o stdin aberto até o processo terminar por conta própria e fechar só em cancelamento/timeout.

Se algum desses pontos invalidar o desenho, a implementação para e volta aqui antes de seguir.

## Resultados do spike (2026-10-12)

- **`allow`:** `{"behavior":"allow","updatedInput":<input original>}` é aceito; o comando rodou.
- **`allow_always`:** adicionar `"updatedPermissions":[<primeira sugestão addRules>]` é aceito e o CLI grava a regra em `.claude/settings.local.json` do projeto (`Bash(touch …)`), como na extensão oficial.
- **O `control_request`** traz `tool_name`, `input`, `description`, `display_name`, `tool_use_id`, `blocked_path`, `permission_suggestions`; nenhum campo identifica o subagente de origem, então o pedido vai sempre para a raiz.
- **Stdin e tarefas em segundo plano:** fechar o stdin no primeiro `result` encerra o processo na hora e mata a tarefa em segundo plano; manter o stdin aberto deixa a tarefa terminar e o CLI abre um segundo turno (`task_notification` → `init` → `result`) no mesmo processo, mas o processo **nunca sai sozinho**. O CLI informa as tarefas pendentes em `system/background_tasks_changed` (`tasks: [...]`), que chega antes do `result`.
- **Decisão:** o stdin é fechado em cada `run_finished` **somente se não houver tarefa em segundo plano pendente**; com tarefas pendentes, fecha no `run_finished` do turno seguinte (ou no cancelamento / término do processo).

## Testes

- `fixtures/fake-claude.mjs`: passa a ler o stdin e a emitir `control_request`; aguarda o `control_response` antes de continuar.
- `claude-args`: flags novas presentes, prompt fora dos argumentos; Codex inalterado.
- `process-run`: mensagem inicial escrita no stdin; `respond` escreve a resposta; stdin fecha no `result`; `respond` tardio é no-op.
- `stream-adapter`: `can_use_tool` vira `permission_request`; subtype desconhecido ignorado; input truncado.
- `store`: pedido entra na fila do node sem mudar o status; a resposta remove só o pedido certo; o `run_finished` não apaga pedidos (o processo pode seguir vivo com tarefa em segundo plano), e eles são limpos quando o processo termina.
- `run-controller`: `allow`, `allow_always` (com e sem sugestão), `deny`, pedido inexistente, cancelamento limpa o pedido.
- `webview`: card aparece/some, botões enviam a mensagem certa, "Permitir sempre" some sem sugestão.
- Verificação manual na janela de desenvolvimento: pedir `touch` num chat em modo Padrão e conferir os três caminhos.
