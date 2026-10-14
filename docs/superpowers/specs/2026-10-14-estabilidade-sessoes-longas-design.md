# Estabilidade em sessões longas — desenho

Data: 2026-10-14 · Estado: aprovado; spike feito

## Objetivo

Usar o Visor por muitas horas seguidas, com várias conversas em paralelo, sem que:

1. **o agente fique parado** com a tela respondendo normalmente;
2. **o Claude apareça como deslogado** ("Not logged in · Please run /login") só no Visor, enquanto o `claude` no terminal continua logado, e sem que seja preciso reiniciar a máquina para voltar a funcionar;
3. **a pergunta do agente (bloco `visor-question`) mostre opções em que o clique não faz nada.**

**Sucesso:**

- Os testes automatizados de estresse do item "Testes" passam.
- Uma sessão manual de **8 horas** com pelo menos 3 conversas em paralelo (com subagentes e perguntas) termina sem travamento e sem logout.
- Se o CLI perder a autenticação mesmo assim, o Visor avisa com clareza e se recupera sem reiniciar o VS Code nem a máquina.

## Relato (respostas de 2026-10-14)

| Pergunta | Resposta |
|---|---|
| Mensagem do logout | "Not logged in / Please run /login" |
| O terminal também fica deslogado? | Não, só o Visor |
| O que roda em paralelo | Várias runs simultâneas no Visor |
| O que resolveu da última vez | Reiniciar a máquina (reabrir o VS Code não bastou) |
| O que trava | O agente para; a tela continua respondendo |
| Pergunta afetada | Pergunta do agente (não a permissão) |
| Sintoma | O clique na opção não faz nada |
| Quando acontece | Com várias conversas ao mesmo tempo e depois de muitas horas |
| Login | OAuth claude.ai (Pro/Max) |
| CLI | Claude Code 2.1.287 |

## Fora de escopo

- Processo persistente por chat com vários turnos no mesmo processo (continua sendo um processo por turno com `--resume`), exceto o caso pontual descrito em F1 caso o spike confirme que funciona.
- Reiniciar o CLI automaticamente quando o agente parar (não foi escolhido). O Visor avisa e oferece a ação; não age sozinho.
- Fazer login pelo Visor. Continua sendo `claude` no terminal (`setup.login` já abre o terminal).
- Mudanças no Codex além do que já for comum aos dois adapters.

## Diagnóstico: hipóteses

As hipóteses saíram de uma leitura focada de `process-run.ts`, `run-controller.ts`, `stream-adapter.ts`, `store.ts`, `detect.ts`, `hook-channel.ts`, `relay.mjs` e `ChatCard.tsx` / `QuestionCard.tsx`. Cada uma traz como confirmar ou descartar. A fase F0 (instrumentação) existe para produzir essa evidência.

### H1 — Processo que não termina depois do `result` (causa provável de "agente parado" e de "clique não faz nada")

**Mecanismo:**

1. `startProcessRun` só fecha o stdin no `run_finished` se `!adapter.hasBackgroundTasks()` (`src/cli/process-run.ts:72`). Com tarefa em segundo plano pendente (subagente em background, `Bash` com `run_in_background`, etc.), o processo continua vivo esperando.
2. Enquanto o processo vive, `runTurn` continua em `await run.done` (`src/ext/run-controller.ts:773`), então `chat.busy` fica `true`.
3. O `run_finished` com pergunta já mudou o status para `waiting` e mostrou o `QuestionCard` (`src/core/store.ts:128`). Mas o card recebe `canSend={!d.busy}` (`webview/ChatCard.tsx:101`), e o Composer recebe `disabled={running || d.busy}`. Resultado: **a pergunta aparece, mas as opções e o campo ficam desabilitados**. Visualmente isso parece "o clique não faz nada".
4. Se o CLI nunca mandar `background_tasks_changed` com a lista vazia (tarefa travada, evento perdido, ou contagem que não volta a zero), **não existe nenhum timeout**. O processo e o chat ficam presos para sempre: "agente parado, UI ok".

**Por que bate com o relato:** várias conversas e subagentes aumentam a chance de haver tarefa em background no fim do turno. Horas de uso acumulam esses processos.

