# Spec: Canvas de Multiagentes para VS Code

> Status: rascunho v0.4 (M0 concluído, ver `docs/m0-findings.md`) · Escopo inicial: extensão do VS Code, código aberto (fork fica como etapa futura)
>
> Pós-M1 (4): opções por chat (CLI instalada, modelo, esforço, permissões), anexos de arquivos por caminho, menu `/` com as skills e comandos que o próprio CLI informa, Enter/avião também nos diálogos, alças do cartão sempre visíveis, borda esmaecida fora de foco e menu de contexto que fecha ao clicar no canvas. Ver RF-25/26/27.
>
> Pós-M1 (3): o chat é um **cartão ao vivo** no canvas (conversa, campo de envio, ações), só agentes são nodes; nome automático (renomeável por duplo clique); nodes e cartões arrastáveis (posição/tamanho guardados no host); canvas sempre visível; Enter envia e Cmd/Ctrl+Enter quebra a linha; botão de envio com avião de papel roxo. Ver RF-20/21/23/24.
>
> Pós-M1 (2): várias conversas independentes no mesmo canvas (chats), com título; menu de botão direito (Novo agente / Novo chat); aviso a partir de 4 conversas executando ao mesmo tempo (`visor.parallelWarningThreshold`), sem limite máximo.
>
> Pós-M1: aguardando resposta (`waiting`), responder/enviar mensagens por node (retomada com `--resume`), novo node por tarefa, modal de inspeção e markdown seguro; ver seções 6, 8 e 11.
>
> M1 implementado (ver `docs/superpowers/plans/2026-10-11-m1-canvas-panel.md`); testes automatizados verdes, **smoke manual no VS Code pendente** (`docs/m1-smoke.md`).
>
> Mudanças da v0.3 (M0): a tool de subagente é `Agent` (além de `Task`); o prompt vai após `--`; `--settings` confirmado aditivo; hooks `SubagentStart/Stop` trazem `agent_id`/`agent_type`; modo terminal interativo validado (`Stop` por turno, `SessionEnd` ao sair; subagentes podem iniciar em segundo plano).
>
> Mudanças da v0.2:
> - **Decisões fechadas:** a extensão cria o terminal do CLI e injeta hooks via `--settings`; permissões do modo painel configuráveis com allowlist; runs simultâneos (decisão posterior: sem limite, com aviso; ver RF-22); MIT e distribuição no Marketplace da Microsoft e no Open VSX.
> - **Lacunas cobertas:** permissões headless (7.1), sessões e `--resume` (8.1), identidade de nodes e schema revisado (11), Windows (12), modo API key com marco próprio, M3 dividido em M3 e M4.

## 1. Visão geral

Extensão do VS Code que mostra a execução de agentes de código como um **grafo de nodes**, no estilo n8n. Cada node é um agente (orquestrador ou subagente). Uma linha conectando dois nodes indica que um agente acionou o outro (ex.: orquestrador → `backend`).

A extensão **não fala com a API de LLM** no modo padrão. Ela usa o CLI oficial já instalado e autenticado pelo usuário (`claude`, depois `codex`), observa os eventos e renderiza o grafo. A orquestração é feita pelo modelo da assinatura do próprio usuário, com subagentes pré-definidos disponíveis por padrão.

## 2. Objetivos e não objetivos

### Objetivos
- Visualizar em tempo real quais agentes estão ativos, quem acionou quem e o estado de cada um.
- Funcionar com o mínimo de configuração: instalou, abriu o painel, usou.
- Aceitar prompts pelo painel e pelo terminal integrado.
- Suportar várias execuções simultâneas no mesmo painel.
- Usar o CLI do usuário, sem tocar em credenciais.
- Inspecionar cada node (mensagens, tool calls, resultado).
- Ser um projeto de código aberto.

### Não objetivos (v1)
- Editar o fluxo arrastando nodes (não é um construtor de workflows como o n8n).
- Rodar agentes sem o CLI oficial (exceto o modo API key, marco M6).
- Exibir custo ou consumo da assinatura (o usuário consulta na extensão oficial do modelo que assina).
- Aprovação interativa de permissões pela UI (ver 7.1).
- Fork do VS Code.
- Garantir grafo peer-to-peer. No Claude Code, o grafo tende a ser hub-and-spoke (orquestrador → subagentes), porque subagentes não criam outros subagentes.

