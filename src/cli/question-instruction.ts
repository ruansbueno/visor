/**
 * Instrução acrescentada ao agente (--append-system-prompt). No modo headless o CLI não tem como perguntar à pessoa:
 * o agente escreve a pergunta como texto e o processo termina. Este bloco estruturado deixa a extensão reconhecer a
 * pergunta (e as opções) com segurança, em vez de depender só do "?" final.
 */
export const QUESTION_INSTRUCTION =
  'If you need an answer from the user before you can continue, end your final message with exactly one fenced code ' +
  'block labelled visor-question that contains JSON of the form {"question": "<the question>", "options": ["<option 1>", ' +
  '"<option 2>"]} (options are optional), then stop and wait for the reply. Do not use any other mechanism to ask the user.';