**Como confirmar:** com o log da F0, todo chat preso deve mostrar `result` recebido, `backgroundTasks > 0` e o processo vivo. Também é possível reproduzir com o `fake-claude` emitindo `background_tasks_changed` com uma tarefa antes do `result`, sem nunca zerar.

### H2 — Processos órfãos que sobrevivem ao VS Code (explica por que só reiniciar a máquina resolveu)

**Mecanismo:** os filhos são criados com `detached: true` (líderes de grupo, `src/cli/process-run.ts:84`). `deactivate()` está vazio (`src/ext/extension.ts:203`). O `dispose` chama `cancelAll()`, que manda SIGTERM e agenda o SIGKILL para 3 s depois, mas o extension host pode encerrar antes disso. Se o host cair ou for morto, nada é limpo. Os processos de H1 (vivos esperando background) são exatamente os que sobram. Como são grupos destacados, fechar o VS Code não os mata.

**Efeito possível sobre o login:** cada processo antigo carrega o token OAuth em memória. Quando o access token expira, vários processos tentam renovar ao mesmo tempo. Com rotação de refresh token, quem perde a corrida fica com um refresh token inválido, e esses processos (e os que retomam a mesma sessão logo depois) passam a responder "Not logged in". O terminal, que lê a credencial nova do keychain, continua logado. Os órfãos continuam vivos entre reaberturas do VS Code, o que explicaria por que só reiniciar a máquina resolveu.

**Como confirmar:**

- Antes de reabrir o VS Code depois de um travamento: `ps -A -o pid,ppid,pgid,etime,command | grep -i '[c]laude -p'`. Processos com `etime` de horas e `ppid` 1 confirmam os órfãos.
- No log da F0: horário do primeiro "Not logged in" × quantidade de processos vivos naquele momento × idade do processo que falhou.

### H3 — O Visor não reconhece o logout no meio da sessão

**Mecanismo:** `lastChecks` guarda `ok` depois do primeiro `detect`. Os turnos retomados não verificam de novo (`src/ext/run-controller.ts:694`). Quando o CLI responde `result` com `is_error` e o texto "Not logged in · Please run /login", o Visor mostra só o erro genérico "A execução terminou com erro (código …)". O banner de autenticação não aparece, a engrenagem continua "ok", e cada nova mensagem falha do mesmo jeito.

**Como confirmar:** fixture com `result` `is_error: true` e esse texto. Hoje nenhum evento `cli` com `not_authenticated` é emitido.

Esta hipótese não causa o logout, mas é o motivo de a recuperação não ser óbvia. É corrigida de qualquer forma (F2).

### H4 — Custo de snapshot que cresce com as horas (contribuinte, a medir)

**Mecanismo:** `RunStore` guarda todos os eventos de todos os chats sem limite. `postSnapshot` serializa `toRunView` de **todos** os chats a cada flush (150 ms) enquanto houver atividade. Com muitas horas e muitos chats, o host e a Webview gastam mais CPU a cada flush. Isso pode atrasar cliques e re-renderizações, mas não explica sozinho os sintomas.

**Como confirmar:** a F0 registra tamanho do snapshot (bytes) e tempo de `postSnapshot`. Só entra em correção se passar dos limites definidos em F0 (snapshot > 1 MB ou flush > 50 ms).

## Fases

### F0 — Instrumentação (antes de qualquer correção)

Log no OutputChannel "Visor" (já existe, `log` em `extension.ts`). Nível `info` sempre ligado e enxuto; nível `debug` atrás da configuração `visor.debugLog` (padrão `false`).

| Evento | Campos |
|---|---|
| `spawn` | runId, pid, cli, fresh/resume, sessionId (8 primeiros caracteres), processos vivos no total |
| `result` | runId, pid, is_error, backgroundTasks no momento, pergunta detectada (sim/não) |
| `background_tasks_changed` | runId, pid, quantidade (debug) |
| `exit` | runId, pid, código/sinal, duração, cancelado, últimos 300 caracteres do stderr se houver erro |
| `stall` | ver F1 |
| `auth_lost` | runId, pid, idade do processo, texto que casou (sem token nem e-mail) |
| `snapshot` (debug) | bytes, ms, número de chats e de eventos |
| `orphans` | quantidade encontrada e encerrada na ativação (F3) |

