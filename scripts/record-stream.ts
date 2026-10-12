import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildClaudeArgs } from '../src/cli/claude-args';

const [name, prompt] = process.argv.slice(2);
if (!name || !prompt) {
  console.error('uso: tsx scripts/record-stream.ts <nome> "<prompt>"');
  process.exit(1);
}

const outDir = path.resolve('fixtures/stream');
mkdirSync(outDir, { recursive: true });
const out = createWriteStream(path.join(outDir, `${name}.ndjson`));

const child = spawn('claude', buildClaudeArgs({ prompt, permissionMode: 'acceptEdits' }), {
  cwd: path.resolve('fixtures/project'),
  stdio: ['ignore', 'pipe', 'inherit'],
});
child.stdout.pipe(out);
child.on('close', (code) => {
  console.error(`claude saiu com código ${code}; gravado em fixtures/stream/${name}.ndjson`);
});
