export interface ClaudeArgsInput {
  prompt: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: string;
  settingsFile?: string;
  appendSystemPrompt?: string;
  model?: string;
  effort?: string;
}

export function buildClaudeArgs(i: ClaudeArgsInput): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (i.permissionMode) args.push('--permission-mode', i.permissionMode);
  // Cada regra é um argumento: vírgulas e espaços dentro de uma regra (ex.: caminhos) não a quebram.
  if (i.allowedTools?.length) args.push('--allowedTools', ...i.allowedTools);
  if (i.disallowedTools?.length) args.push('--disallowedTools', ...i.disallowedTools);
  if (i.resume) args.push('--resume', i.resume);
  if (i.settingsFile) args.push('--settings', i.settingsFile);
  if (i.model) args.push('--model', i.model);
  if (i.effort) args.push('--effort', i.effort);
  if (i.appendSystemPrompt) args.push('--append-system-prompt', i.appendSystemPrompt);
  // O prompt vem depois de "--" para nunca ser lido como flag.
  args.push('--', i.prompt);
  return args;
}