Nunca registrar prompts, conteúdo de mensagens, tokens, e-mail ou caminhos de credencial.

### F1 — Pergunta respondível e processo que não termina (H1)

1. **Pergunta não depende de `busy` quando o turno já acabou.** O host passa a distinguir "processo vivo" de "turno em andamento". Novo estado no chat: `lingering` (um `result` chegou, mas o processo continua vivo por causa de tarefas em background). A `RunView` ganha `lingering: boolean`. Na Webview, `QuestionCard` e o Composer ficam habilitados quando `status === 'waiting' && lingering`.
2. **Responder com o processo ainda vivo.** Depende do spike (ver "Pontos a confirmar"):
   - **A (preferida):** escrever a resposta como nova `userMessageLine` no stdin do processo vivo (ele ainda está em `--input-format stream-json`). O turno continua no mesmo processo, sem perder as tarefas em background.
   - **B (alternativa):** encerrar o processo vivo (SIGTERM → SIGKILL) e iniciar o turno com `--resume`. As tarefas em background se perdem. Nesse caso o card avisa: "Há tarefas em segundo plano; responder agora vai interrompê-las."
3. **Watchdog de processo parado.** Depois do `result`, se o processo seguir vivo sem nenhum evento por `visor.lingerTimeoutMinutes` (padrão 10), o host registra `stall` e mostra um aviso no card: "O agente terminou de responder, mas uma tarefa em segundo plano não terminou." Ações: **Encerrar processo** e **Continuar esperando**. Nada é encerrado sozinho.
4. **Ação "Reenviar pergunta".** Se a pessoa clicar numa opção e nada for entregue (host devolve `notice` de falha, chat sumiu ou o processo morreu entre o clique e a entrega), o card continua visível com um botão **Tentar de novo**, em vez de a resposta se perder. Isso é feito com um `answerAck` do host para a Webview (`{ type: 'answer_ack', runId, ok, reason? }`). Até o ack chegar, a opção clicada mostra um estado de "enviando".
5. **Clique visível.** Quando o card estiver de fato desabilitado (turno realmente rodando), mostrar o motivo no `question-hint` ("Aguardando o agente terminar…") em vez de botões apagados sem explicação.

### F2 — Reconhecer o logout e orientar a recuperação (H3)

1. `StreamAdapter`: emitir `auth_lost` (novo em `schema.ts`, uma vez por processo) quando um `assistant` vier com `error === "authentication_failed"` ou um `result` com `is_error` tiver texto de autenticação (ver "Resultados do spike").
2. `RunController`, ao receber `auth_lost`:
   - `lastChecks.set('claude', { state: 'not_authenticated', … })` e `post({ type: 'cli', … })`, o que faz o banner atual aparecer com **Fazer login / Verificar de novo**;
   - mostrar um aviso específico no chat: "O Claude Code perdeu o login neste processo. O terminal pode continuar logado. Clique em Verificar de novo; se continuar, faça login.";
   - disparar `detect` em segundo plano. Se o `auth status` disser `loggedIn: true` (o terminal está ok e só o processo perdeu a credencial), o banner some e o aviso diz "Login ok: envie a mensagem de novo". O próximo turno é um processo novo, que lê a credencial atual.
3. O banner de autenticação não pode ficar oculto pela preferência `authBannerDismissed` quando a causa for `auth_lost` durante a sessão (a preferência vale só para o aviso da abertura).
4. Turnos retomados voltam a chamar `detect` se o último turno daquele CLI terminou em erro (hoje só verificam quando `lastChecks` não está `ok`).

### F3 — Limpeza de processos órfãos (H2)

