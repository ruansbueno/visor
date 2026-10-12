# Visor — Canvas de Agentes

Veja o trabalho dos seus agentes de código como um **canvas**: cada conversa é um cartão, cada subagente um node ligado a ela, com o estado ao vivo (executando, aguardando resposta, concluído, erro).

O Visor é um **wrapper visual sobre as CLIs que você já tem instaladas**. Ele não é um cliente próprio, não tem tela de login e não guarda nem lê credenciais.

## O que faz

- **Chats em paralelo** no mesmo canvas, com campo de envio em cada cartão, perguntas do agente respondidas ali mesmo e retomada da conversa.
- **Claude Code e Codex**: escolha a CLI, o modelo, o esforço e as permissões (sandbox, no Codex) antes de começar e a cada mensagem. A lista de modelos do Codex vem do próprio CLI.
- **Subagentes do Claude Code** aparecem como nodes; dá para criar um novo sob um chat.
- **Anexos e `/`**: anexe arquivos e use skills e comandos que o próprio Claude Code informa.
- Clique num node para ver as chamadas de ferramenta e as mensagens, como na aba do Claude Code.
- Ícone na barra lateral: ao abri-lo, o canvas aparece no editor.

## Requisitos

- VS Code 1.90 ou superior.
- Pelo menos uma CLI instalada **e com login feito por você**:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`)
  - [Codex](https://github.com/openai/codex) (`codex`)
- Testado com Claude Code 2.1.287 e Codex 0.157.1. Outras versões podem funcionar, mas não foram verificadas.
- Testado só no macOS. Windows e Linux ainda não foram verificados.

## Declaração de conformidade

- Usa **a sua conta e a sua instalação** das CLIs; você instala e faz login pelo terminal.
- Nunca lê tokens, credenciais, Keychain ou os históricos que as CLIs guardam no seu computador.
- Não oferece login, não faz proxy nem revende acesso: apenas executa o comando da CLI e mostra a saída.
- Anexos só vêm do seletor de arquivos, e pastas sensíveis (como `~/.ssh`, `~/.aws`, `~/.claude`) são bloqueadas.
- Modos sem restrição (`bypassPermissions` no Claude, `danger-full-access` no Codex) sempre pedem confirmação.
- Funciona só em workspaces confiáveis.

O Visor é um projeto independente e **não é afiliado nem endossado pela Anthropic ou pela OpenAI**. Cabe a você respeitar os termos de uso de cada CLI.

## Configurações

| Chave | Para quê |
| --- | --- |
| `visor.claudePath` / `visor.codexPath` | Caminho dos executáveis, se não estiverem no PATH. |
| `visor.permissionMode` / `visor.allowedTools` | Permissões padrão do Claude Code (modo headless, sem aprovação interativa). |
| `visor.codexSandbox` | Sandbox padrão do Codex (`read-only`, `workspace-write`, `danger-full-access`). |
| `visor.parallelWarningThreshold` | A partir de quantos chats simultâneos mostrar um aviso. |

## Comandos

- **Visor: Abrir canvas de agentes**
- **Visor: Cancelar todas as execuções**

## Desenvolvimento

```bash
npm install
npm test          # vitest
npm run build     # dist/extension.cjs e dist/webview.*
```

Abra a pasta no VS Code e pressione F5 (ou `code --extensionDevelopmentPath=. <pasta>`). A especificação está em `spec-harness-multiagentes-v0.4.md`.

## Licença

[MIT](LICENSE)