## 3. Compliance (regras inegociáveis)

1. Nunca ler `~/.claude/.credentials.json`, Keychain ou qualquer armazenamento de token.
2. Nunca implementar tela de "login com Claude" nem fazer proxy de requisições.
3. Nunca imitar headers ou identidade do Claude Code.
4. Nunca embutir ou revender acesso: o usuário usa a conta dele, na máquina dele.
5. Se o CLI não estiver instalado ou logado, orientar o usuário a instalar/logar por conta própria.
6. Modo alternativo: API key do próprio usuário via Agent SDK (caminho oficialmente indicado para produtos de terceiros), guardada no `SecretStorage` do VS Code. Implementado no M6.
7. README e UI informam claramente qual método de autenticação está em uso.
8. A extensão não funciona em workspaces não confiáveis (Restricted Mode do VS Code): ela executa o CLI, e com ele os hooks e skills do projeto.

> **Gate de release:** o caminho "wrapper do CLI" não tem aval explícito da Anthropic. Antes de qualquer publicação (Marketplace, Open VSX ou repositório público com divulgação), verificar os termos vigentes e, se possível, obter confirmação por escrito. Os termos mudaram várias vezes em 2026.

## 4. Arquitetura

```
┌────────────────────────── VS Code ──────────────────────────┐
│  Extension Host (TypeScript)                                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Run Manager  │→ │ Event        │→ │ State Store       │  │
│  │ (N runs,     │  │ Adapters     │  │ (grafo por run +  │  │
│  │  spawn CLI)  │  │ (stream/hook)│  │  histórico)       │  │
│  └──────────────┘  └──────────────┘  └─────────┬─────────┘  │
│  ┌──────────────┐                              │ postMessage │
│  │ Terminal     │──(hooks via canal local)──→ Event Adapters │
│  │ Integration  │                              │             │
│  └──────────────┘                              │             │
│  ┌─────────────────────────────────────────────▼─────────┐  │
│  │ Webview (React + React Flow): canvas + inspetor       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

| Camada | Responsabilidade |
|---|---|
| Run Manager | Cria, monitora e cancela várias execuções em paralelo (sem limite máximo; aviso a partir de 4 executando ao mesmo tempo, RF-22). Cada run tem `runId`, processo/terminal e `cwd`. |
| Event Adapters | Convertem eventos para o schema interno único. Um adapter por fonte: stream do CLI (painel) e hooks (terminal). |
| Terminal Integration | **Cria** o terminal do VS Code com o CLI interativo, injeta hooks por `--settings` e correlaciona os eventos ao run. |
| State Store | Fonte da verdade: grafo por run, histórico, estado dos nodes. |
| Webview | Canvas de nodes, seletor de runs, inspetor de node, input de prompt, controles. |
| Presets | Subagentes padrão gravados em `.claude/agents/` (seção 9). |

### Stack
- TypeScript + esbuild
- `child_process.spawn` para o modo painel
- `vscode.window.createTerminal` para o modo terminal
- Webview em React + `@xyflow/react` (React Flow)
- Comunicação host ↔ Webview via `postMessage`

### Estrutura de pastas
```
src/
  extension.ts        # comandos "Abrir canvas" e "Nova execução"
  runs/
    manager.ts        # múltiplas execuções simultâneas
  cli/
    claude.ts         # spawn + parse do stream-json (modo painel)
    claude-hooks.ts   # eventos via hooks (modo terminal)
    codex.ts          # M5
  core/
    schema.ts         # Run, AgentNode, Event
    store.ts          # estado do grafo
    presets.ts        # definição e instalação dos subagentes padrão
webview/
  App.tsx             # canvas + seletor de runs
  NodeInspector.tsx   # detalhes do node
