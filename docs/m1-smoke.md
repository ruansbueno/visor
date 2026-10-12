# Smoke manual do M1

Pré-requisitos: `npm run build`; `claude` instalado e autenticado.

1. Abra este repositório no VS Code e pressione F5 ("Executar extensão"). Abre uma janela com `fixtures/project` como workspace.
   Alternativa: `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --extensionDevelopmentPath="$PWD" fixtures/project`.
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

## Pós-M1: pergunta, resposta e novo node

10. Prompt: `Ask me which color I prefer, red or blue, before doing anything else.` Esperado: o Orquestrador fica **laranja, pulsando, com loading e "aguardando resposta"**, o run não termina, a barra de baixo vira "Aguardando sua resposta…" com **Marcar como concluído**.
11. Clique no Orquestrador. Esperado: cartão "O agente perguntou" com a pergunta formatada e botões **Vermelho** / **Azul**. Clique em uma opção: o node volta a "executando" e, no fim, "concluído".
12. Repita a pergunta e responda digitando no campo do modal (Ctrl/Cmd+Enter envia).
13. **+ Novo node**: escolha `reader`, tarefa `Read notes.txt and tell me its first line.` Esperado (também depende do modelo): um node `reader` aparece ligado ao Orquestrador.
14. Clique no node `echo` (ou `reader`) e envie uma mensagem. Esperado (depende do modelo obedecer, não é garantido): o orquestrador continua aquele subagente. Confira no log do Orquestrador se ele chamou `SendMessage` ou criou um subagente novo.
15. Marcar como concluído numa pergunta pendente fecha o run.

Verificação automatizada equivalente contra o claude real: `npx tsx scripts/e2e-turns.ts` (consome assinatura).

## Pós-M1 (2): vários chats e menu de botão direito

16. Botão direito no fundo do canvas (vazio ou com chats). Esperado: menu com **Novo agente…** e **Novo chat…**; Esc, clique fora ou escolher um item o fecha; setas ↑/↓ navegam. Botão direito em cima de um node **não** abre o menu.
17. **Novo chat…** (sem campo de nome): tarefa `Ask me which color I prefer, red or blue, before doing anything else.` Esperado: um **cartão de chat** aparece na hora no canvas, já com o seu prompt na conversa, e o título vem do começo da tarefa. Dê **duplo clique no título** para renomear para `Cores` (Enter confirma, Esc cancela).
18. Sem esperar, crie outro chat (`Eco`, tarefa `Use the echo subagent once with the text zeta.`). Esperado: duas árvores lado a lado, rodando em paralelo; **Cores** fica aguardando resposta e **Eco** conclui.
19. Responda **Cores** pelo cartão dele (opção ou campo de envio). Esperado: só ele volta a "executando"; **Eco** não muda.
20. **Novo agente…** com dois chats: aparece o seletor **Conversa** (padrão: o mais recente). Escolha `reader`, a conversa **Eco** e uma tarefa. Esperado: o node `reader` aparece sob **Eco**.
21. O ✕ no node do chat cancela só aquela conversa; **Visor: Cancelar todas as execuções** (paleta) cancela todas.
22. Inicie 4 chats ao mesmo tempo. Esperado: um aviso amarelo sobre execuções em paralelo (assinatura e conflito de arquivos), sem bloquear nada.

Verificação automatizada parcial: `npx tsx scripts/e2e-turns.ts` (consome assinatura) cobre só o **host** contra o claude real (dois chats em paralelo, pergunta/resposta, novo agente em chat existente e em chat novo). O menu de botão direito, o ✕, os diálogos e o aviso de 4 conversas são cobertos por testes em jsdom/vitest, **não** pela janela real do VS Code: o smoke manual dos itens 16–22 continua pendente.

23. **Remover conversa**: abra um chat parado e use o botão no cabeçalho do modal. Esperado: a árvore some do canvas. Não aparece em chat executando.
24. Clique em **Executar** e observe a barra de baixo: enquanto o host verifica o CLI aparece "Iniciando conversa…" com **Cancelar início**.
25. Dê zoom/arraste o canvas e deixe um chat criar um subagente. Esperado: seu enquadramento é mantido (só um chat novo reenquadra tudo).
26. Com um diálogo aberto, Tab não chega nos botões de trás e Esc fecha só um diálogo.

## Pós-M1 (3): cartão de chat, arrastar, avião roxo

27. Com o canvas **vazio**, a grade e o zoom aparecem, com uma dica discreta; o botão direito já abre o menu.
28. O botão **Executar** é um avião de papel branco em fundo roxo; **Enter** envia; **Cmd+Enter** (ou Ctrl/Shift+Enter) quebra a linha sem enviar. O mesmo vale no campo do cartão e no do inspetor de agente. Nos diálogos Enter quebra linha e Cmd/Ctrl+Enter cria.
29. Dois chats rodando: cada cartão mostra a **conversa ao vivo** (você, agente, tool calls com resultado recolhido) sem abrir nada.
30. Cartão em "aguardando": pergunta formatada com botões de opção dentro dele e **Marcar como concluído** no cabeçalho.
31. **+ agente** no cabeçalho do cartão abre o diálogo já apontando para aquele chat; o agente aparece como node pequeno ligado ao cartão. Clicar nesse node abre o inspetor; clicar no cartão não abre modal.
32. **Arraste** cartões e agentes livremente. **Clique no cartão** para selecioná-lo: aparecem as alças nas bordas/cantos; arraste uma para redimensionar (inclusive a de cima/esquerda, que também move o cartão). Os agentes que você não moveu acompanham o cartão. Feche e reabra a aba do canvas: as posições e tamanhos voltam. Chats novos continuam sendo posicionados sozinhos.

