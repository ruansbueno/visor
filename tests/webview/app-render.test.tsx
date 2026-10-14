// @vitest-environment jsdom
import { it, expect, beforeAll, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { HostMessage, RunView } from '../../src/protocol';

const posted: any[] = [];

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m), getState: () => undefined, setState: () => {} });
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).DOMMatrixReadOnly = class { m22 = 1; constructor() {} };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
});

// ---------- helpers ----------
const send = (msg: HostMessage) => act(async () => { window.dispatchEvent(new MessageEvent('message', { data: msg })); });
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
const dblclick = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
const key = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
const rightClick = (el: Element, x = 120, y = 80) => act(async () => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })); });
const typeInto = (el: Element, value: string) => act(async () => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const btn = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const byLabel = (label: string, scope: ParentNode = document) => scope.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
const nodeEl = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`)!;
const card = (runId: string) => nodeEl(`${runId}:root`).querySelector('.chat-card')!;

async function mount() {
  document.body.innerHTML = '<div id="root"></div>';
  posted.length = 0;
  const { App } = await import('../../webview/App');
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(<App />); });
  return root;
}
const unmount = (root: ReturnType<typeof createRoot>) => act(async () => { root.unmount(); });

const now = Date.now();
const chat = (id: string, title: string, status: RunView['status'], extra: Partial<RunView['nodes'][number]> = {}, busy = false): RunView => ({
  id, title, busy, status, startedAt: now - 3000,
  nodes: [
    { id: `${id}:root`, parentId: null, agentType: 'root', status, startedAt: now - 3000, eventCount: 2, ...extra },
    { id: `${id}:a`, parentId: `${id}:root`, agentType: 'backend', status: status === 'running' ? 'running' : 'done', startedAt: now - 2500, endedAt: status === 'running' ? undefined : now - 2000, eventCount: 0 },
  ],
  edges: [{ from: `${id}:root`, to: `${id}:a` }],
});
const run = chat('r', 'Refatorar API', 'running');
const done = chat('r', 'Refatorar API', 'done');
const ok = { state: 'ok', version: '2.1.287', authMethod: 'claude.ai' } as const;
const logEvents = [
  { id: 'e1', seq: 1, ts: 1, kind: 'message', payload: { role: 'user', text: 'leia notes.txt' } },
  { id: 'e2', seq: 2, ts: 2, kind: 'tool_call', payload: { id: 't1', name: 'Read', input: { file_path: 'notes.txt' } } },
  { id: 'e3', seq: 3, ts: 3, kind: 'tool_result', payload: { tool_use_id: 't1', content: [{ type: 'text', text: 'hello from notes' }], is_error: false } },
  { id: 'e4', seq: 4, ts: 4, kind: 'message', payload: { role: 'assistant', text: '**feito**: <b>x</b>' } },
] as any;

// ---------- canvas sempre visível ----------
it('o canvas (grade e controles) existe mesmo sem nenhum chat, com uma dica discreta', async () => {
  const root = await mount();
  expect(posted).toContainEqual({ type: 'ready' });
  expect(document.querySelector('.react-flow')).not.toBeNull();
  expect(document.querySelector('.react-flow__background')).not.toBeNull();
  expect(document.querySelector('.react-flow__controls')).not.toBeNull();
  expect(document.querySelector('.empty-hint')!.textContent).toContain('Escreva um prompt');
  await send({ type: 'snapshot', runs: [run] });
  expect(document.querySelector('.empty-hint')).toBeNull();
  await unmount(root);
});

it('o menu de botão direito abre no canvas vazio', async () => {
  const root = await mount();
  await rightClick(document.querySelector('.canvas')!);
  expect([...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(['Novo agente…', 'Novo chat…']);
  await unmount(root);
});

// ---------- cartão do chat no lugar do node ----------
it('a raiz do chat é um cartão com o título (não um node de agente); os subagentes continuam nodes', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run] });
  expect(card('r').querySelector('.chat-title')!.textContent).toBe('Refatorar API');
  expect(nodeEl('r:root').querySelector('.agent-node')).toBeNull();
  expect(nodeEl('r:a').querySelector('.agent-node')!.textContent).toContain('backend');
  await unmount(root);
});

it('o cartão mostra a conversa ao vivo sem abrir modal: prompt, tool call com resultado recolhido e markdown seguro', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run] });
  await send({ type: 'chat_log', runId: 'r', events: logEvents, total: 4 });
  const c = card('r');
  expect(c.textContent).toContain('leia notes.txt');
  expect(c.querySelector('.log-tool .tool-head')!.textContent).toContain('Read');
  expect(c.querySelector('details')!.hasAttribute('open')).toBe(false);
  expect(c.querySelector('details')!.textContent).toContain('hello from notes');
  expect(c.querySelector('.log-text strong')!.textContent).toBe('feito');
  expect(c.querySelector('b')).toBeNull();
  expect(c.textContent).toContain('<b>x</b>');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await unmount(root);
});

it('cartão em execução mostra o indicador; parado não; vários chats ao vivo ao mesmo tempo', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run, chat('s', 'Parado', 'done')] });
  expect(card('r').querySelector('.chat-running')).not.toBeNull();
  expect(card('s').querySelector('.chat-running')).toBeNull();
  await send({ type: 'chat_log', runId: 'r', events: logEvents.slice(0, 1), total: 1 });
  await send({ type: 'chat_log', runId: 's', events: logEvents.slice(3), total: 1 });
  expect(card('r').textContent).toContain('leia notes.txt');
  expect(card('s').textContent).toContain('feito');
  expect(card('s').textContent).not.toContain('leia notes.txt');
  await unmount(root);
});

it('indica quando a conversa mostrada é só parte do total', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await send({ type: 'chat_log', runId: 'r', events: logEvents, total: 250 });
  expect(card('r').textContent).toContain('últimos 4 de 250');
  await unmount(root);
});

// ---------- botões do cabeçalho, por estado ----------
it('chat executando: Cancelar conversa; sem Remover. Cancelar envia o runId', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run, chat('s', 'Outro', 'running')] });
  expect(byLabel('Remover conversa', card('r'))).toBeNull();
  await click(byLabel('Cancelar conversa', card('s'))!);
  expect(posted).toContainEqual({ type: 'cancel', runId: 's' });
  await unmount(root);
});

it('chat parado: Remover conversa (envia removeChat); sem Cancelar; ocupado esconde o Remover', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done, chat('b', 'Ocupado', 'done', {}, true)] });
  expect(byLabel('Cancelar conversa', card('r'))).toBeNull();
  expect(byLabel('Remover conversa', card('b'))).toBeNull();
  await click(byLabel('Remover conversa', card('r'))!);
  expect(posted).toContainEqual({ type: 'removeChat', runId: 'r' });
  await unmount(root);
});

// ---------- pergunta ----------
const waiting = chat('r', 'Pergunta', 'waiting', { question: { text: '**Qual cor** você prefere?', options: ['Vermelho', 'Azul'], source: 'marker' } });

it('chat aguardando: cartão laranja com loading, pergunta formatada com opções que respondem e "Marcar como concluído"', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [waiting] });
  expect(card('r').className).toContain('status-waiting');
  expect(card('r').querySelector('.chat-head .spinner')).not.toBeNull();
  const q = card('r').querySelector('.question-card')!;
  expect(q.querySelector('strong')!.textContent).toBe('Qual cor');
  expect([...q.querySelectorAll('button.option')].map((b) => b.textContent)).toEqual(['Vermelho', 'Azul']);
  await click(q.querySelectorAll('button.option')[1]!);
  expect(posted).toContainEqual({ type: 'send', nodeId: 'r:root', text: 'Azul' });
  await click(btn('Marcar como concluído')!);
  expect(posted).toContainEqual({ type: 'markDone', runId: 'r' });
  await unmount(root);
});

it('pergunta só pela heurística avisa e não tem botões de opção', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('r', 'P', 'waiting', { question: { text: 'Posso continuar?', options: [], source: 'heuristic' } })] });
  expect(card('r').querySelectorAll('.question-card button.option')).toHaveLength(0);
  expect(card('r').querySelector('.question-card')!.textContent).toContain('detectada pelo texto');
  await unmount(root);
});

// ---------- envio: botão roxo com avião, Enter envia, Cmd+Enter quebra linha ----------
it('o botão Executar é o avião de papel (SVG, aria-label) e só habilita com texto', async () => {
  const root = await mount();
  const b = byLabel('Executar')!;
  expect(b.className).toContain('send-btn');
  expect(b.querySelector('svg')).not.toBeNull();
  expect(b.getAttribute('title')).toBe('Executar');
  expect(b.disabled).toBe(true);
  await typeInto(document.querySelector('.toolbar textarea')!, 'tarefa');
  expect(byLabel('Executar')!.disabled).toBe(false);
  await unmount(root);
});

it('barra de baixo: Enter envia um chat novo (mesmo com outro executando); Cmd+Enter só quebra a linha', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run] });
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), 'linha 1');
  await key('Enter', { metaKey: true }, ta());
  expect(ta().value).toBe('linha 1\n');
  expect(posted.filter((m) => m.type === 'start')).toHaveLength(0);
  await typeInto(ta(), 'linha 1\nlinha 2');
  await key('Enter', {}, ta());
  expect(posted).toContainEqual({ type: 'start', prompt: 'linha 1\nlinha 2' });
  expect(ta().value).toBe('');
  await unmount(root);
});

it('clicar no avião também envia e limpa o campo', async () => {
  const root = await mount();
  await typeInto(document.querySelector('.toolbar textarea')!, 'outra tarefa');
  await click(byLabel('Executar')!);
  expect(posted).toContainEqual({ type: 'start', prompt: 'outra tarefa' });
  expect((document.querySelector('.toolbar textarea') as HTMLTextAreaElement).value).toBe('');
  await unmount(root);
});

it('campo do cartão: botão Enviar é o avião; Enter envia ao orquestrador do chat; desabilitado enquanto executa/ocupado', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done, chat('x', 'Rodando', 'running'), chat('y', 'Ocupado', 'done', {}, true)] });
  const composer = card('r').querySelector('.composer')!;
  const sendBtn = byLabel('Enviar', composer)!;
  expect(sendBtn.className).toContain('send-btn');
  expect(sendBtn.querySelector('svg')).not.toBeNull();
  expect(sendBtn.disabled).toBe(true);
  const ta = composer.querySelector('textarea') as HTMLTextAreaElement;
  await typeInto(ta, 'continue por favor');
  await key('Enter', {}, ta);
  expect(posted).toContainEqual({ type: 'send', nodeId: 'r:root', text: 'continue por favor' });
  expect((card('r').querySelector('.composer textarea') as HTMLTextAreaElement).value).toBe('');
  expect((card('x').querySelector('.composer textarea') as HTMLTextAreaElement).disabled).toBe(true);
  expect((card('y').querySelector('.composer textarea') as HTMLTextAreaElement).disabled).toBe(true);
  await unmount(root);
});

// ---------- renomear ----------
it('duplo clique no título renomeia: Enter confirma, Esc cancela, vazio volta, blur confirma', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await dblclick(card('r').querySelector('.chat-title')!);
  let input = card('r').querySelector('input.chat-title-input') as HTMLInputElement;
  expect(input.value).toBe('Refatorar API');
  await typeInto(input, 'Meu novo nome');
  await key('Enter', {}, input);
  expect(posted).toContainEqual({ type: 'rename', runId: 'r', title: 'Meu novo nome' });
  expect(card('r').querySelector('input.chat-title-input')).toBeNull();

  posted.length = 0;
  await dblclick(card('r').querySelector('.chat-title')!);
  input = card('r').querySelector('input.chat-title-input') as HTMLInputElement;
  await typeInto(input, 'descartado');
  await key('Escape', {}, input);
  expect(posted.filter((m) => m.type === 'rename')).toHaveLength(0);
  expect(card('r').querySelector('.chat-title')!.textContent).toBe('Refatorar API');

  await dblclick(card('r').querySelector('.chat-title')!);
  input = card('r').querySelector('input.chat-title-input') as HTMLInputElement;
  await typeInto(input, '   ');
  await key('Enter', {}, input);
  expect(posted.filter((m) => m.type === 'rename')).toHaveLength(0);

  await dblclick(card('r').querySelector('.chat-title')!);
  input = card('r').querySelector('input.chat-title-input') as HTMLInputElement;
  await typeInto(input, 'Pelo blur');
  await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  expect(posted).toContainEqual({ type: 'rename', runId: 'r', title: 'Pelo blur' });
  await unmount(root);
});

it('renomear sem mudar o nome não envia nada', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await dblclick(card('r').querySelector('.chat-title')!);
  await key('Enter', {}, card('r').querySelector('input.chat-title-input')!);
  expect(posted.filter((m) => m.type === 'rename')).toHaveLength(0);
  await unmount(root);
});

// ---------- "+ agente" no cartão ----------
it('"+ agente" no cartão abre o diálogo já apontando para aquele chat', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('a', 'Primeiro', 'done'), chat('b', 'Segundo', 'done')] });
  await click(byLabel('Chamar agente neste chat', card('a'))!);
  expect(posted).toContainEqual({ type: 'listAgents' });
  await send({ type: 'agents', agents: [{ name: 'reader', description: '' }] });
  const sel = document.querySelector('.new-node select[aria-label="Conversa"]') as HTMLSelectElement;
  expect(sel.value).toBe('a'); // não o mais recente: o do cartão clicado
  await typeInto(document.querySelector('.new-node textarea')!, 'tarefa');
  await click(byLabel('Criar node')!);
  expect(posted).toContainEqual({ type: 'spawn', agentType: 'reader', task: 'tarefa', runId: 'a' });
  await unmount(root);
});

// ---------- agentes: node + modal ----------
it('clicar num node de agente abre o inspetor (título do agente, chat de origem); clicar no cartão não abre modal', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run, chat('s', 'Outro', 'done')] });
  await click(card('r'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(nodeEl('s:a'));
  expect(posted).toContainEqual({ type: 'inspect', nodeId: 's:a' });
  expect(document.querySelector('#modal-title')!.textContent).toBe('backend');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Outro');
  await unmount(root);
});

it('inspetor do agente: log com tool call recolhida, markdown seguro, composer via orquestrador; Esc/×/fundo fecham', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await click(nodeEl('r:a'));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  await send({ type: 'node_log', nodeId: 'r:a', events: logEvents, total: 4 });
  expect(dialog.querySelector('details')!.hasAttribute('open')).toBe(false);
  expect(dialog.querySelector('.log-text strong')!.textContent).toBe('feito');
  expect(dialog.querySelector('b')).toBeNull();
  expect(dialog.querySelector('.composer textarea')!.getAttribute('placeholder')).toContain('orquestrador');
  await typeInto(dialog.querySelector('.composer textarea')!, 'em francês');
  await key('Enter', {}, dialog.querySelector('.composer textarea')!);
  expect(posted).toContainEqual({ type: 'send', nodeId: 'r:a', text: 'em francês' });
  await key('Escape');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(posted.at(-1)).toEqual({ type: 'inspect', nodeId: null });
  await click(nodeEl('r:a'));
  await click(byLabel('Fechar detalhes')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(nodeEl('r:a'));
  await click(document.querySelector('.modal-backdrop')!);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await unmount(root);
});

it('inspetor sem botões de chat; fecha sozinho se o chat some', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run] });
  await click(nodeEl('r:a'));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(btn('Cancelar')).toBeUndefined();
  expect(btn('Remover conversa')).toBeUndefined();
  expect(btn('Marcar como concluído')).toBeUndefined();
  expect(dialog).not.toBeNull();
  await send({ type: 'snapshot', runs: [chat('novo', 'Novo', 'running')] });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await unmount(root);
});

// ---------- avisos, auth ----------
it('o aviso de autenticação tem × que avisa o host; a engrenagem mostra a conta e o uso', async () => {
  const root = await mount();
  await send({ type: 'prefs', authBannerDismissed: false });
  await send({ type: 'cli', check: ok });
  expect(document.body.textContent).toContain('Autenticação: claude.ai');
  await click(byLabel('Dispensar aviso de autenticação')!);
  expect(posted).toContainEqual({ type: 'dismissAuth' });
  await send({ type: 'prefs', authBannerDismissed: true });
  await click(byLabel('Conta e uso')!);
  const panel = document.querySelector('[role="dialog"][aria-label="Conta e uso"]')!;
  expect(panel.textContent).toContain('claude.ai');
  expect(panel.textContent).toContain('2.1.287');
  expect(panel.textContent).toContain('depois da primeira mensagem');
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
  await send({ type: 'usage', fiveHour: 0.12, sevenDay: 0.5, fiveHourResetsAt: reset, sevenDayResetsAt: reset + 86400 });
  expect(panel.textContent).toContain('12%');
  expect(panel.textContent).toContain('50%');
  expect(panel.textContent).toContain('reinicia em');
  // clicar fora fecha, mesmo se o canvas engolir o evento
  const pane = document.querySelector('.react-flow__pane')!;
  pane.addEventListener('pointerdown', (e) => e.stopPropagation());
  await act(async () => { pane.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(document.querySelector('[role="dialog"][aria-label="Conta e uso"]')).toBeNull();
  await unmount(root);
});

it('layout da página: avisos, canvas e depois a barra de baixo', async () => {
  const root = await mount();
  expect([...document.querySelector('.app')!.children].map((c) => c.className.split(' ')[0])).toEqual(['banners', 'canvas', 'toolbar']);
  await unmount(root);
});

// ---------- menu de botão direito ----------
it('botão direito abre o menu (posição, foco, setas, Esc/clique fora); em cima de um node não abre', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run] });
  await rightClick(document.querySelector('.canvas')!, 300, 200);
  const menu = document.querySelector('[role="menu"]') as HTMLElement;
  expect(menu.style.left).toBe('300px');
  expect(menu.style.top).toBe('200px');
  expect(document.activeElement?.textContent).toBe('Novo agente…');
  await key('ArrowDown', {}, document.activeElement!);
  expect(document.activeElement?.textContent).toBe('Novo chat…');
  await key('Escape');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await rightClick(document.querySelector('.canvas')!);
  await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await rightClick(nodeEl('r:a'));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await unmount(root);
});

// ---------- novo chat ----------
it('Novo chat: sem campo de nome; botão é o avião roxo; Enter cria, Cmd+Enter quebra a linha; Esc cancela', async () => {
  const root = await mount();
  await rightClick(document.querySelector('.canvas')!);
  await click(document.activeElement!.nextElementSibling!); // "Novo chat…"
  const dlg = document.querySelector('.new-chat')!;
  expect(dlg.getAttribute('role')).toBe('dialog');
  expect(dlg.querySelector('input[type="text"]')).toBeNull();
  const create = byLabel('Criar chat')!;
  expect(create.className).toContain('send-btn');
  expect(create.querySelector('svg')).not.toBeNull();
  expect(create.disabled).toBe(true);
  const ta = dlg.querySelector('textarea')!;
  await typeInto(ta, 'refatore o módulo X');
  await key('Enter', { metaKey: true }, ta);
  expect((ta as HTMLTextAreaElement).value).toBe('refatore o módulo X\n');
  expect(posted.filter((m) => m.type === 'start')).toHaveLength(0);
  await typeInto(ta, 'refatore o módulo X');
  await key('Enter', {}, ta);
  expect(posted).toContainEqual({ type: 'start', prompt: 'refatore o módulo X' });
  expect(document.querySelector('.new-chat')).toBeNull();
  await click(btn('+ Novo chat')!);
  await key('Escape');
  expect(document.querySelector('.new-chat')).toBeNull();
  await unmount(root);
});

it('Novo chat pede as CLIs e as capacidades ao abrir e lista só as instaladas (Codex incluído)', async () => {
  const root = await mount();
  await click(btn('+ Novo chat')!);
  expect(posted).toContainEqual({ type: 'listClis' });
  expect(posted).toContainEqual({ type: 'listCapabilities' });
  await send({ type: 'clis', clis: [{ id: 'claude', label: 'Claude Code', version: '2.1.287', supported: true }, { id: 'codex', label: 'Codex', version: '0.157.1', supported: true }] });
  const sel = document.querySelector('.new-chat select[aria-label="CLI"]') as HTMLSelectElement;
  const opts = [...sel.querySelectorAll('option')];
  expect(opts.map((o) => o.value)).toEqual(['claude', 'codex']);
  expect(opts[0]!.textContent).toContain('Claude Code');
  expect(opts[1]!.textContent).toContain('Codex');
  expect((opts[1] as HTMLOptionElement).disabled).toBe(false); // agora o Codex roda chats de verdade
  expect(sel.value).toBe('claude');
  await unmount(root);
});

it('Novo chat: modelo, esforço e permissões viram options; padrões não são enviados; "Padrão" mostra o modelo do CLI', async () => {
  const root = await mount();
  await click(btn('+ Novo chat')!);
  await send({ type: 'capabilities', commands: [], defaultModel: 'claude-sonnet-5-5' });
  const model = document.querySelector('.new-chat select[aria-label="Modelo"]') as HTMLSelectElement;
  expect(model.querySelector('option[value=""]')!.textContent).toContain('claude-sonnet-5-5');
  expect([...model.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku', '__custom']);
  const effort = document.querySelector('.new-chat select[aria-label="Esforço"]') as HTMLSelectElement;
  expect([...effort.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  const perm = document.querySelector('.new-chat select[aria-label="Permissões"]') as HTMLSelectElement;
  expect([...perm.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  await typeInto(model, 'opus');
  await typeInto(effort, 'high');
  await typeInto(perm, 'plan');
  const ta = document.querySelector('.new-chat textarea')!;
  await typeInto(ta, 'tarefa');
  await key('Enter', {}, ta);
  expect(posted).toContainEqual({ type: 'start', prompt: 'tarefa', options: { model: 'opus', effort: 'high', permissionMode: 'plan' } });
  await unmount(root);
});

it('Novo chat: modelo "Outro…" aceita um id completo; id inválido bloqueia criar', async () => {
  const root = await mount();
  await click(btn('+ Novo chat')!);
  const model = document.querySelector('.new-chat select[aria-label="Modelo"]') as HTMLSelectElement;
  await typeInto(model, '__custom');
  const custom = document.querySelector('.new-chat input[aria-label="Id do modelo"]') as HTMLInputElement;
  expect(custom).not.toBeNull();
  await typeInto(document.querySelector('.new-chat textarea')!, 'tarefa');
  await typeInto(custom, '--perigoso');
  expect(byLabel('Criar chat')!.disabled).toBe(true);
  expect(document.querySelector('.new-chat')!.textContent).toContain('Id de modelo inválido');
  await typeInto(custom, 'claude-opus-5-5');
  expect(byLabel('Criar chat')!.disabled).toBe(false);
  await click(byLabel('Criar chat')!);
  expect(posted).toContainEqual({ type: 'start', prompt: 'tarefa', options: { model: 'claude-opus-5-5' } });
  await unmount(root);
});

it('o cartão mostra a CLI e as opções do chat nas pílulas do rodapé do campo', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...done, options: { model: 'opus', effort: 'high' } }, { ...chat('s', 'Padrão', 'done') }] });
  const sel = (id: string, label: string) => card(id).querySelector(`.composer-footer select[aria-label="${label}"]`) as HTMLSelectElement;
  expect(sel('r', 'Modelo').value).toBe('opus');
  expect(sel('r', 'Esforço').value).toBe('high');
  expect(sel('r', 'Permissões').value).toBe('');
  expect(sel('s', 'Modelo').value).toBe('');
  expect(card('r').querySelector('.chat-cli')!.textContent).toBe('Claude Code');
  await unmount(root);
});

// ---------- novo agente ----------
it('Novo agente com um chat: lista agentes, envia spawn para ele; sem seletor de conversa; Esc cancela', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await click(btn('+ Novo agente')!);
  expect(posted).toContainEqual({ type: 'listAgents' });
  const dlg = document.querySelector('.new-node')!;
  expect(dlg.querySelector('select[aria-label="Conversa"]')).toBeNull();
  await send({ type: 'agents', agents: [{ name: 'reader', description: 'Lê arquivos' }, { name: 'Plan', description: 'Planeja' }] });
  const select = dlg.querySelector('select[aria-label="Agente"]')!;
  expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual(['reader', 'Plan']);
  await typeInto(dlg.querySelector('textarea')!, 'leia notes.txt');
  await typeInto(select, 'Plan');
  expect(byLabel('Criar node')!.className).toContain('send-btn');
  await key('Enter', {}, dlg.querySelector('textarea')!); // Enter também cria
  expect(posted).toContainEqual({ type: 'spawn', agentType: 'Plan', task: 'leia notes.txt', runId: 'r' });
  await click(btn('+ Novo agente')!);
  await key('Escape');
  expect(document.querySelector('.new-node')).toBeNull();
  await unmount(root);
});

it('Novo agente: chats ocupados são marcados e bloqueiam criar; o padrão é o mais recente livre', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('a', 'Livre', 'done'), chat('b', 'Rodando', 'running')] });
  await click(btn('+ Novo agente')!);
  await send({ type: 'agents', agents: [{ name: 'reader', description: '' }] });
  const sel = document.querySelector('.new-node select[aria-label="Conversa"]') as HTMLSelectElement;
  expect([...sel.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Livre', 'Rodando (ocupado)']);
  expect(sel.value).toBe('a');
  await typeInto(document.querySelector('.new-node textarea')!, 'tarefa');
  await typeInto(sel, 'b');
  expect(byLabel('Criar node')!.disabled).toBe(true);
  expect((document.querySelector('.new-node textarea') as HTMLTextAreaElement).value).toBe('tarefa');
  await unmount(root);
});

it('Novo agente sem nenhum chat avisa que criará uma conversa e envia runId nulo', async () => {
  const root = await mount();
  await click(btn('+ Novo agente')!);
  await send({ type: 'agents', agents: [{ name: 'reader', description: '' }] });
  expect(document.querySelector('.new-node')!.textContent).toContain('nova conversa');
  await typeInto(document.querySelector('.new-node textarea')!, 'tarefa');
  await click(byLabel('Criar node')!);
  expect(posted).toContainEqual({ type: 'spawn', agentType: 'reader', task: 'tarefa', runId: null });
  await unmount(root);
});

// ---------- iniciando, fundo inerte ----------
it('"Iniciando conversa…" aparece enquanto o host detecta o CLI e permite cancelar o início', async () => {
  const root = await mount();
  await send({ type: 'starting', count: 1 });
  expect(document.querySelector('.starting')!.textContent).toContain('Iniciando conversa');
  await click(btn('Cancelar início')!);
  expect(posted).toContainEqual({ type: 'cancelPending' });
  await send({ type: 'starting', count: 0 });
  expect(document.querySelector('.starting')).toBeNull();
  await unmount(root);
});

it('com um diálogo aberto o fundo fica inerte; o menu não bloqueia', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run] });
  const inert = () => ['.banners', '.canvas', '.toolbar'].map((s) => document.querySelector(s)!.hasAttribute('inert'));
  expect(inert()).toEqual([false, false, false]);
  await rightClick(document.querySelector('.canvas')!);
  expect(inert()).toEqual([false, false, false]);
  await key('Escape');
  await click(btn('+ Novo chat')!);
  expect(inert()).toEqual([true, true, true]);
  await key('Escape');
  await click(nodeEl('r:a'));
  expect(inert()).toEqual([true, true, true]);
  await unmount(root);
});

// ---------- revisão: seleção/redimensionar, rótulos, ✕ com chat ocupado ----------
it('as alças de redimensionar ficam sempre visíveis; clicar no cartão o seleciona (borda plena) e clicar em outro troca a seleção', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run, chat('s', 'Outro', 'done')] });
  // as alças existem sempre (descobríveis); a seleção só destaca o cartão
  expect(nodeEl('r:root').querySelector('.react-flow__resize-control')).not.toBeNull();
  expect(card('r').className).not.toContain('is-selected');
  await click(nodeEl('r:root'));
  expect(card('r').className).toContain('is-selected');
  expect(card('s').className).not.toContain('is-selected');
  await click(nodeEl('s:root'));
  expect(card('r').className).not.toContain('is-selected');
  expect(card('s').className).toContain('is-selected');
  await unmount(root);
});

it('na conversa do cartão a pessoa é "Você"; no inspetor do agente o texto do orquestrador é "Prompt"', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await send({ type: 'chat_log', runId: 'r', events: logEvents, total: 4 });
  expect(card('r').querySelector('.log-user .log-role')!.textContent).toBe('Você');
  await click(nodeEl('r:a'));
  await send({ type: 'node_log', nodeId: 'r:a', events: logEvents, total: 4 });
  expect(document.querySelector('[role="dialog"] .log-user .log-role')!.textContent).toBe('Prompt');
  await unmount(root);
});

it('chat ocupado (aguardando a CLI/confirmação) mostra o ✕ de cancelar e esconde o Remover', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('b', 'Ocupado', 'done', {}, true)] });
  expect(byLabel('Cancelar conversa', card('b'))).not.toBeNull();
  expect(byLabel('Remover conversa', card('b'))).toBeNull();
  await click(byLabel('Cancelar conversa', card('b'))!);
  expect(posted).toContainEqual({ type: 'cancel', runId: 'b' });
  await unmount(root);
});

it('o campo do cartão rola sem dar zoom no canvas (nowheel) e não arrasta o cartão (nodrag)', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  const composer = card('r').querySelector('.composer')!;
  expect(composer.className).toContain('nodrag');
  expect(composer.className).toContain('nowheel');
  await unmount(root);
});

// ---------- menu de contexto: fecha clicando no canvas ----------
it('o menu de botão direito fecha ao clicar no canvas mesmo quando o React Flow consome o evento', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [run] });
  const pane = document.querySelector('.react-flow__pane')!;
  pane.addEventListener('mousedown', (e) => e.stopPropagation()); // imita o d3-zoom/React Flow engolindo o evento
  pane.addEventListener('pointerdown', (e) => e.stopPropagation());
  await rightClick(pane);
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => { pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();

  await rightClick(pane);
  await act(async () => { pane.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await unmount(root);
});

it('o menu fecha ao rolar/dar zoom, ao perder o foco da janela e é substituído por outro botão direito', async () => {
  const root = await mount();
  await rightClick(document.querySelector('.canvas')!, 50, 60);
  await act(async () => { window.dispatchEvent(new Event('blur')); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await rightClick(document.querySelector('.canvas')!, 50, 60);
  await act(async () => { document.querySelector('.canvas')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await rightClick(document.querySelector('.canvas')!, 10, 10);
  await rightClick(document.querySelector('.canvas')!, 200, 150);
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  expect((document.querySelector('[role="menu"]') as HTMLElement).style.left).toBe('200px');
  await unmount(root);
});

// ---------- anexos ----------
const files = [{ path: '/proj/a.ts', name: 'a.ts', isDir: false }, { path: '/proj/docs', name: 'docs', isDir: true }];
const reqIdOf = () => (posted.filter((m) => m.type === 'pickFiles').at(-1) as any).requestId as string;

it('clipe da barra de baixo: pede o seletor, mostra etiquetas removíveis e envia os caminhos junto', async () => {
  const root = await mount();
  await click(byLabel('Anexar arquivos', document.querySelector('.toolbar')!)!);
  const id = reqIdOf();
  await send({ type: 'files', requestId: id, files });
  const chips = [...document.querySelectorAll('.toolbar .chip')];
  expect(chips.map((c) => c.textContent)).toEqual(['a.ts×', 'docs×']);
  expect(chips[0]!.getAttribute('title')).toBe('/proj/a.ts');
  await click(byLabel('Remover anexo docs')!);
  expect(document.querySelectorAll('.toolbar .chip')).toHaveLength(1);
  const ta = document.querySelector('.toolbar textarea')!;
  await typeInto(ta, 'analise');
  await key('Enter', {}, ta);
  expect(posted).toContainEqual({ type: 'start', prompt: 'analise', attachments: ['/proj/a.ts'] });
  expect(document.querySelectorAll('.toolbar .chip')).toHaveLength(0);
  await unmount(root);
});

it('colar um print (Cmd+V) no campo envia a imagem ao host; colar texto segue normal', async () => {
  const root = await mount();
  const ta = document.querySelector('.toolbar textarea')!;
  const paste = (items: unknown[]) => {
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as any;
    ev.clipboardData = { items };
    ta.dispatchEvent(ev);
    return ev as Event;
  };
  const text = paste([{ kind: 'string', type: 'text/plain', getAsFile: () => null }]);
  expect(text.defaultPrevented).toBe(false);
  const png = new File([new Uint8Array([137, 80, 78, 71])], 'print.png', { type: 'image/png' });
  const ev = paste([{ kind: 'file', type: 'image/png', getAsFile: () => png }]);
  expect(ev.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ type: 'pasteImage', mime: 'image/png', data: 'iVBORw==' })));
  const id = (posted.find((m) => m.type === 'pasteImage') as any).requestId as string;
  await send({ type: 'files', requestId: id, files: [{ path: '/tmp/visor-paste/p.png', name: 'p.png', isDir: false }] });
  expect([...document.querySelectorAll('.toolbar .chip')].map((c) => c.textContent)).toEqual(['p.png×']);
  await unmount(root);
});

it('só anexo, sem texto, já pode enviar; o resultado de outro campo (requestId diferente) não vaza', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await click(byLabel('Anexar arquivos', card('r'))!);
  const idCard = reqIdOf();
  await send({ type: 'files', requestId: 'outro-campo', files });
  expect(card('r').querySelectorAll('.chip')).toHaveLength(0);
  expect(document.querySelectorAll('.toolbar .chip')).toHaveLength(0);
  await send({ type: 'files', requestId: idCard, files: [files[0]!] });
  expect(byLabel('Enviar', card('r'))!.disabled).toBe(false);
  await click(byLabel('Enviar', card('r'))!);
  expect(posted).toContainEqual({ type: 'send', nodeId: 'r:root', text: '', attachments: ['/proj/a.ts'] });
  await unmount(root);
});

it('limite de 10 anexos por mensagem e sem duplicatas', async () => {
  const root = await mount();
  await click(byLabel('Anexar arquivos', document.querySelector('.toolbar')!)!);
  const id = reqIdOf();
  const many = Array.from({ length: 14 }, (_, i) => ({ path: `/p/f${i}`, name: `f${i}`, isDir: false }));
  await send({ type: 'files', requestId: id, files: many });
  expect(document.querySelectorAll('.toolbar .chip')).toHaveLength(10);
  await click(byLabel('Anexar arquivos', document.querySelector('.toolbar')!)!);
  await send({ type: 'files', requestId: reqIdOf(), files: [many[0]!] });
  expect(document.querySelectorAll('.toolbar .chip')).toHaveLength(10);
  await unmount(root);
});

it('a conversa mostra os anexos da mensagem do usuário como etiquetas', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await send({ type: 'chat_log', runId: 'r', total: 1, events: [{ id: 'e1', seq: 1, ts: 1, kind: 'message', payload: { role: 'user', text: 'olhe', attachments: ['a.ts', 'docs'] } }] as any });
  expect([...card('r').querySelectorAll('.log-user .chip')].map((c) => c.textContent)).toEqual(['a.ts', 'docs']);
  await unmount(root);
});

// ---------- menu "/" ----------
const cmds = [
  { name: 'ping', kind: 'command', group: 'comando' },
  { name: 'superpowers:brainstorming', kind: 'skill', group: 'superpowers' },
  { name: 'superpowers:executing-plans', kind: 'skill', group: 'superpowers' },
] as const;
const slash = () => document.querySelector('[role="listbox"]');
const slashItems = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.querySelector('.slash-name')!.textContent);

it('digitar "/" no começo abre o menu (e pede as capacidades uma vez); filtra ao digitar', async () => {
  const root = await mount();
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), '/');
  expect(posted.filter((m) => m.type === 'listCapabilities')).toHaveLength(1);
  await send({ type: 'capabilities', commands: cmds as any });
  expect(slashItems()).toEqual(['/ping', '/superpowers:brainstorming', '/superpowers:executing-plans']);
  expect(document.querySelector('[role="option"] .slash-group')!.textContent).toBe('comando');
  await typeInto(ta(), '/sup');
  expect(slashItems()).toEqual(['/superpowers:brainstorming', '/superpowers:executing-plans']);
  await typeInto(ta(), '/plans');
  expect(slashItems()).toEqual(['/superpowers:executing-plans']);
  await typeInto(ta(), '/zzz');
  expect(slash()).toBeNull();
  await unmount(root);
});

it('o menu "/" fecha depois que o comando é seguido de espaço', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: cmds as any });
  const ta = document.querySelector('.toolbar textarea')!;
  await typeInto(ta, '/ping com argumentos');
  expect(slash()).toBeNull();
  await unmount(root);
});

it('teclado no menu "/": setas navegam, Tab ou Enter inserem "/nome " (Enter NÃO envia), Esc fecha', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: cmds as any });
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), '/');
  expect(document.querySelector('[role="option"][aria-selected="true"] .slash-name')!.textContent).toBe('/ping');
  await key('ArrowDown', {}, ta());
  expect(document.querySelector('[role="option"][aria-selected="true"] .slash-name')!.textContent).toBe('/superpowers:brainstorming');
  await key('ArrowUp', {}, ta());
  await key('ArrowUp', {}, ta()); // dá a volta
  expect(document.querySelector('[role="option"][aria-selected="true"] .slash-name')!.textContent).toBe('/superpowers:executing-plans');
  await key('Enter', {}, ta());
  expect(ta().value).toBe('/superpowers:executing-plans ');
  expect(slash()).toBeNull();
  expect(posted.filter((m) => m.type === 'start')).toHaveLength(0);

  await typeInto(ta(), '/pi');
  await key('Tab', {}, ta());
  expect(ta().value).toBe('/ping ');

  await typeInto(ta(), '/s');
  expect(slash()).not.toBeNull();
  await key('Escape', {}, ta());
  expect(slash()).toBeNull();
  expect(ta().value).toBe('/s');
  await key('Enter', {}, ta()); // com o menu fechado, Enter envia normalmente
  expect(posted).toContainEqual({ type: 'start', prompt: '/s' });
  await unmount(root);
});

it('clicar num item do menu "/" insere o comando; o menu também funciona no campo do cartão', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  await send({ type: 'capabilities', commands: cmds as any });
  const ta = card('r').querySelector('.composer textarea') as HTMLTextAreaElement;
  await typeInto(ta, '/pin');
  const opt = card('r').querySelector('[role="option"]')!;
  await act(async () => { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
  expect((card('r').querySelector('.composer textarea') as HTMLTextAreaElement).value).toBe('/ping ');
  await key('Enter', {}, card('r').querySelector('.composer textarea')!);
  expect(posted).toContainEqual({ type: 'send', nodeId: 'r:root', text: '/ping ' });
  await unmount(root);
});

// ---------- revisão: IME no menu "/", só Codex instalado ----------
it('Enter de confirmação de IME (keyCode 229) não escolhe item do menu "/" nem envia', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: cmds as any });
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), '/pi');
  expect(slash()).not.toBeNull();
  await key('Enter', { keyCode: 229 }, ta());
  expect(ta().value).toBe('/pi');
  expect(slash()).not.toBeNull();
  expect(posted.filter((m) => m.type === 'start')).toHaveLength(0);
  await unmount(root);
});

it('se só uma CLI sem suporte (Codex) está instalada, o diálogo avisa e não deixa criar chat', async () => {
  const root = await mount();
  await click(btn('+ Novo chat')!);
  await send({ type: 'clis', clis: [{ id: 'codex', label: 'Codex', version: '0.157.1', supported: false }] });
  const dlg = document.querySelector('.new-chat')!;
  expect(dlg.textContent).toContain('Nenhuma CLI suportada');
  await typeInto(dlg.querySelector('textarea')!, 'tarefa');
  expect(byLabel('Criar chat')!.disabled).toBe(true);
  await unmount(root);
});

// ---------- campo no padrão do Claude Code: caixa única, rodapé de controles, crescimento automático ----------
const inOrder = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

it('o campo é UMA caixa: texto em cima e, embaixo, o rodapé com clipe, "/" e o botão de enviar à direita', async () => {
  const root = await mount();
  const box = document.querySelector('.toolbar .composer-box')!;
  const ta = box.querySelector('textarea')!;
  const footer = box.querySelector('.composer-footer')!;
  expect(inOrder(ta, footer)).toBe(true);
  expect(footer.querySelector('button[aria-label="Anexar arquivos"]')).not.toBeNull();
  expect(footer.querySelector('button[aria-label="Skills e comandos"]')).not.toBeNull();
  expect(footer.lastElementChild!.getAttribute('aria-label')).toBe('Executar'); // enviar sempre no fim (direita)
  expect(box.querySelector('.footer-left button[aria-label="Anexar arquivos"]')).not.toBeNull();
  await unmount(root);
});

it('o botão "/" do rodapé abre o menu de skills (insere a barra num campo vazio e pede os comandos)', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: cmds as any });
  await click(byLabel('Skills e comandos', document.querySelector('.toolbar')!)!);
  expect((document.querySelector('.toolbar textarea') as HTMLTextAreaElement).value).toBe('/');
  expect(slashItems()).toContain('/ping');
  await unmount(root);
});

it('o texto cresce sozinho até um limite e depois rola; não há como redimensionar à mão', async () => {
  const root = await mount();
  const proto = HTMLTextAreaElement.prototype;
  const orig = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  let h = 40;
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => h });
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  h = 120;
  await typeInto(ta(), 'uma\nlinha\ncomprida');
  expect(ta().style.height).toBe('120px');
  expect(ta().style.overflowY).toBe('hidden');
  h = 900;
  await typeInto(ta(), 'x'.repeat(5000));
  expect(ta().style.height).toBe('200px'); // limite
  expect(ta().style.overflowY).toBe('auto');
  expect(ta().getAttribute('data-autogrow')).toBe('true'); // o CSS usa isto para tirar a alça de resize
  if (orig) Object.defineProperty(proto, 'scrollHeight', orig); else delete (proto as any).scrollHeight;
  await unmount(root);
});

// ---------- modelo e esforço ANTES do primeiro prompt, ao lado de "Novo agente" ----------
it('barra de baixo: modelo e esforço ficam na linha de baixo, ao lado de "+ Novo agente", e valem para o próximo chat', async () => {
  const root = await mount();
  const meta = document.querySelector('.toolbar-meta')!;
  const model = meta.querySelector('select[aria-label="Modelo"]') as HTMLSelectElement;
  const effort = meta.querySelector('select[aria-label="Esforço"]') as HTMLSelectElement;
  expect(model).not.toBeNull();
  expect(effort).not.toBeNull();
  expect(inOrder(btn('+ Novo agente')!, model)).toBe(true);
  expect([...model.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'fable', 'opus', 'sonnet', 'haiku', '__custom']);
  expect([...effort.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  await typeInto(model, 'opus');
  await typeInto(effort, 'high');
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), 'primeira');
  await key('Enter', {}, ta());
  expect(posted).toContainEqual({ type: 'start', prompt: 'primeira', options: { model: 'opus', effort: 'high' } });
  await typeInto(ta(), 'segunda');
  await key('Enter', {}, ta());
  expect(posted.at(-1)).toEqual({ type: 'start', prompt: 'segunda', options: { model: 'opus', effort: 'high' } }); // a escolha permanece
  await unmount(root);
});

it('sem escolher nada o chat usa os padrões (nenhuma option enviada); a dica do "Padrão" mostra o modelo real do CLI', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: [], defaultModel: 'claude-sonnet-5-5' });
  expect(document.querySelector('.toolbar-meta select[aria-label="Modelo"] option[value=""]')!.textContent).toBe('Padrão');
  expect(document.querySelector('.toolbar-meta label.pill')!.getAttribute('title')).toContain('claude-sonnet-5-5'); // o modelo real aparece na dica
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), 'tarefa');
  await key('Enter', {}, ta());
  expect(posted).toContainEqual({ type: 'start', prompt: 'tarefa' });
  await unmount(root);
});

it('o diálogo de novo chat já abre com o modelo/esforço escolhidos na barra', async () => {
  const root = await mount();
  await typeInto(document.querySelector('.toolbar-meta select[aria-label="Modelo"]')!, 'sonnet');
  await typeInto(document.querySelector('.toolbar-meta select[aria-label="Esforço"]')!, 'low');
  await click(btn('+ Novo chat')!);
  expect((document.querySelector('.new-chat select[aria-label="Modelo"]') as HTMLSelectElement).value).toBe('sonnet');
  expect((document.querySelector('.new-chat select[aria-label="Esforço"]') as HTMLSelectElement).value).toBe('low');
  await unmount(root);
});

// ---------- diálogos padronizados: os selects ficam ABAIXO do campo, no rodapé ----------
it('Novo chat: o campo vem primeiro e os selects (CLI, modelo, esforço, permissões) ficam no rodapé da caixa, antes do enviar', async () => {
  const root = await mount();
  await click(btn('+ Novo chat')!);
  const dlg = document.querySelector('.new-chat')!;
  const ta = dlg.querySelector('textarea')!;
  const footer = dlg.querySelector('.composer-footer')!;
  expect(inOrder(ta, footer)).toBe(true);
  for (const label of ['CLI', 'Modelo', 'Esforço', 'Permissões']) {
    const sel = dlg.querySelector(`select[aria-label="${label}"]`)!;
    expect(footer.contains(sel)).toBe(true);
    expect(inOrder(ta, sel)).toBe(true);
  }
  expect(footer.lastElementChild!.getAttribute('aria-label')).toBe('Criar chat');
  await unmount(root);
});

it('Novo agente: o campo vem primeiro e "Conversa"/"Agente" ficam no rodapé da caixa', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('a', 'Um', 'done'), chat('b', 'Dois', 'done')] });
  await click(btn('+ Novo agente')!);
  await send({ type: 'agents', agents: [{ name: 'reader', description: 'Lê' }] });
  const dlg = document.querySelector('.new-node')!;
  const ta = dlg.querySelector('textarea')!;
  const footer = dlg.querySelector('.composer-footer')!;
  expect(inOrder(ta, footer)).toBe(true);
  expect(footer.contains(dlg.querySelector('select[aria-label="Agente"]'))).toBe(true);
  expect(footer.contains(dlg.querySelector('select[aria-label="Conversa"]'))).toBe(true);
  expect(footer.lastElementChild!.getAttribute('aria-label')).toBe('Criar node');
  await unmount(root);
});

// ---------- alças do cartão: escondidas, só aparecem com o mouse no canto ----------
it('as alças de redimensionar existem (para funcionar), mas escondidas por padrão: o CSS só as revela no canto', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  const handle = card('r').querySelector('.react-flow__resize-control.handle')!;
  expect(handle.className).toContain('chat-resize-handle');
  const css = (await import('node:fs')).readFileSync('webview/styles.css', 'utf8');
  const rule = css.match(/\.chat-resize-handle\.react-flow__resize-control\.handle\s*\{([^}]*)\}/)![1]!;
  expect(rule).toMatch(/opacity:\s*0/);
  expect(css).toMatch(/\.chat-resize-handle\.react-flow__resize-control\.handle:hover\s*\{[^}]*opacity:\s*1/);
  await unmount(root);
});

// ---------- revisão: largura, cartão, menu no diálogo, foco, "/" , placeholder ----------
function mockScrollHeight(fn: (el: HTMLTextAreaElement) => number) {
  const proto = HTMLTextAreaElement.prototype;
  const orig = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return fn(this as HTMLTextAreaElement); } });
  return () => { if (orig) Object.defineProperty(proto, 'scrollHeight', orig); else delete (proto as any).scrollHeight; };
}

it('o campo é medido de novo quando a LARGURA muda (ResizeObserver), em vez de esconder texto', async () => {
  const instances: { cb: ResizeObserverCallback; el?: Element }[] = [];
  const prevRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class { constructor(public cb: ResizeObserverCallback) { instances.push({ cb }); } observe(el: Element) { instances.at(-1)!.el = el; } unobserve() {} disconnect() {} };
  let h = 40;
  const restore = mockScrollHeight(() => h);
  const root = await mount();
  const ta = document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta, 'texto');
  expect(ta.style.height).toBe('40px');
  h = 80; // a janela ficou estreita: o mesmo texto agora ocupa duas linhas
  const ro = instances.find((i) => i.el === ta)!;
  await act(async () => { ro.cb([{ contentRect: { width: 300 } } as ResizeObserverEntry], {} as ResizeObserver); });
  expect(ta.style.height).toBe('80px');
  await unmount(root);
  restore();
  (globalThis as any).ResizeObserver = prevRO;
});

it('um placeholder que quebra em várias linhas entra na medição quando o campo está vazio', async () => {
  const restore = mockScrollHeight((el) => (el.value === el.placeholder ? 80 : 20));
  const root = await mount();
  const ta = document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  expect(ta.style.height).toBe('80px');
  expect(ta.value).toBe(''); // o valor real foi restaurado
  await typeInto(ta, 'oi');
  expect(ta.style.height).toBe('20px');
  await unmount(root);
  restore();
});

it('no cartão o campo cresce menos (3 linhas) para não engolir a conversa; no inspetor pode crescer mais', async () => {
  const restore = mockScrollHeight(() => 900);
  const root = await mount();
  await send({ type: 'snapshot', runs: [done] });
  const cardTa = card('r').querySelector('.composer textarea') as HTMLTextAreaElement;
  await typeInto(cardTa, 'x'.repeat(2000));
  expect(cardTa.style.height).toBe('72px');
  await click(nodeEl('r:a'));
  const modalTa = document.querySelector('[role="dialog"] .composer textarea') as HTMLTextAreaElement;
  await typeInto(modalTa, 'x'.repeat(2000));
  expect(modalTa.style.height).toBe('160px');
  const css = (await import('node:fs')).readFileSync('webview/styles.css', 'utf8');
  expect(css).toMatch(/\.chat-log\s*\{[^}]*min-height:\s*60px/);
  await unmount(root);
  restore();
});

it('o menu "/" aparece no diálogo de novo chat (o corpo do diálogo não corta o menu)', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: cmds as any });
  await click(btn('+ Novo chat')!);
  await typeInto(document.querySelector('.new-chat textarea')!, '/');
  expect(slash()).not.toBeNull();
  const css = (await import('node:fs')).readFileSync('webview/styles.css', 'utf8');
  expect(css).toMatch(/\.new-chat \.modal-body[^{]*\{[^}]*overflow:\s*visible/);
  await unmount(root);
});

it('selects e botões do campo têm indicação de foco por teclado', async () => {
  const css = (await import('node:fs')).readFileSync('webview/styles.css', 'utf8');
  expect(css).toMatch(/\.pill:focus-within\s*\{[^}]*outline:\s*[^;0]/);
  expect(css).toMatch(/\.icon-btn:focus-visible\s*\{/);
});

it('ao fechar Novo agente/Novo chat o foco volta ao botão que abriu o diálogo', async () => {
  const root = await mount();
  const novoAgente = btn('+ Novo agente')!;
  novoAgente.focus();
  await click(novoAgente);
  await key('Escape');
  expect(document.activeElement).toBe(novoAgente);
  const novoChat = btn('+ Novo chat')!;
  novoChat.focus();
  await click(novoChat);
  await key('Escape');
  expect(document.activeElement).toBe(novoChat);
  await unmount(root);
});

it('o botão "/": abre/reabre o menu e insere a barra depois do texto', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: cmds as any });
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  const slashBtn = () => byLabel('Skills e comandos', document.querySelector('.toolbar')!)!;
  expect(slashBtn().disabled).toBe(false);
  await typeInto(ta(), 'olá, mundo');
  expect(slashBtn().disabled).toBe(false);
  await typeInto(ta(), '/pi');
  await key('Escape', {}, ta());
  expect(slash()).toBeNull();
  await click(slashBtn()); // reabre depois de dispensado
  expect(slash()).not.toBeNull();
  await unmount(root);
});

it('o menu "/" abre no meio da mensagem e substitui só o trecho digitado', async () => {
  const root = await mount();
  await send({ type: 'capabilities', commands: cmds as any });
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), 'rode antes /pi');
  expect(slashItems()).toEqual(['/ping']);
  await key('Enter', {}, ta());
  expect(ta().value).toBe('rode antes /ping ');
  await typeInto(ta(), 'http://x/pi');
  expect(slash()).toBeNull(); // barra no meio de uma palavra não é comando
  await unmount(root);
});

// ---------- Codex e opções por CLI ----------
const bothClis = [
  { id: 'claude', label: 'Claude Code', version: '2.1.287', supported: true },
  { id: 'codex', label: 'Codex', version: '0.157.1', supported: true },
] as const;
const meta = () => document.querySelector('.toolbar-meta')!;
const metaSel = (label: string) => meta().querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;

it('barra: CLI, Modelo, Esforço e Permissões ficam ao lado de "+ Novo agente"; a CLI lista só as instaladas', async () => {
  const root = await mount();
  await send({ type: 'clis', clis: bothClis as any });
  const order = [...meta().querySelectorAll('select')].map((s) => s.getAttribute('aria-label'));
  expect(order).toEqual(['CLI', 'Modelo', 'Esforço', 'Permissões']);
  expect(inOrder(btn('+ Novo agente')!, metaSel('CLI'))).toBe(true);
  expect([...metaSel('CLI').querySelectorAll('option')].map((o) => o.value)).toEqual(['claude', 'codex']);
  expect([...metaSel('Permissões').querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
  await unmount(root);
});

it('trocar a CLI para Codex muda as listas, zera o que não vale, e o próximo chat leva {cli, esforço, sandbox}', async () => {
  const root = await mount();
  await send({ type: 'clis', clis: bothClis as any });
  await typeInto(metaSel('Modelo'), 'opus');
  await typeInto(metaSel('Esforço'), 'max');
  await typeInto(metaSel('Permissões'), 'plan');
  await typeInto(metaSel('CLI'), 'codex');
  expect([...metaSel('Esforço').querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  expect([...metaSel('Permissões').querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'read-only', 'workspace-write', 'danger-full-access']);
  expect([...metaSel('Modelo').querySelectorAll('option')].map((o) => o.value)).toEqual(['', '__custom']);
  expect(metaSel('Modelo').value).toBe('');
  expect(metaSel('Esforço').value).toBe('');
  expect(metaSel('Permissões').value).toBe('');
  await typeInto(metaSel('Esforço'), 'high');
  await typeInto(metaSel('Permissões'), 'read-only');
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), 'tarefa');
  await key('Enter', {}, ta());
  expect(posted).toContainEqual({ type: 'start', prompt: 'tarefa', options: { cli: 'codex', effort: 'high', sandbox: 'read-only' } });
  await unmount(root);
});

it('com o Codex escolhido na barra o botão "/" (skills do Claude) some e o menu não abre', async () => {
  const root = await mount();
  await send({ type: 'clis', clis: bothClis as any });
  await send({ type: 'capabilities', commands: cmds as any });
  await typeInto(metaSel('CLI'), 'codex');
  expect(byLabel('Skills e comandos', document.querySelector('.toolbar')!)).toBeNull();
  await typeInto(document.querySelector('.toolbar textarea')!, '/');
  expect(slash()).toBeNull();
  await unmount(root);
});

it('barra: "Outro…" abre o campo de id do modelo; id inválido não é enviado; válido vai nas opções', async () => {
  const root = await mount();
  await send({ type: 'clis', clis: bothClis as any });
  await typeInto(metaSel('CLI'), 'codex');
  await typeInto(metaSel('Modelo'), '__custom');
  const input = () => meta().querySelector('input[aria-label="Id do modelo"]') as HTMLInputElement;
  expect(input()).not.toBeNull();
  await typeInto(input(), '--perigoso');
  expect(input().getAttribute('aria-invalid')).toBe('true');
  const ta = () => document.querySelector('.toolbar textarea') as HTMLTextAreaElement;
  await typeInto(ta(), 'a');
  await key('Enter', {}, ta());
  expect(posted.at(-1)).toEqual({ type: 'start', prompt: 'a', options: { cli: 'codex' } }); // modelo inválido não vai
  await typeInto(input(), 'gpt-5-codex');
  expect(input().getAttribute('aria-invalid')).toBe('false');
  await typeInto(ta(), 'b');
  await key('Enter', {}, ta());
  expect(posted.at(-1)).toEqual({ type: 'start', prompt: 'b', options: { cli: 'codex', model: 'gpt-5-codex' } });
  await unmount(root);
});

it('cartão: mudar modelo/esforço/permissões nas pílulas envia setOptions com as opções completas do chat; "Padrão" remove', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...done, options: { model: 'opus' } }] });
  const sel = (label: string) => card('r').querySelector(`.composer-footer select[aria-label="${label}"]`) as HTMLSelectElement;
  await typeInto(sel('Esforço'), 'high');
  expect(posted).toContainEqual({ type: 'setOptions', runId: 'r', options: { model: 'opus', effort: 'high' } });
  await typeInto(sel('Permissões'), 'plan');
  expect(posted.at(-1)).toEqual({ type: 'setOptions', runId: 'r', options: { model: 'opus', permissionMode: 'plan' } }); // parte do estado do HOST (props), não acumula local
  await typeInto(sel('Modelo'), '');
  expect(posted.at(-1)).toEqual({ type: 'setOptions', runId: 'r', options: {} });
  await unmount(root);
});

it('cartão de um chat do Codex: etiqueta "Codex", pílulas do Codex, sem "+ agente" e sem menu "/"', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...done, options: { cli: 'codex', sandbox: 'read-only', effort: 'low' } }] });
  expect(card('r').querySelector('.chat-cli')!.textContent).toBe('Codex');
  expect(byLabel('Chamar agente neste chat', card('r'))).toBeNull();
  const perm = card('r').querySelector('select[aria-label="Permissões"]') as HTMLSelectElement;
  expect([...perm.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'read-only', 'workspace-write', 'danger-full-access']);
  expect(perm.value).toBe('read-only');
  expect(card('r').querySelector('select[aria-label="CLI"]')).toBeNull(); // a CLI é fixa por chat
  expect(card('r').querySelector('button[aria-label="Skills e comandos"]')).toBeNull();
  await typeInto(perm, 'workspace-write');
  expect(posted.at(-1)).toEqual({ type: 'setOptions', runId: 'r', options: { cli: 'codex', effort: 'low', sandbox: 'workspace-write' } });
  await unmount(root);
});

it('Novo chat: o Codex é selecionável; ao escolhê-lo as listas mudam e o chat é criado com {cli, sandbox}', async () => {
  const root = await mount();
  await click(btn('+ Novo chat')!);
  await send({ type: 'clis', clis: bothClis as any });
  const dlg = document.querySelector('.new-chat')!;
  await typeInto(dlg.querySelector('select[aria-label="CLI"]')!, 'codex');
  const perm = dlg.querySelector('select[aria-label="Permissões"]') as HTMLSelectElement;
  expect([...perm.querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'read-only', 'workspace-write', 'danger-full-access']);
  await typeInto(perm, 'danger-full-access');
  const ta = dlg.querySelector('textarea')!;
  await typeInto(ta, 'faça');
  await key('Enter', {}, ta);
  expect(posted).toContainEqual({ type: 'start', prompt: 'faça', options: { cli: 'codex', sandbox: 'danger-full-access' } });
  await unmount(root);
});

it('o diálogo já abre com a CLI/modelo/esforço escolhidos na barra', async () => {
  const root = await mount();
  await send({ type: 'clis', clis: bothClis as any });
  await typeInto(metaSel('CLI'), 'codex');
  await typeInto(metaSel('Esforço'), 'medium');
  await click(btn('+ Novo chat')!);
  const dlg = document.querySelector('.new-chat')!;
  expect((dlg.querySelector('select[aria-label="CLI"]') as HTMLSelectElement).value).toBe('codex');
  expect((dlg.querySelector('select[aria-label="Esforço"]') as HTMLSelectElement).value).toBe('medium');
  await unmount(root);
});

it('o diagnóstico de login aparece por CLI: Claude e Codex juntos; um problema do Codex vira aviso próprio', async () => {
  const root = await mount();
  await send({ type: 'prefs', authBannerDismissed: false });
  await send({ type: 'cli', check: ok });
  await send({ type: 'cli', cli: 'codex', check: { state: 'ok', version: '0.157.1', authMethod: 'ChatGPT' } });
  const info = document.querySelector('.banner.info')!.textContent!;
  expect(info).toContain('claude.ai');
  expect(info).toContain('Codex');
  expect(info).toContain('ChatGPT');
  await send({ type: 'cli', cli: 'codex', check: { state: 'not_authenticated', version: '0.157.1', message: 'Rode codex login.' } });
  expect(document.querySelector('.banner.error')!.textContent).toContain('Rode codex login.');
  expect(document.querySelector('.banner.info')!.textContent).toContain('claude.ai'); // o Claude segue ok
  await send({ type: 'prefs', authBannerDismissed: true });
  await click(byLabel('Conta e uso')!);
  const panel = document.querySelector('[role="dialog"][aria-label="Conta e uso"]')!;
  expect(panel.textContent).toContain('Codex');
  expect(panel.textContent).toContain('sem login');
  await click([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Fazer login') as HTMLButtonElement);
  expect(posted).toContainEqual({ type: 'loginCli', cli: 'codex' });
  await unmount(root);
});

it('Novo agente não oferece chats do Codex (não há subagentes lá)', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...done, options: { cli: 'codex' } }, chat('s', 'Claude', 'done')] });
  await click(btn('+ Novo agente')!);
  await send({ type: 'agents', agents: [{ name: 'reader', description: '' }] });
  const dlg = document.querySelector('.new-node')!;
  expect(dlg.querySelector('select[aria-label="Conversa"]')).toBeNull(); // só sobrou um chat elegível
  await typeInto(dlg.querySelector('textarea')!, 'tarefa');
  await key('Enter', {}, dlg.querySelector('textarea')!);
  expect(posted).toContainEqual({ type: 'spawn', agentType: 'reader', task: 'tarefa', runId: 's' });
  await unmount(root);
});

// ---------- configuração inicial dos CLIs ----------
it('ao abrir, pede ao host para verificar os CLIs', async () => {
  const root = await mount();
  expect(posted).toContainEqual({ type: 'recheckCli' });
  await unmount(root);
});

it('CLI não instalado: o aviso oferece instalar, escolher o caminho e verificar de novo', async () => {
  const root = await mount();
  await send({ type: 'cli', check: { state: 'not_installed', message: 'Não encontrei o CLI "claude".' } });
  const banner = document.querySelector('.banner.error')!;
  expect(banner.textContent).toContain('Não encontrei o CLI');
  posted.length = 0;
  await click(btn('Instalar')!);
  await click(btn('Escolher caminho…')!);
  await click(btn('Verificar de novo')!);
  expect(posted).toEqual([
    { type: 'installCli', cli: 'claude' },
    { type: 'pickCliPath', cli: 'claude' },
    { type: 'recheckCli', cli: 'claude' },
  ]);
  await unmount(root);
});

it('CLI sem login: o aviso oferece abrir o login no terminal (do CLI certo)', async () => {
  const root = await mount();
  await send({ type: 'cli', cli: 'codex', check: { state: 'not_authenticated', version: '0.1.0', message: 'Rode codex login.' } });
  posted.length = 0;
  expect(btn('Instalar')).toBeUndefined();
  await click(btn('Fazer login')!);
  expect(posted).toEqual([{ type: 'loginCli', cli: 'codex' }]);
  await unmount(root);
});

// ---------- permissões ----------
const asking = (hasAlways = true, extra: Partial<RunView['nodes'][number]> = {}) =>
  chat('r', 'Permissão', 'running', { permissions: [{ requestId: 'q1', tool: 'Bash', summary: 'rm -rf build', hasAlways }], ...extra }, true);

it('mostra o card de permissão com a ferramenta e o resumo, e os três botões enviam a decisão', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking()] });
  const c = card('r').querySelector('.permission-card')!;
  expect(c).not.toBeNull();
  expect(c.textContent).toContain('Bash');
  expect(c.textContent).toContain('rm -rf build');
  const labels = [...c.querySelectorAll('button')].map((b) => b.textContent);
  expect(labels).toEqual(['Permitir', 'Permitir sempre', 'Negar']);
  vi.useFakeTimers();
  try {
    for (const [label, decision] of [['Permitir', 'allow'], ['Permitir sempre', 'allow_always'], ['Negar', 'deny']] as const) {
      posted.length = 0;
      await click([...c.querySelectorAll('button')].find((b) => b.textContent === label)!);
      expect(posted).toContainEqual({ type: 'permission', runId: 'r', requestId: 'q1', decision });
      await act(async () => { vi.advanceTimersByTime(800); }); // a trava anti-duplo-clique solta
    }
  } finally {
    vi.useRealTimers();
  }
  await unmount(root);
});

it('sem sugestão do CLI não há "Permitir sempre"', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking(false)] });
  expect([...card('r').querySelectorAll('.permission-card button')].map((b) => b.textContent)).toEqual(['Permitir', 'Negar']);
  await unmount(root);
});

it('com vários pedidos mostra um por vez e avisa quantos faltam; sem pedido, o card some', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking(true, { permissions: [
    { requestId: 'q1', tool: 'Bash', summary: 'ls', hasAlways: true },
    { requestId: 'q2', tool: 'Edit', summary: '/p/a.ts', hasAlways: false },
  ] })] });
  expect(card('r').querySelectorAll('.permission-card')).toHaveLength(1);
  expect(card('r').querySelector('.permission-card')!.textContent).toContain('ls');
  expect(card('r').querySelector('.permission-card')!.textContent).toContain('+1 pedido');
  await send({ type: 'snapshot', runs: [chat('r', 'Permissão', 'running', {}, true)] });
  expect(card('r').querySelector('.permission-card')).toBeNull();
  await unmount(root);
});

it('o texto do pedido é exibido como texto (sem interpretar HTML)', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [asking(true, { permissions: [{ requestId: 'q1', tool: 'Bash', summary: '<img src=x onerror=alert(1)>', hasAlways: false }] })] });
  expect(card('r').querySelector('.permission-card img')).toBeNull();
  expect(card('r').querySelector('.permission-card')!.textContent).toContain('<img src=x onerror=alert(1)>');
  await unmount(root);
});

it('um pedido novo NÃO rouba o foco de quem está digitando (Espaço/Enter não aprovam sem querer)', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('r', 'Permissão', 'running', {}, true)] });
  const input = document.querySelector('.toolbar textarea')! as HTMLTextAreaElement;
  input.focus();
  expect(document.activeElement).toBe(input);
  await send({ type: 'snapshot', runs: [asking()] });
  expect(card('r').querySelector('.permission-card')).not.toBeNull();
  expect(document.activeElement).toBe(input);
  await unmount(root);
});

it('duplo clique não aprova o pedido seguinte: os botões ficam travados logo após uma decisão', async () => {
  vi.useFakeTimers();
  try {
    const root = await mount();
    await send({ type: 'snapshot', runs: [asking(true, { permissions: [
      { requestId: 'q1', tool: 'Bash', summary: 'a', hasAlways: false },
      { requestId: 'q2', tool: 'Bash', summary: 'b', hasAlways: false },
    ] })] });
    posted.length = 0;
    const allow = () => [...card('r').querySelectorAll('.permission-card button')].find((b) => b.textContent === 'Permitir') as HTMLButtonElement;
    await click(allow());
    await send({ type: 'snapshot', runs: [asking(true, { permissions: [{ requestId: 'q2', tool: 'Bash', summary: 'b', hasAlways: false }] })] }); // o host já mostra o próximo
    await click(allow()); // segundo clique rápido
    expect(posted.filter((m) => m.type === 'permission')).toEqual([{ type: 'permission', runId: 'r', requestId: 'q1', decision: 'allow' }]);
    await act(async () => { vi.advanceTimersByTime(800); });
    await click(allow());
    expect(posted.filter((m) => m.type === 'permission').map((m) => m.requestId)).toEqual(['q1', 'q2']);
    await unmount(root);
  } finally {
    vi.useRealTimers();
  }
});

const Qv = { text: 'Qual cor?', options: ['Azul', 'Verde'], source: 'marker' as const };
const options = (runId: string) => [...card(runId).querySelectorAll('.question-card button.option')] as HTMLButtonElement[];
const sends = () => posted.filter((m) => m.type === 'send');

it('pergunta com o processo vivo: opção habilitada; o clique envia e mostra "enviando…"', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true }] });
  expect(options('r').every((b) => !b.disabled)).toBe(true);
  await click(options('r')[0]!);
  expect(sends().at(-1)).toMatchObject({ type: 'send', nodeId: 'r:root', text: 'Azul' });
  expect(options('r').every((b) => b.disabled)).toBe(true);
  expect(card('r').textContent).toContain('enviando…');
  await unmount(root);
});

it('answer_ack com falha mostra "Tentar de novo", que reenvia a mesma opção', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true }] });
  await click(options('r')[1]!);
  const before = sends().length;
  await send({ type: 'answer_ack', nodeId: 'r:root', ok: false });
  const retry = [...card('r').querySelectorAll('button')].find((b) => b.textContent === 'Tentar de novo')!;
  expect(retry).toBeTruthy();
  await click(retry);
  expect(sends()).toHaveLength(before + 1);
  expect(sends().at(-1)).toMatchObject({ nodeId: 'r:root', text: 'Verde' });
  await unmount(root);
});

it('turno rodando de verdade: opções desabilitadas com o motivo', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [chat('r', 'P', 'waiting', { question: Qv }, true)] });
  expect(options('r').every((b) => b.disabled)).toBe(true);
  expect(card('r').querySelector('.question-hint')!.textContent).toContain('Aguardando o agente terminar');
  await unmount(root);
});

it('processo parado: "Encerrar processo" cancela e "Continuar esperando" envia keepWaiting', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true, stalled: true }] });
  const stall = card('r').querySelector('.stall-card')!;
  expect(stall.textContent).toContain('tarefa em segundo plano');
  await click([...stall.querySelectorAll('button')].find((b) => b.textContent === 'Encerrar processo')!);
  expect(posted).toContainEqual({ type: 'cancel', runId: 'r' });
  await click([...stall.querySelectorAll('button')].find((b) => b.textContent === 'Continuar esperando')!);
  expect(posted).toContainEqual({ type: 'keepWaiting', runId: 'r' });
  await unmount(root);
});

it('processo vivo: o cartão mostra cancelar e não mostra remover', async () => {
  const root = await mount();
  await send({ type: 'snapshot', runs: [{ ...chat('r', 'P', 'waiting', { question: Qv }), lingering: true }] });
  expect(byLabel('Cancelar conversa', card('r'))).toBeTruthy();
  expect(byLabel('Remover conversa', card('r'))).toBeNull();
  await unmount(root);
});
