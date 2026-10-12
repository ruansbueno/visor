# M0 — Achados

- Versão do claude testada: 2.1.267 (Claude Code)
- Data: 2026-10-11
- SO: macOS (Darwin)

## Stream (modo painel)

Gravado com `claude -p --output-format stream-json --verbose --permission-mode acceptEdits -- "<prompt>"` em `fixtures/project`.

1. Eventos antes do `init`: `system/hook_started` e `system/hook_response`. O evento inicial útil é `system/init` e traz `session_id` (e `cwd`, `tools`). Todos os eventos carregam `session_id`.
2. A tool que abre o subagente se chama **`Agent`** nesta versão (a lista `tools` do init ainda mostra `Task`). Input: `{description, subagent_type, prompt, run_in_background}`. O adapter aceita `Task` e `Agent`.
3. A mensagem `user` com o prompt entregue ao subagente traz `parent_tool_use_id` igual ao `id` do tool_use. Nas fixtures gravadas (subagente `echo` sem tools) o subagente **não emite mensagens `assistant` próprias** no stream: só essa mensagem `user`. Com um subagente que usa tools (`reader`), as mensagens dele (`assistant` com `tool_use: Read` e o `tool_result` correspondente) trazem o mesmo `parent_tool_use_id` (fixture `reader.ndjson`).
4. O resultado chega em evento `user` com bloco `tool_result` e `tool_use_id` do subagente, `parent_tool_use_id: null`. `content` é uma lista de blocos `text` (e um bloco extra com `agentId` e `<usage>`).
5. Evento final: `type: "result"`, `subtype: "success"`, `is_error: false`, `session_id`.
6. Uso/custo existe no stream: `result.total_cost_usd`, `result.usage`, `system/task_notification.usage`. Fora do escopo da v1 (spec §7); só registrado.
7. Eventos extras ignorados pelo adapter: `system/task_started` (traz `tool_use_id`, `subagent_type`, `task_id`), `system/task_updated`, `system/task_notification`, `rate_limit_event`.
8. `-p` aceita o prompt depois de `--` (confirmado pela gravação).

## Hooks (modo terminal)

Gravado com `claude -p ... --settings <tmp>` (`fixtures/hooks/print.ndjson`) e em **sessão interativa real** (`fixtures/hooks/interactive.ndjson`, 21 eventos: dois subagentes em paralelo, um segundo prompt, `/exit`).

1. **`--settings` é aditivo**: o hook `SessionStart` do `.claude/settings.json` do projeto disparou junto com o relay (`hook do projeto também disparou: true`).
2. Eventos recebidos: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `SubagentStart`, `SubagentStop`, `PostToolUse`, `Stop`, `SessionEnd`. `SubagentStart` traz `agent_id` e `agent_type`; `SubagentStop` traz `agent_id`, `agent_type`.
3. `PreToolUse`/`PostToolUse` da própria chamada do subagente (`tool_name: "Agent"`) chegam **sem** `agent_id` e pertencem à raiz. Tool calls feitas *dentro* do subagente trazem o `agent_id` dele (confirmado com o subagente `reader`, fixture `reader.ndjson`: `PreToolUse`/`PostToolUse` de `Read` com `agent_id`).
4. Os payloads trazem `transcript_path` (em `~/.claude`), **não aberto** pela extensão (spec §5). Há `last_assistant_message` no `Stop`. Mensagens do subagente não chegam nos hooks de subagente além dos campos acima.
5. `Stop` e `SessionEnd` chegam ao fim do `-p`. Se `Stop` dispara a cada turno e `SessionEnd` ao sair em sessão interativa: **não verificado**; por isso o adapter encerra o run só em `SessionEnd`.
6. Dois subagentes paralelos têm `agent_id` distintos.
7. Uso/custo aparece nos payloads de hook: `PostToolUse.tool_response` traz `usage`/`totalTokens` (fixtures `print.ndjson`). Fora do escopo da v1.
8. Todo payload traz `session_id`, `cwd`, `transcript_path`, `scratchpad_dir`.

## Critérios de aceite do M0 (spec §14)
- [x] Painel: criação do filho, vínculo com o pai e conclusão — `m0-demo panel`: `root [done]` com dois `echo` `[done]` (ids `toolu_...`).
- [x] Terminal (hooks via `claude -p --settings`): criação do filho, vínculo e conclusão — `m0-demo hooks`: `root [done]` com dois `echo` `[done]` (ids `agent_id`).
- [x] Terminal **interativo** real — replay de `interactive.ndjson`: dois `echo` `[done]`, run `done` no `SessionEnd`.
- [x] `--settings` é aditivo — hook do projeto disparou junto com o relay.
- [x] Cancelamento mata a árvore — Ctrl+C no demo: `root [cancelled]`, `claude` saiu (143), nenhum processo remanescente. Filhos `cancelled` cobertos pelo teste `process-run` com CLI falso (o cancelamento real ocorreu antes do primeiro subagente).
- [x] Schema validado com eventos reais — ajustes feitos: nome de tool `Agent` (além de `Task`); prompt passado após `--`; `SubagentStop.last_assistant_message` vira `tool_result` do filho.

## Diferenças em relação à hipótese da spec
- A tool de subagente se chama `Agent` na versão 2.1.267 (a lista de tools do init ainda mostra `Task`).
- Subagentes sem tools não emitem mensagens `assistant` próprias no stream; só a mensagem `user` com o prompt. O conteúdo do inspetor depende do subagente usar tools/texto (não coberto).
- Os hooks de subagente expõem `agent_id`/`agent_type`, suficientes para o grafo; `transcript_path`/`agent_transcript_path` existem e **não** são abertos.
- Stream e hooks trazem custo/uso (`total_cost_usd`, `usage`); fora do escopo da v1.

## Windows
Não testado (macOS apenas). `spawn('claude')` sem shell pode não resolver `claude.cmd` no Windows; tratar no M1 (spec §12).

## Pendências
1. Testar Linux e Windows (só macOS verificado).

## Decisão sobre o modo terminal
**Grafo completo.** Os hooks bastam para montar o grafo, inclusive a atribuição de tool calls a cada subagente (validado em sessão interativa e com subagente que usa tools).