1. **Registro de processos.** Cada `spawn` grava `{ pid, pgid, startedAt, command }` em `context.globalStorageUri/processes.json`, e cada `exit` remove a entrada. A gravação é atômica (arquivo temporário + rename).
2. **Na ativação:** para cada entrada, conferir se o pid existe **e** se o comando atual ainda é o mesmo (via `ps -o command= -p <pid>`), para não matar um pid reaproveitado. Se for o mesmo, `kill(-pgid, SIGTERM)` e, 2 s depois, `SIGKILL`. Registrar `orphans` no log e limpar o arquivo.
3. **No `deactivate`/`dispose`:** `cancelAll({ immediate: true })`, que manda SIGTERM e SIGKILL **na mesma chamada** para todos os grupos, sem depender do timer de 3 s (que não sobrevive ao host encerrando). `deactivate()` passa a chamar o controller.
4. **Windows:** mesmo registro, com `taskkill /T /F` na ativação. A conferência do comando usa `wmic`/`Get-CimInstance`; se não houver como conferir, a entrada é descartada sem matar nada.
5. **Limite de processos vivos:** se a soma de processos vivos (turnos + lingering) passar de `visor.parallelWarningThreshold`, além do aviso atual, o log `info` lista os mais antigos. Isso é só diagnóstico, sem ação automática.

### F4 — Custo do snapshot (H4, só se a F0 confirmar)

Se os limites da F0 forem ultrapassados: snapshot incremental (só os chats em `dirty`), e corte dos eventos guardados de chats `done`/`cancelled` além de N por node, mantendo o que o log do node inspecionado mostra. O desenho detalhado fica para depois da medição.

## Componentes afetados

| Arquivo | Mudança |
|---|---|
| `src/cli/process-run.ts` | expor `pid`, `alive`, `lingering`; `writeUserMessage()` (F1-A); `cancel({ immediate })`; hooks de log |
| `src/cli/stream-adapter.ts` | evento `auth_lost`; `result` marca `lingering` quando `backgroundTasks > 0` |
| `src/core/schema.ts`, `src/core/store.ts` | `auth_lost`; estado `lingering` |
| `src/core/snapshot.ts`, `src/protocol.ts` | `RunView.lingering`, `stall`; `answer_ack`; ações `killLingering`, `keepWaiting` |
| `src/ext/run-controller.ts` | `runTurn` com caminho "responder com processo vivo"; watchdog; tratamento de `auth_lost`; recheck após erro; `cancelAll({ immediate })` |
| `src/ext/extension.ts` | registro de processos + limpeza na ativação; `deactivate()` real; config `visor.debugLog`, `visor.lingerTimeoutMinutes` |
| `src/ext/process-registry.ts` (novo) | leitura/escrita do registro e conferência de pid+comando |
| `webview/ChatCard.tsx`, `webview/QuestionCard.tsx` | habilitar em `waiting && lingering`; estado "enviando"; **Tentar de novo**; aviso de stall com ações |
| `package.json` | as duas configurações novas |

## Casos de borda

- A pessoa responde (F1-A) e, no mesmo instante, a tarefa em background termina e o CLI sai: a escrita no stdin falha (EPIPE). O host cai para o caminho B (novo processo com `--resume`), sem perder a resposta.
- Duas perguntas de chats diferentes respondidas em sequência rápida: cada `answer_ack` é por `runId`; nenhum estado global de "enviando".
- `auth_lost` em vários chats ao mesmo tempo: um único `detect` em voo (o mesmo padrão de `capsInflight`), um único banner.
- Pid reaproveitado pelo sistema depois de reiniciar: a conferência do comando impede matar outro processo.
- O registro de processos corrompido ou ilegível: descartar e seguir. Nunca impede a ativação.
- O watchdog dispara enquanto a pessoa está aprovando uma permissão: há `pending` não vazio, então o watchdog não conta (o processo está esperando a pessoa, não travado).
- A Webview recarrega com uma pergunta em `lingering`: o snapshot inicial já traz `lingering`, e o card volta habilitado.

## Resultados do spike (2026-10-14, Claude Code 2.1.287)

