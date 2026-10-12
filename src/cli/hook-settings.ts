import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
];

// Usa o node absoluto: quem instalou o claude por instalador nativo/brew pode não ter `node` no PATH.
export function buildHookSettings(relayPath: string, nodePath: string = process.execPath): object {
  const hook = { type: 'command', command: `"${nodePath}" "${relayPath}"` };
  const hooks: Record<string, unknown[]> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [hook] }];
  return { hooks };
}

export function writeHookSettings(dir: string, relayPath: string): string {
  const file = path.join(dir, 'visor-hooks.settings.json');
  writeFileSync(file, JSON.stringify(buildHookSettings(relayPath), null, 2));
  return file;
}
