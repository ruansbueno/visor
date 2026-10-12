// Uso: node fake-claude.mjs <arquivo.ndjson|-> [--hang] [--grandchild-pid-file <caminho>]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const [, , file, ...flags] = process.argv;
if (file && file !== '-') process.stdout.write(readFileSync(file, 'utf8'));

const i = flags.indexOf('--grandchild-pid-file');
if (i >= 0) {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(flags[i + 1], String(gc.pid));
}
if (flags.includes('--ignore-sigterm')) process.on('SIGTERM', () => {});
if (flags.includes('--hang')) setInterval(() => {}, 1000);