1. **Segunda mensagem no stdin com o processo vivo: funciona.** Fluxo: `Bash` com `run_in_background` → `background_tasks_changed` (1) → `result` "FIRST". Escrevendo outra `userMessageLine` 1,5 s depois, veio `init` → `result` "SECOND" no mesmo processo, e depois `background_tasks_changed` (0). **Decisão: F1-A**, com F1-B só como alternativa quando a resposta precisa de opções ou anexos que o processo vivo não tem.
2. **Erro de autenticação é estruturado.** Sem credencial: `assistant` com `"error":"authentication_failed"` e texto "Not logged in · Please run /login"; depois, `result` com `"is_error":true` e o mesmo texto. Com token OAuth inválido: antes vêm `system` `api_retry` com `error_status: 401`, depois o mesmo par, com o texto "Failed to authenticate. API Error: 401 OAuth access token is invalid.". O **código de saída é 0** e o stderr vem vazio. A detecção usa `assistant.error === 'authentication_failed'`, com o texto do `result` como reserva; o stderr não entra. Amostra sanitizada em `fixtures/turns/auth-lost.ndjson` (a pasta `fixtures/stream` exige subagentes no replay).
3. **`background_tasks_changed` (0) chega quando a tarefa termina.** Mesmo assim, se o CLI não abrir um turno novo, nada fecha o stdin. Por isso `process-run` ganha um fechamento por inatividade (F1.6).
4. H2 em uso real: continua pendente. Rodar o `ps` de H2 no próximo travamento.

## Ajustes ao desenho depois da leitura do código

- **F2.3 já é verdade hoje:** `authBannerDismissed` só esconde o aviso de login *ok*; o banner de problema (`not_authenticated`) sempre aparece. Nada a mudar.
- **F3, várias janelas:** cada janela do VS Code tem o próprio extension host, mas todos dividem o mesmo `globalStorage`. Por isso cada entrada do registro guarda `owner` (o pid do extension host), e a limpeza na ativação só encerra processos cujo `owner` já morreu. Sem isso, abrir uma segunda janela mataria as conversas da primeira.
- **F3.3:** o VS Code já chama o `dispose` das `context.subscriptions` ao desativar. O problema é só o SIGKILL agendado para 3 s, que não sobrevive ao host. A correção é `cancel({ immediate: true })` no `dispose`; `deactivate()` continua vazio.
- **H4:** `RunStore` já limita 500 eventos por node (`maxEventsPerNode`). Fica só a medição do snapshot no log de debug.
- **F1.6 (novo):** com o turno encerrado, se as tarefas em background zerarem e nenhum turno começar em 30 s (`lingerCloseMs`), `process-run` fecha o stdin e o processo sai sozinho.

## Testes

**Unitários / integração (vitest, com `fixtures/fake-claude.mjs`):**

- `process-run`: `result` com `backgroundTasks > 0` mantém o processo vivo e marca `lingering`; `writeUserMessage` depois do `result` (F1-A) ou queda para o caminho B em EPIPE; `cancel({ immediate })` manda SIGKILL sem timer.
- `stream-adapter`: `auth_lost` a partir de `result` `is_error` e a partir do stderr; nenhum falso positivo em resultados normais que contenham "401" no meio de código (o padrão só vale em `is_error` ou saída com erro).
- `run-controller`: pergunta em `lingering` é respondível; watchdog emite `stall` após o tempo configurado (relógio falso) e não conta enquanto houver permissão pendente; `auth_lost` emite `cli` `not_authenticated` mesmo com o banner dispensado; recheck depois de erro; `answer_ack` `ok: false` quando o chat sumiu.
- `process-registry`: grava/remove; na ativação mata só pid+comando que conferem; arquivo corrompido é ignorado.
- Webview: `QuestionCard` habilitado em `waiting && lingering`; estado "enviando"; **Tentar de novo** após `answer_ack` com falha.

**Estresse (novo `tests/ext/stress.test.ts`):**

- 5 chats em paralelo com o `fake-claude`, cada um com subagente em background e uma pergunta por turno, por 200 turnos com tempos acelerados. Ao final: nenhum chat preso em `busy`, nenhuma resposta perdida, zero processos vivos depois de `dispose()`.
- Um dos chats recebe `auth_lost` no meio: o banner aparece uma vez e os outros chats seguem.

**Manual (aceite):**

- 8 horas de uso real com pelo menos 3 conversas em paralelo, subagentes e perguntas. Guardar o OutputChannel com `visor.debugLog` ligado. Critérios: nenhum chat preso sem aviso; nenhum "Not logged in"; ou, se ocorrer, recuperação pelo banner sem reiniciar nada. Ao fechar o VS Code, `ps` não mostra nenhum `claude -p` do Visor.

## Ordem sugerida

F0 → spike → F1 → F2 → F3 → testes de estresse → sessão de 8 h → F4 só se a F0 indicar.