**Não coberto por teste automatizado:** o arrastar/redimensionar real do React Flow (só as funções puras que o traduzem em posição guardada) e o reenquadramento automático. Esses dois dependem do seu olho.

## Pós-M1 (4): opções, anexos, menu "/", foco

33. **Novo chat…**: o botão de criar é o avião roxo e **Enter cria** (Cmd/Ctrl+Enter quebra a linha). Há seletores de **CLI** (só as instaladas; "Codex — em breve" desabilitado), **Modelo** ("Padrão do CLI (modelo real)", fable/opus/sonnet/haiku ou "Outro…" com id), **Esforço** e **Permissões**. Crie um chat com `haiku` + `low`: o cartão mostra a etiqueta `haiku · low`.
34. **Clipe** em qualquer campo de envio abre o seletor do VS Code. Anexe `notes.txt`: aparece uma etiqueta removível (×); envie `Qual é a primeira linha do arquivo anexado?`. Esperado: o agente responde `hello from notes` e a sua mensagem mostra a etiqueta `notes.txt`. Um anexo **fora do projeto** gera um aviso amarelo ("somente leitura, só nesta mensagem"): o agente consegue ler aquele arquivo, mas não os vizinhos dele nem editar. Itens como a pasta pessoal, `~/.ssh` e `~/.claude` são bloqueados no seletor, com aviso. Anexos valem só para a mensagem em que foram enviados.
35. Digite `/` no começo do campo (barra de baixo, cartão ou diálogo). Esperado: menu com skills/comandos (inclui `ping` no projeto de teste), que filtra ao digitar; ↑/↓ navegam, **Enter ou Tab inserem** `/ping ` (e Enter **não** envia nesse momento), Esc fecha só o menu. Depois, Enter envia e o agente responde `PONG`.
36. **Alças do cartão**: sempre visíveis nos cantos/bordas; arraste uma para redimensionar (a de cima/esquerda também move o cartão). Se não redimensionar, descreva o que acontece.
37. **Foco do cartão**: com vários chats, o cartão fora de foco tem a borda esmaecida e o selecionado/sob o mouse/com o teclado dentro fica com a cor plena. Cartão "aguardando" fica sempre pleno.
38. **Menu de botão direito**: abra e clique em qualquer lugar do canvas (vazio, em cima de um cartão ou arrastando o fundo): o menu some. Também some ao dar zoom/rolar ou ao sair da janela.

Verificação automatizada parcial (host contra o claude real): `npx tsx scripts/e2e-turns.ts` cobre modelo/esforço, anexo, `/ping` e a leitura das capacidades. A aparência (esmaecimento da borda, alças, menu `/`) e o seletor de arquivos do VS Code são verificações suas.

## Pós-M1 (5): campo no padrão do Claude Code

39. Todo campo de mensagem é **uma caixa só**: o texto em cima e, embaixo, o rodapé com clipe, `/` (abre o menu de skills) e o botão de enviar à direita, tudo alinhado. O texto **cresce sozinho** até um limite (no cartão, 3 linhas, para não engolir a conversa) e depois rola; reajusta também quando a **largura** muda; não há alça para redimensionar à mão.
40. **Modelo e esforço antes do primeiro prompt**: ficam na linha de baixo da barra, ao lado de "+ Novo agente". Vale para o próximo chat criado pela barra e permanece até você mudar. "Padrão" mostra o modelo real do CLI na dica.
41. **Novo chat / Novo agente**: o campo vem primeiro e os seletores (CLI, modelo, esforço, permissões; ou conversa e agente) ficam **abaixo**, no rodapé da caixa, com o enviar à direita. O diálogo de novo chat já abre com o modelo/esforço escolhidos na barra.
42. **Alças de redimensionar do cartão**: escondidas; aparecem só quando o mouse chega ao **canto** do cartão (as bordas também arrastam).

Conferido em captura de tela real (Chrome sem cabeça com o bundle e o tema escuro): barra de baixo, cartões, diálogo de novo chat e de novo agente, **menu `/` dentro do diálogo** (aparece acima do campo) e texto longo na barra. **Não** conferido visualmente: o aparecimento da alça no canto com o mouse em cima, e o tema claro.

## Pós-M1 (6): Codex, opções editáveis e barra lateral

43. **Ícone do Visor** na barra lateral (círculo de pontos): clicar abre o canvas no editor; o botão "Abrir canvas" reabre se a aba foi fechada.
44. **Barra inferior**: pílulas CLI (com 2 ou mais CLIs), Modelo, Esforço e Permissões; "Auth: claude.ai" e "Codex: ChatGPT". Com Codex, o `/` some e as permissões viram sandbox (Somente leitura / Editar o projeto / Acesso total, que pede confirmação).
45. **Modelos do Codex** vêm do catálogo do CLI; o esforço lista só o que o modelo aceita.
46. **Cartão**: etiqueta da CLI e pílulas no rodapé; a troca vale da próxima mensagem. O cartão Codex não tem "+ agente", `/` nem anexo. Mande duas mensagens no Codex (retomada) e peça uma escrita em "Somente leitura" (deve ser bloqueada).
47. **Borda dos cartões** em roxo (erro e pergunta mantêm cor própria); cartão novo nasce com 540px.

Não verificado: `max`/`ultra` e os modelos do catálogo rodando de fato, eventos do Codex além de mensagem/comando/erro, tema claro, Windows/Linux.

