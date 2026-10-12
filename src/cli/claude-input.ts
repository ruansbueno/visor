/** Decisão do usuário sobre um pedido de permissão (formato aceito por `control_response` do Claude Code). */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string };

/** Mensagem de usuário para o stdin do `claude --input-format stream-json` (uma linha JSON). */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

/** Resposta a um `control_request` (`can_use_tool`) no stdin do CLI. */
export function permissionResponseLine(requestId: string, decision: PermissionDecision): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: decision },
  }) + '\n';
}
