import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHookChannel } from '../src/cli/hook-channel';
import { writeHookSettings } from '../src/cli/hook-settings';
import { buildClaudeArgs } from '../src/cli/claude-args';

const [name, prompt] = process.argv.slice(2);
if (!name) {
  console.error('uso: tsx scripts/record-hooks.ts <nome> ["<prompt>"]  (sem prompt = sessão interativa manual)');
  process.exit(1);
}

const outDir = path.resolve('fixtures/hooks');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${name}.ndjson`);
writeFileSync(outFile, '');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'visor-rec-'));
const markFile = path.join(tmp, 'project-hook.mark');
const channel = await createHookChannel((m) => appendFileSync(outFile, JSON.stringify(m.payload) + '\n'));
const settings = writeHookSettings(tmp, path.resolve('hooks/relay.mjs'));
const env = { ...process.env, VISOR_PIPE: channel.path, VISOR_RUN_ID: 'rec', VISOR_MARK: markFile };
const cwd = path.resolve('fixtures/project');

const cleanup = async () => {
  await new Promise((r) => setTimeout(r, 300));
  await channel.close();
  console.error(`\nhook do projeto também disparou (--settings é aditivo): ${existsSync(markFile)}`);
  rmSync(tmp, { recursive: true, force: true });
  console.error(`gravado em ${outFile}`);
};

if (prompt) {
  const child = spawn('claude', buildClaudeArgs({ prompt, permissionMode: 'acceptEdits', settingsFile: settings }), {
    cwd, env, stdio: ['ignore', 'ignore', 'inherit'],
  });
  child.on('close', () => void cleanup());
} else {
  console.error('Abra um terminal e rode, na pasta fixtures/project:\n');
  console.error(`  VISOR_PIPE='${channel.path}' VISOR_RUN_ID=rec VISOR_MARK='${markFile}' claude --settings '${settings}'\n`);
  console.error('Peça: "Use the echo subagent twice, in parallel, with the texts alpha and beta."');
  console.error('Depois use /exit e volte aqui; pressione Ctrl+C para finalizar a gravação.');
  process.on('SIGINT', () => void cleanup().then(() => process.exit(0)));
}