```

## 5. Modos de entrada do prompt

| Modo | Como funciona | Fonte de eventos |
|---|---|---|
| **Painel** | O usuário digita o prompt no input do painel. A extensão spawna o CLI em modo headless. | Stream do CLI (`stream-json`) |
| **Terminal integrado** | A extensão cria um terminal do VS Code que executa o CLI interativo. O usuário conversa nele e a extensão atualiza o grafo. | Hooks do CLI, injetados por `--settings` (a validar no M0) |

### Modo terminal: decisões
- **A extensão cria o terminal.** Não se acopla a terminais abertos pelo usuário (fica fora da v1).
- **Hooks injetados por `--settings <arquivo temporário>`**, sem editar `.claude/settings.json` nem `settings.local.json` do projeto. O arquivo temporário vive no diretório de armazenamento da extensão (`globalStorageUri`) e é removido ao fim do run.
- Cada hook chama um script pequeno e portável (Node, para evitar diferenças de shell no Windows) que envia o evento a um canal local controlado pela extensão (socket Unix / named pipe no Windows). O `runId` entra no comando do hook como argumento ou variável de ambiente do terminal.
- **Validar no M0:**
  - se `--settings` mescla com a configuração existente do projeto/usuário em vez de substituí-la;
  - quais eventos os hooks expõem (`SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`) e se bastam para montar o grafo, incluindo o vínculo pai → filho;
  - se há conteúdo suficiente para o inspetor (mensagens e tool calls dos subagentes) sem ler transcripts.
- **Transcripts:** o payload dos hooks pode incluir o caminho do transcript em `~/.claude`. A extensão **não abre esse arquivo** (regra 1 da seção 3). Se o hook não entregar conteúdo suficiente, o inspetor do modo terminal mostra só o que os eventos trazem.
- **Fallback:** se os hooks forem insuficientes, o modo terminal vira "somente execução, sem grafo" (seção 15).

## 6. Requisitos funcionais

| ID | Requisito |
|---|---|
| RF-01 | Comando "Abrir canvas de agentes" abre o painel como aba do editor (não sidebar). |
| RF-02 | Input de prompt no painel: cria uma nova execução com o workspace aberto como `cwd`. |
| RF-03 | Modo terminal: a extensão cria um terminal com o CLI interativo e reflete a atividade no canvas. |
| RF-04 | Múltiplas execuções simultâneas (sem limite máximo; aviso configurável, RF-22); cada uma aparece no canvas com o estado dela (RF-20). |
| RF-05 | Cada agente ativo vira um node; o orquestrador é o node raiz de cada run. |
| RF-06 | Quando um agente aciona outro, uma aresta direcionada aparece entre os nodes. |
| RF-07 | Estados do node: `pending`, `running`, `done`, `error`, `cancelled`. |
| RF-08 | Clicar num node abre o inspetor: mensagens, tool calls, resultado e erros. |
| RF-09 | Cancelar encerra a árvore de processos do run (ou interrompe o terminal) e marca nodes em andamento como `cancelled`. |
| RF-10 | Detectar se o CLI está instalado e autenticado, sem ler credenciais (seção 7). |
| RF-11 | Presets gravados em `.claude/agents/` conforme regras da seção 9. |
| RF-12 | Histórico das execuções da sessão navegável. |
| RF-13 | Aviso ao iniciar runs simultâneos que possam editar os mesmos arquivos (seção 10). |
| RF-14 | Configuração de permissões do modo painel (seção 7.1). |
| RF-15 | Continuar uma conversa de um run finalizado (`--resume`, seção 8.1). |
| RF-16 | Quando o agente termina com uma pergunta, o run e o orquestrador ficam em `waiting` (com loading) até a pessoa responder ou marcar como concluído. A pergunta é detectada por bloco estruturado `visor-question` (instrução acrescentada via `--append-system-prompt`) ou, na falta dele, pelo `?` final do texto. |
| RF-17 | Cada node tem um campo para enviar mensagens: no orquestrador continua a conversa; num subagente pede ao orquestrador que o continue via `SendMessage` (pelo `agentId`). É um **pedido ao modelo**, sem garantia: o log do node mostra o que ele fez de fato; sem `agentId` conhecido o orquestrador pode iniciar um subagente novo. |
| RF-18 | "Novo node": a pessoa escolhe um agente (`.claude/agents/` do projeto + nativos) e uma tarefa; o orquestrador a delega e, se obedecer, o node novo aparece ligado a ele (também um pedido ao modelo, sem garantia). |
| RF-19 | O inspetor do node (modal) mostra prompt, mensagens, tool calls com entrada/resultado e o texto do agente com markdown seguro (sem HTML nem links clicáveis). |
| RF-20 | Vários chats (conversas independentes, cada uma com seu orquestrador, sessão e processo) convivem no mesmo canvas, lado a lado. O chat é um **cartão ao vivo** (título, estado, conversa rolando, pergunta com opções, campo de envio) no lugar do node do orquestrador; só agentes são nodes, ligados ao cartão. Cancelar, "Marcar como concluído", remover e "+ agente" são ações do cartão. O título nasce do começo da tarefa e é renomeável por duplo clique. |
| RF-21 | Menu de botão direito no canvas: "Novo agente…" (delegado a um chat existente ou, sem chats, a um chat novo) e "Novo chat…" (só a primeira tarefa; o nome nasce dela e se renomeia depois). |
| RF-23 | O canvas fica sempre visível (grade, zoom, menu de botão direito), mesmo sem chats. Cartões e nodes são arrastáveis; cartões também redimensionáveis (basta selecioná-los); os agentes sem posição própria acompanham o cartão. Posições e tamanhos escolhidos ficam na memória do host (sobrevivem a fechar/reabrir a aba, não a reiniciar o VS Code). Nodes novos são posicionados automaticamente; o enquadramento automático para quando a pessoa move o zoom. |
| RF-24 | Nos campos de conversa (barra de baixo, cartão, inspetor de agente) Enter envia e Cmd/Ctrl/Shift+Enter insere nova linha (Enter durante composição de IME não envia). Os botões de envio são um avião de papel branco sobre fundo roxo. Nos diálogos de novo chat e de novo agente também: Enter cria e Cmd/Ctrl+Enter quebra a linha. |
| RF-25 | Ao criar um chat a pessoa escolhe a **CLI** (só as instaladas na máquina, detectadas por `--version`; o Codex aparece desabilitado "em breve" até existir o adaptador, M5), o **modelo** (padrão do CLI, aliases `fable/opus/sonnet/haiku` ou id completo), o **esforço** (`low`…`max`) e as **permissões**. Valem para todos os turnos do chat (`--model`, `--effort`, `--permission-mode`) e aparecem como etiqueta no cartão. `bypassPermissions` inicia direto, sem diálogo de confirmação. |
| RF-26 | Anexar arquivos/pastas pelo seletor do VS Code (botão de clipe nos campos de envio, até 10). O host **só aceita caminhos que o próprio seletor devolveu** e bloqueia a raiz, a pasta pessoal e cantos de credenciais (`~/.ssh`, `~/.claude`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.config/gcloud`, `Library/Keychains`). O prompt recebe a lista de caminhos e o agente os lê pelas ferramentas dele. Anexos **fora do projeto** ganham uma regra de permissão de **somente leitura** do próprio arquivo (`Read(//caminho)`) ou da pasta (`Read(//pasta/**)`), válida só naquela mensagem; nunca `--add-dir`, nunca escrita, nunca a pasta pai (verificado no CLI 2.1.287). A extensão só confere que os caminhos existem, não lê o conteúdo. |
| RF-27 | Digitar `/` no começo do campo abre o menu de skills e comandos do CLI. A lista vem do evento `system/init` do próprio CLI: o processo é iniciado com `--no-session-persistence` e hooks desligados (`disableAllHooks`) e **encerrado assim que emite o `init`** (antes de qualquer resposta do modelo; **não verificado** se alguma requisição já saiu nesse instante). Um pedido por vez por projeto, em cache de 60 s (resultado vazio não é guardado); só nomes, agrupados por origem. Enter/Tab inserem `/nome `; o prompt `/nome` é executado pelo `claude -p`. |
| RF-28 | **Chats no Codex**: o chat pode rodar no Codex (`codex exec --json`, retomada por `codex exec resume`, sandbox `read-only`/`workspace-write`/`danger-full-access`; o último inicia direto, sem confirmação). A CLI é fixa por chat e aparece como etiqueta. O Codex não tem subagentes, anexos nem `/`; a instrução de pergunta é prefixada só no primeiro prompt. Eventos além de mensagem, comando e erro são mostrados como chamada genérica (**não verificado** com eventos reais). |
| RF-29 | **Opções por CLI e editáveis**: CLI, modelo, esforço e permissões ficam na barra inferior e no rodapé de cada cartão; a troca vale da próxima mensagem em diante, sem interromper o turno. A lista de modelos e de esforços do Codex vem do catálogo do próprio CLI (`codex debug models`); o Claude usa aliases fixos; "Outro…" aceita um id livre validado. |
| RF-30 | **Barra lateral**: ícone próprio (círculo de pontos); abrir a vista abre o canvas no editor, e a vista tem o botão "Abrir canvas". |
| RF-22 | Sem limite de conversas em paralelo; aviso (não bloqueio) ao iniciar a N-ésima executando ao mesmo tempo (padrão 4; `0` desliga). |

