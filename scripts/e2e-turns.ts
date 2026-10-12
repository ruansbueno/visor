// Verificação manual contra o claude real (consome assinatura):
// duas conversas em paralelo -> pergunta -> resposta -> novo agente no outro chat -> mensagem a subagente.
import path from 'node:path';
import { readCapabilities } from '../src/cli/capabilities';
import { detectClis } from '../src/cli/clis';
import { detectClaude, detectCodex, execText } from '../src/cli/detect';
import { startProcessRun } from '../src/cli/process-run';
import { listProjectAgents } from '../src/ext/agents';
import { checkAttachments } from '../src/ext/files';
import { RunController } from '../src/ext/run-controller';
import { DEFAULT_SETTINGS } from '../src/ext/settings';
import type { HostMessage, RunView } from '../src/protocol';

const cwd = path.resolve('fixtures/project');
let toPick: string[] = [];
let runs: RunView[] = [];
let clis: unknown;
let kinds: Record<string, string[]> = {};
let caps: any;
const lastText: Record<string, string> = {};
const notices: string[] = [];
const controller = new RunController({
  post: (m: HostMessage) => {
    if (m.type === 'snapshot') runs = m.runs;
    if (m.type === 'clis') clis = m.clis;
    if (m.type === 'capabilities') caps = m;
    if (m.type === 'chat_log') kinds[m.runId] = m.events.map((e) => e.kind);
    if (m.type === 'chat_log') lastText[m.runId] = m.events.map((e) => (e.payload as any)?.text ?? '').filter(Boolean).at(-1) ?? '';
    if (m.type === 'notice') notices.push(`${m.level}: ${m.text}`);
  },
  cwd: () => cwd,
  settings: () => DEFAULT_SETTINGS,
  detect: (c, cli) => (cli === 'codex' ? detectCodex(execText, c) : detectClaude(execText, c)),
  confirmBypass: async () => false,
  prefs: { authBannerDismissed: () => false, dismissAuthBanner: () => {} },
  listAgents: listProjectAgents,
  listClis: () => detectClis(execText, { claude: 'claude', codex: 'codex' }),
  capabilities: (cwd) => readCapabilities({ command: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose', '--', 'hi'], cwd }),
  pickFiles: async () => toPick,
  checkAttachments,
  startRun: startProcessRun,
});

const show = (title: string) => {
  console.log(`\n== ${title}`);
  for (const r of runs) {
    console.log(`  chat "${r.title}" [${r.status}]`);
    for (const n of r.nodes) console.log(`    ${n.parentId ? '  ' : ''}${n.agentType} [${n.status}]${n.question ? ` ? "${n.question.text}" opts=${JSON.stringify(n.question.options)} (${n.question.source})` : ''}`);
  }
  if (notices.length) console.log('  avisos:', notices.splice(0));
};
const rootOf = (title: string) => runs.find((r) => r.title === title)!.nodes.find((n) => n.parentId === null)!.id;
const runIdOf = (title: string) => runs.find((r) => r.title === title)!.id;

// 1) dois chats ao mesmo tempo
await Promise.all([
  controller.handle({ type: 'start', title: 'Cores', prompt: 'Ask me which color I prefer, red or blue, before doing anything else.' }),
  controller.handle({ type: 'start', title: 'Eco', prompt: 'Use the echo subagent once with the text zeta and report what it said.' }),
]);
show('1) dois chats em paralelo terminaram');

// 2) responde a pergunta de "Cores"
await controller.handle({ type: 'send', nodeId: rootOf('Cores'), text: 'Blue. Just confirm in one short sentence.' });
show('2) resposta no chat Cores');

// 3) novo agente no chat "Eco"
await controller.handle({ type: 'spawn', agentType: 'reader', task: 'Read notes.txt and tell me its first line.', runId: runIdOf('Eco') });
show('3) novo agente reader no chat Eco');

// 4) novo agente sem chat alvo cria um chat novo
await controller.handle({ type: 'spawn', agentType: 'reader', task: 'Read notes.txt and tell me its first line.', runId: null });
show('4) spawn sem chat cria uma conversa nova');

// 5) CLIs instaladas e capacidades lidas do init (sem gastar tokens)
await controller.handle({ type: 'listClis' });
const t0 = Date.now();
await controller.handle({ type: 'listCapabilities' });
console.log('\n== 5) CLIs:', JSON.stringify(clis));
console.log(`   capacidades em ${Date.now() - t0}ms: ${caps.commands.length} comandos/skills (ex.: ${caps.commands.slice(0, 3).map((c: any) => c.name).join(', ')}), modelo padrão ${caps.defaultModel}`);
console.log('   tem "ping"?', caps.commands.some((c: any) => c.name === 'ping'));

// 6) chat com modelo/esforço escolhidos + anexo
toPick = [path.resolve('fixtures/project/notes.txt')];
await controller.handle({ type: 'pickFiles', requestId: 'e2e' });
await controller.handle({
  type: 'start', title: 'Opcoes',
  prompt: 'What is the first line of the attached file? Answer with just that line.',
  options: { model: 'haiku', effort: 'low' },
  attachments: toPick,
});
show('6) chat com --model haiku --effort low e anexo');
console.log('   ultima fala do agente:', JSON.stringify(lastText[runIdOf('Opcoes')]));
console.log('   opções guardadas:', JSON.stringify(runs.find((r) => r.title === 'Opcoes')?.options));

// 6b) anexo FORA do projeto: leitura liberada só para aquele arquivo (sem --add-dir); o vizinho continua negado
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('/tmp/visor-e2e', { recursive: true });
writeFileSync('/tmp/visor-e2e/fora.txt', 'CONTEUDO-FORA-DO-PROJETO\n');
writeFileSync('/tmp/visor-e2e/vizinho.txt', 'VIZINHO-PROIBIDO\n');
toPick = ['/tmp/visor-e2e/fora.txt'];
await controller.handle({ type: 'pickFiles', requestId: 'e2e2' });
await controller.handle({
  type: 'start', title: 'Fora',
  prompt: 'Read the attached file and also try to read /tmp/visor-e2e/vizinho.txt. Reply with the exact text you could read from each, or "DENIED" for any you could not read.',
  options: { model: 'haiku', effort: 'low' },
  attachments: toPick,
});
show('6b) anexo fora do projeto (somente leitura)');
console.log('   ultima fala do agente:', JSON.stringify(lastText[runIdOf('Fora')]));

// 7) /comando do projeto como prompt
await controller.handle({ type: 'start', title: 'Slash', prompt: '/ping', options: { model: 'haiku', effort: 'low' } });
show('7) /ping');
console.log('   ultima fala do agente:', JSON.stringify(lastText[runIdOf('Slash')]));

// 8) chat no Codex de verdade (sandbox somente leitura): comando de shell lê notes.txt
await controller.handle({
  type: 'start', title: 'CodexA',
  prompt: "Run the shell command 'cat notes.txt' and tell me its first line in one short sentence.",
  options: { cli: 'codex', sandbox: 'read-only' },
});
show('8) chat no Codex');
console.log('   ultima fala do agente:', JSON.stringify(lastText[runIdOf('CodexA')]));
console.log('   tipos de evento no cartão:', JSON.stringify(kinds[runIdOf('CodexA')]));
console.log('   opções:', JSON.stringify(runs.find((r) => r.title === 'CodexA')?.options));

// 9) retomada do Codex (mesma sessão)
await controller.handle({ type: 'send', nodeId: rootOf('CodexA'), text: 'What was the file name I asked you to read? Answer in one word.' });
show('9) retomada no Codex');
console.log('   ultima fala do agente:', JSON.stringify(lastText[runIdOf('CodexA')]));

// 10) sandbox somente leitura impede escrever (editado depois de criado via setOptions)
import { existsSync, rmSync } from 'node:fs';
rmSync('fixtures/project/blocked.txt', { force: true });
await controller.handle({ type: 'setOptions', runId: runIdOf('CodexA'), options: { sandbox: 'read-only', effort: 'low' } });
console.log('\n== 10) opções editadas depois de criado:', JSON.stringify(runs.find((r) => r.title === 'CodexA')?.options));
await controller.handle({ type: 'send', nodeId: rootOf('CodexA'), text: 'Create a file named blocked.txt in the current directory with the shell, then answer yes or no depending on whether it worked.' });
console.log('   ultima fala do agente:', JSON.stringify(lastText[runIdOf('CodexA')]), '| blocked.txt existe?', existsSync('fixtures/project/blocked.txt'));
rmSync('fixtures/project/blocked.txt', { force: true });

// 11) modelo inexistente no Codex: erro claro
await controller.handle({ type: 'start', title: 'CodexErro', prompt: 'say hi', options: { cli: 'codex', model: 'nao-existe-xyz', sandbox: 'read-only' } });
show('11) modelo inexistente no Codex');

// 12) trocar o modelo de um chat do Claude depois de criado
await controller.handle({ type: 'setOptions', runId: runIdOf('Opcoes'), options: { model: 'sonnet', effort: 'low' } });
await controller.handle({ type: 'send', nodeId: rootOf('Opcoes'), text: 'Reply with exactly: TROCADO' });
console.log('\n== 12) chat do Claude com modelo trocado: opções', JSON.stringify(runs.find((r) => r.title === 'Opcoes')?.options), '| fala:', JSON.stringify(lastText[runIdOf('Opcoes')]));
controller.dispose();
