// Uso: node fake-claude.mjs <arquivo.ndjson|-> [--hang] [--grandchild-pid-file <caminho>] [--stdin-file <caminho>] [--reply-file <caminho>] [--until-stdin-end]
// Linhas do ndjson no formato {"__wait":"<request_id>"} fazem o fake esperar o control_response daquele id no stdin
// (e gravá-lo em --reply-file) antes de seguir. --stdin-file grava tudo o que chegou no stdin.
// --until-stdin-end: depois de imprimir tudo, só sai quando o stdin fecha (como o claude com --input-format stream-json).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [, , file, ...flags] = process.argv;
const flagValue = (name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };

const i = flags.indexOf('--grandchild-pid-file');
if (i >= 0) {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  writeFileSync(flags[i + 1], String(gc.pid));
}
if (flags.includes('--ignore-sigterm')) process.on('SIGTERM', () => {});

const stdinFile = flagValue('--stdin-file');
const replyFile = flagValue('--reply-file');
const untilEnd = flags.includes('--until-stdin-end');
const needsStdin = !!stdinFile || !!replyFile || untilEnd || (file && file !== '-' && readFileSync(file, 'utf8').includes('__wait'));
const waiters = new Map();
let stdinClosed = new Promise(() => {});
if (needsStdin) {
  const rl = createInterface({ input: process.stdin });
  stdinClosed = new Promise((resolve) => rl.on('close', resolve));
  rl.on('line', (line) => {
    if (stdinFile) appendFileSync(stdinFile, line + '\n');
    try {
      const m = JSON.parse(line);
      const id = m?.response?.request_id;
      if (m?.type === 'control_response' && id) {
        if (replyFile) appendFileSync(replyFile, line + '\n');
        waiters.get(id)?.();
        waiters.delete(id);
      }
    } catch { /* linha que não é JSON */ }
  });
}

if (file && file !== '-') {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const wait = line.includes('__wait') ? JSON.parse(line).__wait : undefined;
    if (wait) await new Promise((resolve) => waiters.set(wait, resolve));
    else process.stdout.write(line + '\n');
  }
}
if (flags.includes('--hang')) setInterval(() => {}, 1000);
else if (untilEnd) {
  await stdinClosed;
  process.exit(0);
} else if (needsStdin) process.exit(0);