## 7. Detecção de CLI e autenticação

- Checar instalação com `claude --version` (e `codex --version`).
- Checar autenticação **pela saída/erro do próprio CLI** numa chamada leve (`claude auth status --json`, lendo apenas `loggedIn` e `authMethod`; o restante da saída, inclusive e-mail, é descartado), nunca lendo arquivos de credencial.
- Se falhar: mostrar instruções ("rode `claude` no terminal e faça login") e não tentar logar pelo usuário.
- Custo e consumo: **fora do escopo da v1**. O usuário consulta na extensão oficial do modelo que assina. Se o stream do CLI trouxer dados de uso, avaliar exibi-los depois, apenas como informação vinda da saída do CLI (nunca de credenciais). Validar no M0.

### 7.1 Permissões no modo painel

O `claude -p` é headless: não há como o CLI pedir aprovação interativa de uma tool. Sem configuração, runs que precisem de tools restritas falham ou travam.

- **v1: modo configurável + allowlist.** Settings da extensão:
  - `visor.permissionMode`: padrão conservador `acceptEdits` (aceita edições de arquivo; demais tools seguem a allowlist). Valores aceitos pelo CLI 2.1.267: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`;
  - `visor.allowedTools`: lista de regras (ex.: `Bash(npm test:*)`), repassada ao CLI;
  - `visor.disallowedTools`: lista de bloqueios.
- A configuração já existente do projeto/usuário (`permissions` em `settings.json`) continua valendo; a extensão só acrescenta flags.
- `bypassPermissions` **não é oferecido como padrão** e, quando escolhido, inicia direto, sem diálogo de confirmação.
- Quando um run falha por permissão negada, o inspetor mostra qual tool foi negada e sugere adicioná-la à allowlist.
- Aprovação interativa pela UI do canvas fica como evolução, fora da v1.
- No modo terminal, as permissões são tratadas pelo próprio CLI interativo.

## 8. Integração com o CLI

### Claude Code
- Modo painel: `claude -p --output-format stream-json --verbose` (mais flags de permissão da 7.1).
- Multi-turno: `--input-format stream-json`.
- Subagentes: arquivos em `.claude/agents/` (principal) e/ou `--agents` para testes.
- Modo terminal: `claude --settings <tmp>` num terminal criado pela extensão.

### Codex (M5)
- `codex exec --json`

> **Atenção:** nomes de campos, tipos de evento e flags devem ser **validados no M0 contra a versão atual de cada CLI** antes de congelar o schema. Não assumir o formato.

### 8.1 Sessões e continuação

- O stream expõe um `session_id`; o `Run` guarda esse identificador.
- "Continuar run" (RF-15) spawna um novo processo com `--resume <session_id>` e o mesmo `cwd`, reaproveitando o canvas do run original (novos nodes entram no mesmo grafo).
- O histórico da v1 vive só em memória da sessão do VS Code. Persistência entre sessões fica fora do escopo da v1; se for adicionada, usa `globalStorageUri` e nunca `~/.claude`.

### Mapeamento de eventos (hipótese a validar no M0)

| Evento | Efeito no grafo |
|---|---|
| Início da sessão/run | Cria node raiz (orquestrador) em `running` |
| Chamada da tool de subagente (`Agent`/`Task`) / `SubagentStart` | Cria node filho (`pending` → `running`) com `parentId` = orquestrador |
| Mensagem/tool call com vínculo ao pai (`parent_tool_use_id`) | Anexa ao log do node filho |
| `tool_result` do subagente / `SubagentStop` | Node filho → `done` (ou `error`) |
| Mensagem final / fim do processo | Node raiz → `done` |
| Processo encerrado com erro | Node afetado → `error` |

## 9. Presets de subagentes

- Conjunto inicial pequeno e genérico (ex.: `backend`, `frontend`, `tests`, `reviewer`), cada um com descrição e prompt de sistema.
- **Gravados em `.claude/agents/` do projeto** ao abrir o canvas pela primeira vez, com aviso ao usuário.
- Regras:
  - Nunca sobrescrever arquivo existente; se já houver agente com o mesmo nome (no projeto ou no usuário), pular e avisar.
  - Marcar os arquivos criados pela extensão (campo identificador no frontmatter) para permitir atualizar ou remover só os dela.
  - Comandos: "Restaurar presets" e "Remover presets da extensão".
  - Avisar que os arquivos entram no repositório (o usuário decide commitar ou ignorar via `.gitignore`).
- O modelo decide quando delegar; a extensão não força o roteamento.
- O usuário pode editar ou adicionar agentes direto nos arquivos.

## 10. Múltiplas execuções simultâneas

- Cada run tem `runId`, processo/terminal, grafo e histórico próprios; o seletor de runs mostra o estado de cada um.
- **Sem limite máximo de runs simultâneos.** Decisão posterior à v0.3: em vez de limite (`maxConcurrentRuns`), a extensão **avisa** quando N ou mais conversas executam ao mesmo tempo (`visor.parallelWarningThreshold`, padrão 4; `0` desliga), sem bloquear (RF-22).
- **Risco principal:** dois runs editando os mesmos arquivos no mesmo workspace geram conflito e resultados imprevisíveis.
  - v1: aviso ao iniciar um segundo run simultâneo.
  - Evolução: opção de rodar cada run em um **git worktree** separado.
- Consumo: vários runs em paralelo gastam o limite da assinatura mais rápido; avisar na UI.

## 11. Schema interno (congelado no M0; fonte: `src/core/schema.ts`)

```ts
type NodeStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';
// waiting: o agente terminou com uma pergunta e aguarda a resposta da pessoa; o run só termina quando ela responde (retomada) ou o marca como concluído.
// pending: node criado mas ainda não iniciou (ex.: chamada de subagente registrada, aguardando início).

