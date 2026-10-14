# Changelog

## Não lançado

- Sessões longas com várias conversas em paralelo: a pergunta do agente sempre aceita resposta, mesmo com tarefa em segundo plano ainda rodando (a resposta vai para o mesmo processo, sem interromper a tarefa).
- Se um processo fica parado depois de responder, o cartão avisa e oferece "Encerrar processo" ou "Continuar esperando" (`visor.lingerTimeoutMinutes`).
- "Not logged in" no meio da sessão agora mostra o aviso de login com "Verificar de novo"; se o terminal continuar logado, o próximo envio já funciona.
- Processos que sobravam depois de fechar o VS Code (e só sumiam reiniciando a máquina) são encerrados ao fechar e, se algum escapar, na próxima abertura.
- Canal de saída "Visor" registra início e fim de cada processo; `visor.debugLog` liga os detalhes.

## 0.1.6

- O menu `/` (skills e comandos) abre em qualquer ponto da mensagem, não só no início.
- Login pelo Visor como nas extensões oficiais: "Fazer login" abre o navegador (Claude.ai / ChatGPT) e o Visor reconfere o CLI sozinho ao terminar ou ao voltar ao painel.
- Quando o CLI está sem login ou não instalado, o card avisa "Mensagem não enviada" em vez de ignorar em silêncio; "Verificar de novo" agora responde.
- O canvas acompanha a troca de tema (claro/escuro) sem reabrir o painel, e os textos de status têm mais contraste no tema claro.

## 0.1.5

Corrige o travamento do Visor ao enviar muitas mensagens ao mesmo card: a conversa longa não é mais redesenhada por inteiro a cada atualização.

## 0.1.2

Configuração inicial: procura o `claude`/`codex` fora do PATH do VS Code e o aviso de CLI ausente ou sem login ganha botões (instalar, escolher caminho, login, verificar de novo).

## 0.1.1

README em inglês na página da extensão.

## 0.1.0

Primeira versão pública: canvas de chats e subagentes, Claude Code e Codex, opções por CLI (modelo, esforço, permissões), anexos, `/` para skills e comandos, ícone na barra lateral.