interface Run {
  id: string;
  source: 'panel' | 'terminal';
  sessionId?: string;      // id de sessão do CLI, usado em --resume
  cwd: string;
  status: NodeStatus;
  startedAt: number;
  endedAt?: number;
}

interface AgentNode {
  id: string;              // único por invocação, não por nome de agente
  runId: string;
  parentId: string | null; // null = orquestrador; as arestas são derivadas daqui
  agentType: string;       // ex.: "backend"
  invocationId?: string;   // id da chamada (ex.: tool_use_id) que originou o node
  agentId?: string;        // id do agente no Claude Code (task_id); usado para continuar o subagente via SendMessage
  question?: { text: string; options: string[]; source: 'marker' | 'heuristic' }; // só em `waiting`
  status: NodeStatus;
  startedAt?: number;
  endedAt?: number;
  eventCount: number;
}

interface AgentEvent {
  id: string;
  nodeId: string;
  seq: number;             // ordem dentro do node
  ts: number;
  kind: 'message' | 'tool_call' | 'tool_result' | 'error';
  payload: unknown;
}
```

Mudanças em relação à v0.2:
- `Edge` removida: a aresta é derivada de `parentId`, sem risco de divergência.
- `AgentNode.events` saiu do node. Eventos ficam em lista separada, indexada por `nodeId`, com limite configurável de retenção por node (truncando `payload` grande), para o store não crescer sem limite.
- O mesmo subagente chamado várias vezes, ou vários em paralelo, gera nodes distintos (`invocationId`); `agentType` é só rótulo.
- `idle` virou `pending`.

## 12. Requisitos não funcionais

- **Segurança:** nenhum acesso a credenciais; API key (se usada) só em `SecretStorage`.
- **Desempenho:** a UI acompanha vários streams sem travar; batching de eventos na Webview; retenção limitada de eventos.
- **Robustez:** tolerar linhas malformadas, processo morrendo, CLI ausente e runs concorrentes.
- **Compatibilidade:** documentar a faixa de versões do CLI testadas; falhar com mensagem clara fora dela.
- **Privacidade:** logs e histórico ficam locais; nada é enviado a servidores do projeto.
- **Plataformas:** macOS, Linux e Windows são suportados desde o M1.
  - Cancelamento encerra a **árvore** de processos (no Windows, `taskkill /T`; em Unix, grupo de processos).
  - Hooks usam script Node, não shell, e canal local via named pipe no Windows.
  - Resolução do executável `claude` considera `.cmd`/`.exe` no Windows.
  - CI com matriz dos três sistemas.

## 13. Projeto aberto

- Código aberto desde o início.
- **Licença: MIT** (decidido).
- **Distribuição:** Marketplace da Microsoft **e** Open VSX (decidido), sujeita ao gate de release.
- Incluir `README` (com declaração de compliance da seção 3), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE` e templates de issue/PR.
- Política de contribuição: PRs com testes para adapters; mudanças no schema exigem atualização desta spec.

## 14. Roadmap e critérios de aceite

| Marco | Entrega | Critério de aceite |
|---|---|---|
| **M0** | Módulo sem UI que (a) spawna o `claude` e normaliza o stream e (b) captura eventos via hooks injetados por `--settings` numa sessão de terminal | Em tarefa com subagentes, ambos os modos mostram criação do filho, vínculo com o pai e conclusão. `--settings` confirmado como aditivo. Schema validado com eventos reais e fixtures gravadas. |
| **M1** | Extensão com Webview e grafo de **uma** execução pelo painel, com permissões configuráveis | Nodes e arestas em tempo real; estados mudam; cancelar encerra a árvore de processos; funciona em macOS, Linux e Windows. |
| **M2** | Presets em `.claude/agents/`, inspetor de node, histórico e `--resume` | Presets criados sem sobrescrever nada; inspetor mostra mensagens e tool calls; continuar um run reaproveita o canvas. |
| **M3** | Modo terminal (terminal criado pela extensão + hooks) | Sessão interativa alimenta o canvas; hooks removidos ao fim do run; configuração do projeto intacta. |
| **M4** | Múltiplas execuções simultâneas | Vários chats no mesmo canvas (feito, pós-M1); aviso de paralelismo a partir de 4 (feito); painel e terminal alimentando o mesmo canvas (pendente, depende do M3). |
| **M5** | Adapter do Codex | Mesmo canvas exibe execução do `codex exec --json`. |
| **M6** | Modo API key via Agent SDK | Chave só no `SecretStorage`; UI indica o método de autenticação em uso. |
| **M7** | Avaliar fork do VS Code | Só se a extensão limitar algo necessário (layout padrão, remover chat lateral). |
| **Release** | Gate de release | Licença MIT presente, README com compliance, termos revisados e confirmação da Anthropic verificada (seção 3). |

## 15. Riscos

| Risco | Mitigação |
|---|---|
| Hooks podem não expor eventos suficientes para o modo terminal | Validar no M0; se insuficiente, rebaixar o modo terminal para "somente execução, sem grafo" ou reavaliar a abordagem |
| `--settings` não mescla como esperado, ou muda entre versões | Validar no M0; fixture de teste; fallback para consentimento explícito antes de editar configuração do projeto |
| Runs headless travam por permissão negada | Modo + allowlist configuráveis (7.1); erro claro no inspetor |
| Formato de eventos muda entre versões do CLI | Adapters isolados; testes com fixtures; faixa de versões documentada |
| Mudança nos termos da Anthropic/OpenAI | Regras da seção 3; modo API key (M6); gate de release |
| Runs simultâneos conflitando nos mesmos arquivos | Aviso de paralelismo (a partir de 4 conversas); git worktree depois |
| Consumo do crédito/limite da assinatura em fluxos multiagente | Avisar na UI; usuário acompanha na extensão oficial |
| Presets em `.claude/agents/` poluem o repositório do usuário | Aviso, marcação dos arquivos, comando de remoção, sugestão de `.gitignore` |
| Comportamento diferente no Windows (processos, hooks) | Hooks em Node; kill de árvore; CI nos três sistemas |
| Grafo hub-and-spoke não corresponde à expectativa "n8n" | Alinhar expectativa no README |
| Delegação não determinística | Mostrar o que aconteceu de fato; não prometer fluxo fixo |

## 16. Questões em aberto

1. ~~Acima do limite de runs simultâneos: fila ou recusa?~~ Resolvida: não há limite, só aviso (RF-22).
2. Persistir o histórico entre sessões do VS Code? Se sim, em `globalStorageUri` com retenção limitada.
3. Aprovação de permissões pela UI do canvas: vale como evolução após a v1?
4. Acoplar a terminais abertos pelo usuário: algum dia, ou nunca?

### Decididas na v0.3
- Terminal: a extensão cria (antes: questão 1).
- Hooks: injetados por `--settings`, sem arquivo versionado (antes: questão 2).
- Limite de runs simultâneos: sem limite máximo, com aviso a partir de 4 (substitui o padrão 2 da v0.3).
- Licença MIT; distribuição nos dois marketplaces (antes: questões 4 e 5).
