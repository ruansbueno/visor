import { describe, it, expect, vi } from 'vitest';
import { RunController, type ControllerDeps } from '../../src/ext/run-controller';
import { DEFAULT_SETTINGS, type VisorSettings } from '../../src/ext/settings';
import type { HostMessage, RunView } from '../../src/protocol';
import type { NormalizedEvent, Question } from '../../src/core/schema';
import type { ProcessRunOptions, ProcessRunResult } from '../../src/cli/process-run';
import type { CliCheck } from '../../src/cli/detect';

const OK: CliCheck = { state: 'ok', version: '2.1.267', authMethod: 'claude.ai' };
const result = (o: Partial<ProcessRunResult> = {}): ProcessRunResult => ({
  exitCode: 0, signal: null, stderrTail: '', malformedLines: 0, cancelled: false, ...o,
});

interface FakeRun {
  runId: string;
  opts: ProcessRunOptions;
  emit(e: NormalizedEvent): void;
  finish(r?: ProcessRunResult): void;
  cancel: ReturnType<typeof vi.fn>;
}

function setup(over: Partial<ControllerDeps> = {}, settings: Partial<VisorSettings> = {}) {
  const posted: HostMessage[] = [];
  const runs: FakeRun[] = [];
  let seq = 0;
  const prefState = { dismissed: false };
  const startRun = vi.fn((runId: string, opts: ProcessRunOptions, on: (e: NormalizedEvent) => void) => {
    const cancel = vi.fn();
    let finish: (r: ProcessRunResult) => void = () => {};
    const done = new Promise<ProcessRunResult>((res) => (finish = res));
    runs.push({ runId, opts, emit: on, finish: (r) => finish(r ?? result()), cancel });
    return { cancel, done };
  });
  const deps: ControllerDeps = {
    post: (m) => posted.push(m),
    cwd: () => '/proj',
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    detect: async () => OK,
    startRun: startRun as any,
    listAgents: async () => [{ name: 'reader', description: 'Lê arquivos' }],
    listClis: async () => [{ id: 'claude', label: 'Claude Code', version: '2.1.287', supported: true }],
    capabilities: async () => ({ commands: [{ name: 'ping', kind: 'command', group: 'comando' }], defaultModel: 'claude-x' }),
    pickFiles: async () => [],
    checkAttachments: async (paths) => paths.map((p) => ({ path: p, name: p.split('/').filter(Boolean).pop() ?? p, isDir: p.endsWith('/dir') })),
    homedir: () => '/home/u',
    prefs: { authBannerDismissed: () => prefState.dismissed, dismissAuthBanner: () => { prefState.dismissed = true; } },
    flushMs: 5,
    newRunId: () => `r${++seq}`,
    ...over,
  };
  const c = new RunController(deps);
  let picked: string[] = [];
  const setPicked = (paths: string[]) => { picked = paths; };
  if (!over.pickFiles) deps.pickFiles = async () => picked;
  const allowPath = (p: string) => (c as any).pickedPaths.add(p);
  const snaps = () => posted.filter((m) => m.type === 'snapshot') as Extract<HostMessage, { type: 'snapshot' }>[];
  const notices = () => posted.filter((m) => m.type === 'notice') as Extract<HostMessage, { type: 'notice' }>[];
  const logs = () => posted.filter((m) => m.type === 'node_log') as Extract<HostMessage, { type: 'node_log' }>[];
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  const view = (id: string): RunView => snaps().at(-1)!.runs.find((r) => r.id === id)!;
  return { c, posted, runs, snaps, notices, logs, startRun, tick, view, prefState, setPicked, allowPath };
}
type T = ReturnType<typeof setup>;

const init = (runId: string, sessionId = `sess-${runId}`): NormalizedEvent => ({ type: 'run_started', runId, sessionId, ts: 1 });
const sub = (runId: string, id: string): NormalizedEvent => ({ type: 'node_started', runId, nodeId: `${runId}:${id}`, parentId: `${runId}:root`, agentType: 'echo', invocationId: id, ts: 2 });
const msg = (runId: string, text: string, node = 'root'): NormalizedEvent => ({ type: 'node_event', runId, nodeId: `${runId}:${node}`, kind: 'message', payload: { role: 'assistant', text }, ts: 5 });
const finishedWithQuestion = (runId: string, q: Question): NormalizedEvent => ({ type: 'run_finished', runId, status: 'done', question: q, ts: 3 });
const Q: Question = { text: 'Qual cor?', options: ['Azul'], source: 'marker' };

/** Inicia um chat e devolve `done` (a promessa do turno) sem esperar o término. */
async function startChat(t: T, prompt = 'x', title?: string) {
  const done = t.c.handle({ type: 'start', prompt, ...(title ? { title } : {}) });
  await t.tick();
  return { done };
}
/** chat que terminou com uma pergunta (waiting) e cujo processo já encerrou */
async function waitingChat(t: T, extra: (id: string) => NormalizedEvent[] = () => []) {
  const p = (await startChat(t)).done;
  const run = t.runs.at(-1)!;
  run.emit(init(run.runId));
  for (const e of extra(run.runId)) run.emit(e);
  run.emit(finishedWithQuestion(run.runId, Q));
  run.finish();
  await p;
  return run.runId;
}

describe('RunController: iniciar chats', () => {
  it('sem pasta aberta avisa e não spawna', async () => {
    const t = setup({ cwd: () => undefined });
    await t.c.handle({ type: 'start', prompt: 'x' });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.notices()[0]).toMatchObject({ level: 'error' });
    expect(t.notices()[0]!.text).toMatch(/pasta/);
  });

  it.each([
    ['not_installed', { state: 'not_installed', message: 'falta' }],
    ['not_authenticated', { state: 'not_authenticated', version: '1', message: 'login' }],
  ] as const)('CLI %s envia o diagnóstico, não spawna e não cria chat', async (_n, check) => {
    const t = setup({ detect: async () => check as CliCheck });
    await t.c.handle({ type: 'start', prompt: 'x' });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.posted.find((m) => m.type === 'cli')).toMatchObject({ check });
    expect(t.snaps().at(-1)?.runs ?? []).toEqual([]);
  });

  it('CLI "unknown" avisa mas executa', async () => {
    const t = setup({ detect: async () => ({ state: 'unknown', version: '1', message: 'sem auth status' }) });
    const p = (await startChat(t)).done;
    await t.tick();
    expect(t.startRun).toHaveBeenCalledTimes(1);
    expect(t.posted.find((m) => m.type === 'cli')).toBeTruthy();
    t.runs[0]!.finish();
    await p;
  });

  it('o chat aparece na hora, com título e orquestrador em execução, antes de qualquer evento do CLI', async () => {
    const t = setup();
    const p = (await startChat(t, 'Refatorar a API de pagamentos\ncom calma', 'Pagamentos')).done;
    await t.tick();
    expect(t.view('r1')).toMatchObject({ id: 'r1', title: 'Pagamentos', status: 'running' });
    expect(t.view('r1').nodes[0]).toMatchObject({ id: 'r1:root', status: 'running' });
    t.runs[0]!.finish();
    await p;
  });

  it('sem título informado usa o começo do prompt (uma linha, curto); prompt vazio de significado cai em "Chat N"', async () => {
    const t = setup();
    const p = (await startChat(t, 'Refatorar a API de pagamentos de forma muito detalhada e cuidadosa\nsegunda linha')).done;
    await t.tick();
    const title = t.view('r1').title;
    expect(title.startsWith('Refatorar a API de pagamentos')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title).not.toContain('\n');
    const q = (await startChat(t, '   \n')).done;
    await t.tick();
    expect(t.view('r2').title).toBe('Chat 1');
    t.runs.forEach((r) => r.finish());
    await Promise.all([p, q]);
  });

  it('passa cwd, comando, permissões, instrução do marcador e o prompt por último', async () => {
    const t = setup({}, { claudePath: '/bin/claude', permissionMode: 'plan', allowedTools: ['Read'] });
    const p = (await startChat(t, 'olá')).done;
    const { opts } = t.runs[0]!;
    expect(opts.command).toBe('/bin/claude');
    expect(opts.cwd).toBe('/proj');
    expect(opts.args).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--allowedTools', 'Read']));
    const i = opts.args.indexOf('--append-system-prompt');
    expect(opts.args[i + 1]).toContain('visor-question');
    expect(opts.args.slice(-2)).toEqual(['--', 'olá']);
    expect(opts.args).not.toContain('--resume');
    t.runs[0]!.finish();
    await p;
  });

  it('fluxo feliz: snapshots mostram o grafo e o final fecha em done sem avisos', async () => {
    const t = setup();
    const p = (await startChat(t)).done;
    const r = t.runs[0]!;
    r.emit(init('r1')); r.emit(sub('r1', 't1'));
    await t.tick();
    expect(t.view('r1').nodes.map((n) => n.id)).toEqual(['r1:root', 'r1:t1']);
    r.emit({ type: 'node_finished', runId: 'r1', nodeId: 'r1:t1', status: 'done', ts: 3 });
    r.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 4 });
    r.finish();
    await p;
    expect(t.view('r1').status).toBe('done');
    expect(t.view('r1').title).toBeTruthy();
    expect(t.view('r1').nodes.find((n) => n.id === 'r1:root')).toMatchObject({ status: 'done' });
    expect(t.notices()).toEqual([]);
  });

  it('o sessionId do CLI chega ao run mesmo com o chat criado antes', async () => {
    const t = setup();
    const p = (await startChat(t)).done;
    t.runs[0]!.emit(init('r1', 'sess-xyz'));
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 3 });
    t.runs[0]!.finish();
    await p;
    const q = t.c.handle({ type: 'send', nodeId: 'r1:root', text: 'segue' });
    await t.tick();
    expect(t.runs[1]!.opts.args).toEqual(expect.arrayContaining(['--resume', 'sess-xyz']));
    t.runs[1]!.finish();
    await q;
  });

  it('rajada de 2000 eventos gera poucos snapshots (throttle)', async () => {
    const t = setup();
    const p = (await startChat(t)).done;
    t.runs[0]!.emit(init('r1'));
    await t.tick();
    const before = t.snaps().length;
    for (let i = 0; i < 2000; i++) t.runs[0]!.emit(msg('r1', String(i)));
    await t.tick(30);
    expect(t.snaps().length - before).toBeLessThanOrEqual(2);
    t.runs[0]!.finish();
    await p;
  });

  it('exceção em detect não trava o controller', async () => {
    let first = true;
    const t = setup({ detect: async () => { if (first) { first = false; throw new Error('boom'); } return OK; } });
    await t.c.handle({ type: 'start', prompt: 'x' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    const p = (await startChat(t, 'y')).done;
    expect(t.startRun).toHaveBeenCalledTimes(1);
    t.runs[0]!.finish();
    await p;
  });

  it('spawn que lança de forma síncrona fecha o chat em error e libera novos chats', async () => {
    const t = setup();
    t.startRun.mockImplementationOnce(() => { throw new Error('spawn explodiu'); });
    await t.c.handle({ type: 'start', prompt: 'x' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.view('r1').status).toBe('error');
    const p = (await startChat(t, 'y')).done;
    expect(t.startRun).toHaveBeenCalledTimes(2);
    t.runs[0]!.finish();
    await p;
  });

  it('falha ao spawnar e término com erro viram avisos com a causa', async () => {
    const t = setup();
    const p = (await startChat(t)).done;
    t.runs[0]!.emit(init('r1'));
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'error', ts: 2 });
    t.runs[0]!.finish(result({ exitCode: null, spawnError: 'spawn claude ENOENT' }));
    await p;
    expect(t.notices().at(-1)!.text).toMatch(/ENOENT/);

    const q = (await startChat(t, 'y')).done;
    t.runs[1]!.emit(init('r2'));
    t.runs[1]!.emit({ type: 'run_finished', runId: 'r2', status: 'error', ts: 2 });
    t.runs[1]!.finish(result({ exitCode: 1, stderrTail: 'Permission denied for Bash' }));
    await q;
    expect(t.notices().at(-1)!.text).toMatch(/Permission denied for Bash/);
  });

  it('bypassPermissions inicia direto, sem diálogo de confirmação', async () => {
    const yes = setup({}, { permissionMode: 'bypassPermissions' });
    const p = (await startChat(yes)).done;
    expect(yes.startRun).toHaveBeenCalledTimes(1);
    expect(yes.runs[0]!.opts.args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    yes.runs[0]!.finish();
    await p;
  });
});

describe('RunController: várias conversas em paralelo', () => {
  it('dois chats rodam ao mesmo tempo, isolados: eventos de um não tocam o outro', async () => {
    const t = setup();
    const a = (await startChat(t, 'tarefa A')).done;
    const b = (await startChat(t, 'tarefa B')).done;
    expect(t.startRun).toHaveBeenCalledTimes(2);
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(sub('r1', 'x'));
    t.runs[1]!.emit(init('r2'));
    await t.tick();
    expect(t.view('r1').nodes).toHaveLength(2);
    expect(t.view('r2').nodes).toHaveLength(1);
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 9 });
    t.runs[0]!.finish();
    await a;
    expect(t.view('r1').status).toBe('done');
    expect(t.view('r2').status).toBe('running');
    t.runs[1]!.finish();
    await b;
  });

  it('o snapshot leva todos os chats na ordem de criação', async () => {
    const t = setup();
    const a = (await startChat(t, 'A')).done; const b = (await startChat(t, 'B')).done;
    await t.tick();
    expect(t.snaps().at(-1)!.runs.map((r) => r.id)).toEqual(['r1', 'r2']);
    t.runs.forEach((r) => r.finish());
    await Promise.all([a, b]);
  });

  it('avisa a partir do limite (padrão 4 executando ao mesmo tempo), sem bloquear', async () => {
    const t = setup();
    const ps = [];
    for (let i = 0; i < 3; i++) { ps.push((await startChat(t, `c${i}`)).done); }
    expect(t.notices().filter((n) => n.level === 'warn')).toHaveLength(0);
    ps.push((await startChat(t, 'c3')).done);
    const warns = t.notices().filter((n) => n.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.text).toMatch(/4 conversas/);
    expect(t.startRun).toHaveBeenCalledTimes(4); // só avisa
    t.runs.forEach((r) => r.finish());
    await Promise.all(ps);
  });

  it('limite configurável e 0 desliga o aviso; chats concluídos não contam', async () => {
    const t = setup({}, { parallelWarningThreshold: 2 });
    const a = (await startChat(t, 'a')).done;
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 2 });
    t.runs[0]!.finish();
    await a;
    const b = (await startChat(t, 'b')).done;
    await t.tick();
    expect(t.notices().filter((n) => n.level === 'warn')).toHaveLength(0);
    const c = (await startChat(t, 'c')).done;
    await t.tick();
    expect(t.notices().filter((n) => n.level === 'warn')).toHaveLength(1);
    t.runs.forEach((r) => r.finish());
    await Promise.all([b, c]);

    const off = setup({}, { parallelWarningThreshold: 0 });
    const ps = [];
    for (const n of ['a', 'b', 'c', 'd', 'e']) ps.push((await startChat(off, n)).done);
    expect(off.notices().filter((n) => n.level === 'warn')).toHaveLength(0);
    off.runs.forEach((r) => r.finish());
    await Promise.all(ps);
  });

  it('avisos de erro/cancelamento citam o título quando há mais de um chat', async () => {
    const t = setup();
    const a = (await startChat(t, 'a', 'Alfa')).done; const b = (await startChat(t, 'b', 'Beta')).done;
    await t.tick();
    t.runs[1]!.emit(init('r2'));
    t.runs[1]!.emit({ type: 'run_finished', runId: 'r2', status: 'error', ts: 2 });
    t.runs[1]!.finish(result({ exitCode: 1, stderrTail: 'ruim' }));
    await b;
    expect(t.notices().at(-1)!.text).toContain('Beta');
    t.runs[0]!.finish();
    await a;
  });
});

describe('RunController: cancelar', () => {
  it('cancel por runId cancela só aquele chat', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done; const b = (await startChat(t, 'b')).done;
    await t.tick();
    await t.c.handle({ type: 'cancel', runId: 'r2' });
    expect(t.runs[1]!.cancel).toHaveBeenCalledTimes(1);
    expect(t.runs[0]!.cancel).not.toHaveBeenCalled();
    t.runs[1]!.emit({ type: 'run_finished', runId: 'r2', status: 'cancelled', ts: 6 });
    t.runs[1]!.finish(result({ cancelled: true }));
    await b;
    expect(t.view('r2').status).toBe('cancelled');
    expect(t.view('r1').status).toBe('running');
    expect(t.notices().at(-1)).toMatchObject({ level: 'info' });
    t.runs[0]!.finish();
    await a;
  });

  it('cancel de chat desconhecido ou já parado é inofensivo', async () => {
    const t = setup();
    await expect(t.c.handle({ type: 'cancel', runId: 'zzz' })).resolves.toBeUndefined();
    const a = (await startChat(t)).done;
    t.runs[0]!.finish();
    await a;
    await expect(t.c.handle({ type: 'cancel', runId: 'r1' })).resolves.toBeUndefined();
    expect(t.runs[0]!.cancel).not.toHaveBeenCalled();
  });

  it('cancelAll cancela todos os chats ativos', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done; const b = (await startChat(t, 'b')).done;
    await t.tick();
    t.c.cancelAll();
    expect(t.runs[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(t.runs[1]!.cancel).toHaveBeenCalledTimes(1);
    t.runs.forEach((r) => r.finish(result({ cancelled: true })));
    await Promise.all([a, b]);
  });

  it('cancelAll durante a detecção do CLI impede o spawn e o próximo start funciona', async () => {
    const t = setup({ detect: () => new Promise((r) => setTimeout(() => r(OK), 30)) });
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick(5);
    t.c.cancelAll();
    await p;
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.notices().at(-1)).toMatchObject({ level: 'info' });
    const q = t.c.handle({ type: 'start', prompt: 'y' });
    await t.tick(60);
    expect(t.startRun).toHaveBeenCalledTimes(1);
    t.runs[0]!.finish();
    await q;
  });

  it('dispose cancela os chats ativos e para o timer', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done; const b = (await startChat(t, 'b')).done;
    await t.tick();
    t.runs[0]!.emit(init('r1'));
    t.c.dispose();
    expect(t.runs[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(t.runs[1]!.cancel).toHaveBeenCalledTimes(1);
    t.runs.forEach((r) => r.finish(result({ cancelled: true })));
    await Promise.all([a, b]);
  });
});

describe('RunController: preferências, ready e inspeção', () => {
  it('ready envia prefs, diagnóstico do CLI e todos os chats; sem chats envia lista vazia', async () => {
    const t = setup();
    await t.c.handle({ type: 'ready' });
    expect(t.posted).toEqual([{ type: 'prefs', authBannerDismissed: false }, { type: 'snapshot', runs: [] }]);
    const a = (await startChat(t, 'a')).done; const b = (await startChat(t, 'b')).done;
    await t.tick();
    t.posted.length = 0;
    await t.c.handle({ type: 'ready' });
    expect(t.posted.map((m) => m.type)).toEqual(['prefs', 'cli', 'snapshot', 'chat_log', 'chat_log']);
    expect((t.posted[2] as any).runs).toHaveLength(2);
    t.runs.forEach((r) => r.finish());
    await Promise.all([a, b]);
  });

  it('dismissAuth grava a preferência e o ready seguinte já traz o valor', async () => {
    const t = setup();
    await t.c.handle({ type: 'dismissAuth' });
    expect(t.prefState.dismissed).toBe(true);
    expect(t.posted).toContainEqual({ type: 'prefs', authBannerDismissed: true });
  });

  it('inspect acha o node no chat dono e atualiza a cada flush; null para de enviar', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done; const b = (await startChat(t, 'b')).done;
    await t.tick();
    t.runs[0]!.emit(init('r1')); t.runs[1]!.emit(init('r2'));
    t.runs[1]!.emit(msg('r2', 'do chat B'));
    await t.c.handle({ type: 'inspect', nodeId: 'r2:root' });
    expect(t.logs().at(-1)).toMatchObject({ nodeId: 'r2:root', total: 2 }); // prompt inicial + mensagem
    expect((t.logs().at(-1)!.events.at(-1)!.payload as any).text).toBe('do chat B');
    t.runs[1]!.emit(msg('r2', 'mais'));
    await t.tick();
    expect(t.logs().at(-1)!.events).toHaveLength(3);
    const n = t.logs().length;
    await t.c.handle({ type: 'inspect', nodeId: null });
    t.runs[1]!.emit(msg('r2', 'ainda mais'));
    await t.tick();
    expect(t.logs()).toHaveLength(n);
    t.runs.forEach((r) => r.finish());
    await Promise.all([a, b]);
  });

  it('inspect de node inexistente devolve log vazio sem lançar', async () => {
    const t = setup();
    await t.c.handle({ type: 'inspect', nodeId: 'fantasma' });
    expect(t.logs().at(-1)).toMatchObject({ nodeId: 'fantasma', events: [], total: 0 });
  });
});

describe('RunController: responder, enviar, novo agente, concluir', () => {
  it('primeiro turno: pergunta deixa o chat em waiting; responder retoma a sessão com loading imediato e registra a resposta', async () => {
    const t = setup();
    const id = await waitingChat(t);
    expect(t.view(id).status).toBe('waiting');
    const p = t.c.handle({ type: 'send', nodeId: `${id}:root`, text: 'Azul' });
    await t.tick();
    const { opts } = t.runs.at(-1)!;
    expect(opts.args).toEqual(expect.arrayContaining(['--resume', `sess-${id}`, '--append-system-prompt']));
    expect(opts.args.slice(-2)).toEqual(['--', 'Azul']);
    expect(opts.resume).toEqual({ subagents: [], tasks: {} });
    expect(t.view(id).status).toBe('running');
    expect(t.view(id).nodes[0]).toMatchObject({ status: 'running' });
    expect(t.view(id).nodes[0]!.question).toBeUndefined();
    await t.c.handle({ type: 'inspect', nodeId: `${id}:root` });
    expect(t.logs().at(-1)!.events.at(-1)!.payload).toEqual({ role: 'user', text: 'Azul' });
    t.runs.at(-1)!.finish();
    await p;
  });

  it('o seed da retomada inclui subagentes e ids de agente já conhecidos; o CLI não é detectado de novo', async () => {
    const detect = vi.fn(async () => OK);
    const t = setup({ detect });
    const id = await waitingChat(t, (r) => [sub(r, 'a'), { type: 'node_meta', runId: r, nodeId: `${r}:a`, agentId: 'agent-xyz', ts: 2 }]);
    const p = t.c.handle({ type: 'send', nodeId: `${id}:root`, text: 'segue' });
    await t.tick();
    expect(t.runs.at(-1)!.opts.resume).toEqual({ subagents: ['a'], tasks: { 'agent-xyz': 'a' } });
    expect(detect).toHaveBeenCalledTimes(1);
    t.runs.at(-1)!.finish();
    await p;
  });

  it('send num subagente pede ao orquestrador SendMessage com o agentId e registra o texto no node dele', async () => {
    const t = setup();
    const id = await waitingChat(t, (r) => [sub(r, 'a'), { type: 'node_meta', runId: r, nodeId: `${r}:a`, agentId: 'agent-xyz', ts: 2 }]);
    const p = t.c.handle({ type: 'send', nodeId: `${id}:a`, text: 'agora em francês' });
    await t.tick();
    const prompt = t.runs.at(-1)!.opts.args.at(-1)!;
    for (const part of ['SendMessage', 'agent-xyz', 'echo', 'agora em francês']) expect(prompt).toContain(part);
    await t.c.handle({ type: 'inspect', nodeId: `${id}:a` });
    expect(t.logs().at(-1)!.events.at(-1)!.payload).toEqual({ role: 'user', text: 'agora em francês' });
    t.runs.at(-1)!.finish();
    await p;
  });

  it('send sem agentId conhecido cita o tipo do subagente e não promete SendMessage', async () => {
    const t = setup();
    const id = await waitingChat(t, (r) => [sub(r, 'a')]);
    const p = t.c.handle({ type: 'send', nodeId: `${id}:a`, text: 'oi' });
    await t.tick();
    const prompt = t.runs.at(-1)!.opts.args.at(-1)!;
    expect(prompt).toContain('echo');
    expect(prompt).toContain('oi');
    expect(prompt).not.toContain('SendMessage');
    t.runs.at(-1)!.finish();
    await p;
  });

  it('send em node de outro chat vai para o chat certo, sem afetar os demais', async () => {
    const t = setup();
    const a = await waitingChat(t);
    const idB = await waitingChat(t);
    const p = t.c.handle({ type: 'send', nodeId: `${idB}:root`, text: 'resposta B' });
    await t.tick();
    expect(t.runs.at(-1)!.opts.args).toEqual(expect.arrayContaining(['--resume', `sess-${idB}`]));
    expect(t.view(idB).status).toBe('running');
    expect(t.view(a).status).toBe('waiting');
    t.runs.at(-1)!.finish();
    await p;
  });

  it('send em node desconhecido, em chat sem sessão ou enquanto o chat executa não spawna', async () => {
    const t = setup();
    await t.c.handle({ type: 'send', nodeId: 'r9:root', text: 'x' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });

    const a = (await startChat(t, 'sem sessão ainda')).done; // nenhum init => sem sessionId
    await t.tick();
    await t.c.handle({ type: 'send', nodeId: 'r1:root', text: 'x' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'warn' }); // chat ainda executando
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 2 });
    t.runs[0]!.finish();
    await a;
    await t.c.handle({ type: 'send', nodeId: 'r1:root', text: 'x' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.startRun).toHaveBeenCalledTimes(1);
  });

  it('spawn com runId retoma aquele chat pedindo a delegação ao tipo escolhido', async () => {
    const t = setup();
    const id = await waitingChat(t);
    const p = t.c.handle({ type: 'spawn', agentType: 'reader', task: 'leia notes.txt', runId: id });
    await t.tick();
    const args = t.runs.at(-1)!.opts.args;
    expect(args).toEqual(expect.arrayContaining(['--resume', `sess-${id}`]));
    expect(args.at(-1)).toContain('subagent_type "reader"');
    expect(args.at(-1)).toContain('leia notes.txt');
    t.runs.at(-1)!.finish();
    await p;
  });

  it('spawn sem runId cria um chat novo com o pedido e título com o tipo do agente', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'spawn', agentType: 'reader', task: 'leia notes.txt', runId: null });
    await t.tick();
    const { opts } = t.runs[0]!;
    expect(opts.args).not.toContain('--resume');
    expect(opts.args.at(-1)).toContain('subagent_type "reader"');
    expect(t.view('r1').title).toContain('reader');
    t.runs[0]!.finish();
    await p;
  });

  it('spawn para chat inexistente ou sem sessão avisa e não spawna', async () => {
    const t = setup();
    await t.c.handle({ type: 'spawn', agentType: 'reader', task: 't', runId: 'zzz' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.startRun).not.toHaveBeenCalled();
  });

  it('markDone fecha o chat em waiting como concluído; ignora chat desconhecido, fora de waiting e com processo vivo', async () => {
    const t = setup();
    await t.c.handle({ type: 'markDone', runId: 'zzz' });
    const id = await waitingChat(t);
    await t.c.handle({ type: 'markDone', runId: id });
    expect(t.view(id).status).toBe('done');
    expect(t.view(id).nodes[0]!.question).toBeUndefined();
    const before = t.snaps().length;
    await t.c.handle({ type: 'markDone', runId: id });
    expect(t.snaps().length).toBe(before);

    // pergunta recebida, mas o processo ainda vive (tarefa em segundo plano)
    const p = (await startChat(t, 'y')).done;
    const run = t.runs.at(-1)!;
    run.emit(init(run.runId));
    run.emit(finishedWithQuestion(run.runId, Q));
    await t.tick();
    expect(t.view(run.runId).status).toBe('waiting');
    await t.c.handle({ type: 'markDone', runId: run.runId });
    expect(t.view(run.runId).status).toBe('waiting');
    run.finish();
    await p;
  });

  it('listAgents envia os agentes do projeto + nativos; falha na leitura devolve só os nativos', async () => {
    const t = setup();
    await t.c.handle({ type: 'listAgents' });
    const names = (t.posted.find((m) => m.type === 'agents') as any).agents.map((a: any) => a.name);
    expect(names[0]).toBe('reader');
    expect(names).toEqual(expect.arrayContaining(['general-purpose', 'Explore', 'Plan']));
    const bad = setup({ listAgents: async () => { throw new Error('EACCES'); } });
    await bad.c.handle({ type: 'listAgents' });
    const n2 = (bad.posted.find((m) => m.type === 'agents') as any).agents.map((a: any) => a.name);
    expect(n2).not.toContain('reader');
    expect(n2).toContain('general-purpose');
  });

});

describe('RunController: revisão dos chats', () => {
  it('busy do chat vai no snapshot durante um turno retomado e volta a false no fim', async () => {
    const t = setup();
    const id = await waitingChat(t);
    expect(t.view(id).busy).toBe(false);
    const p = t.c.handle({ type: 'send', nodeId: `${id}:root`, text: 'segue' });
    await t.tick();
    expect(t.view(id).busy).toBe(true);
    t.runs.at(-1)!.finish();
    await p;
    expect(t.view(id).busy).toBe(false);
  });

  it('starting informa quantos inícios estão em andamento (detecção do CLI) e zera no fim', async () => {
    const t = setup({ detect: () => new Promise((r) => setTimeout(() => r(OK), 30)) });
    const p = t.c.handle({ type: 'start', prompt: 'x' });
    await t.tick(5);
    const starting = () => t.posted.filter((m) => m.type === 'starting') as Extract<HostMessage, { type: 'starting' }>[];
    expect(starting().at(-1)!.count).toBe(1);
    await t.tick(60);
    t.runs[0]!.finish();
    await p;
    expect(starting().at(-1)!.count).toBe(0);
  });

  it('cancelPending cancela só os inícios pendentes (não toca em chats em execução)', async () => {
    let slow = false;
    const t = setup({ detect: () => new Promise((r) => setTimeout(() => r(OK), slow ? 30 : 0)) });
    const a = (await startChat(t, 'a')).done;
    slow = true;
    const b = t.c.handle({ type: 'start', prompt: 'b' });
    await t.tick(5);
    await t.c.handle({ type: 'cancelPending' });
    await b;
    expect(t.startRun).toHaveBeenCalledTimes(1);
    expect(t.runs[0]!.cancel).not.toHaveBeenCalled();
    t.runs[0]!.finish();
    await a;
  });

  it('removeChat remove um chat parado, fecha a inspeção dele e não mexe nos outros', async () => {
    const t = setup();
    const a = await waitingChat(t);
    const b = await waitingChat(t);
    await t.c.handle({ type: 'inspect', nodeId: `${a}:root` });
    await t.c.handle({ type: 'removeChat', runId: a });
    expect(t.snaps().at(-1)!.runs.map((r) => r.id)).toEqual([b]);
    const n = t.logs().length;
    await t.c.handle({ type: 'markDone', runId: b });
    expect(t.logs()).toHaveLength(n); // a inspeção do chat removido foi encerrada
  });

  it('removeChat de chat em execução, ocupado ou inexistente é recusado/ignorado', async () => {
    const t = setup();
    const p = (await startChat(t, 'a')).done;
    await t.c.handle({ type: 'removeChat', runId: 'r1' });
    expect(t.view('r1')).toBeTruthy();
    expect(t.notices().at(-1)).toMatchObject({ level: 'warn' });
    await t.c.handle({ type: 'removeChat', runId: 'zzz' });
    t.runs[0]!.finish();
    await p;
  });

  it('o log do node inspecionado só é reenviado quando o chat dele mudou', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done;
    const b = (await startChat(t, 'b')).done;
    t.runs[0]!.emit(init('r1')); t.runs[1]!.emit(init('r2'));
    await t.c.handle({ type: 'inspect', nodeId: 'r1:root' });
    await t.tick(15);
    const n = t.logs().length;
    for (let i = 0; i < 5; i++) { t.runs[1]!.emit(msg('r2', `b${i}`)); await t.tick(12); } // só o outro chat muda
    expect(t.logs().length).toBe(n);
    t.runs[0]!.emit(msg('r1', 'do inspecionado'));
    await t.tick(15);
    expect(t.logs().length).toBe(n + 1);
    t.runs.forEach((r) => r.finish());
    await Promise.all([a, b]);
  });

  it('retomar um chat também avisa quando já há conversas demais executando', async () => {
    const t = setup({}, { parallelWarningThreshold: 2 });
    const w = await waitingChat(t); // 0 executando
    const x = (await startChat(t, 'x')).done; // 1 executando
    expect(t.notices().filter((n) => n.level === 'warn')).toHaveLength(0);
    const p = t.c.handle({ type: 'send', nodeId: `${w}:root`, text: 'segue' }); // 2 executando
    await t.tick();
    expect(t.notices().filter((n) => n.level === 'warn')).toHaveLength(1);
    t.runs.forEach((r) => r.finish());
    await Promise.all([x, p]);
  });

});

describe('RunController: cartão do chat ao vivo, nome e posições', () => {
  const chatLogs = (t: T) => t.posted.filter((m) => m.type === 'chat_log') as Extract<HostMessage, { type: 'chat_log' }>[];

  it('o prompt inicial é o primeiro evento da conversa do chat', async () => {
    const t = setup();
    const p = (await startChat(t, 'faça X por favor')).done;
    await t.tick(15);
    const first = chatLogs(t).at(-1)!;
    expect(first.runId).toBe('r1');
    expect(first.events[0]).toMatchObject({ kind: 'message', payload: { role: 'user', text: 'faça X por favor' } });
    t.runs[0]!.finish();
    await p;
  });

  it('chat_log só é enviado para chats que mudaram desde o último envio', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done;
    const b = (await startChat(t, 'b')).done;
    await t.tick(15);
    t.posted.length = 0;
    t.runs[1]!.emit(init('r2')); t.runs[1]!.emit(msg('r2', 'só no B'));
    await t.tick(15);
    expect(chatLogs(t).map((m) => m.runId)).toEqual(['r2']);
    expect((chatLogs(t)[0]!.events.at(-1)!.payload as any).text).toBe('só no B');
    t.runs.forEach((r) => r.finish());
    await Promise.all([a, b]);
  });

  it('o log do cartão traz só os últimos 100 eventos, com texto truncado, e o total real', async () => {
    const t = setup();
    const p = (await startChat(t, 'a')).done;
    t.runs[0]!.emit(init('r1'));
    for (let i = 0; i < 150; i++) t.runs[0]!.emit(msg('r1', i === 149 ? 'x'.repeat(9000) : `m${i}`));
    await t.tick(15);
    const log = chatLogs(t).at(-1)!;
    expect(log.events).toHaveLength(100);
    expect(log.total).toBe(151); // 150 + prompt inicial
    const text = (log.events.at(-1)!.payload as any).text as string;
    expect(text.length).toBeLessThan(4200);
    expect(text).toContain('(truncado)');
    t.runs[0]!.finish();
    await p;
  });

  it('ready reenvia posições salvas e o log de todos os chats', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done;
    await t.c.handle({ type: 'moveNode', nodeId: 'r1:root', x: 10, y: 20, width: 400, height: 300 });
    t.posted.length = 0;
    await t.c.handle({ type: 'ready' });
    expect(t.posted.map((m) => m.type)).toEqual(['prefs', 'cli', 'layout', 'snapshot', 'chat_log']);
    expect(t.posted.find((m) => m.type === 'layout')).toEqual({ type: 'layout', boxes: { 'r1:root': { x: 10, y: 20, width: 400, height: 300 } } });
    t.runs[0]!.finish();
    await a;
  });

  it('moveNode ignora node inexistente e removeChat apaga as posições do chat', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done;
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(sub('r1', 'x'));
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 9 });
    t.runs[0]!.finish();
    await a;
    await t.c.handle({ type: 'moveNode', nodeId: 'fantasma', x: 1, y: 1 });
    await t.c.handle({ type: 'moveNode', nodeId: 'r1:x', x: 5, y: 6 });
    await t.c.handle({ type: 'ready' });
    expect((t.posted.filter((m) => m.type === 'layout').at(-1) as any).boxes).toEqual({ 'r1:x': { x: 5, y: 6 } });
    await t.c.handle({ type: 'removeChat', runId: 'r1' });
    t.posted.length = 0;
    await t.c.handle({ type: 'ready' });
    expect(t.posted.some((m) => m.type === 'layout')).toBe(false);
  });

  it('rename troca o título do chat; chat desconhecido é ignorado', async () => {
    const t = setup();
    const a = (await startChat(t, 'tarefa longa')).done;
    await t.c.handle({ type: 'rename', runId: 'r1', title: 'Meu nome' });
    expect(t.view('r1').title).toBe('Meu nome');
    await t.c.handle({ type: 'rename', runId: 'zzz', title: 'x' });
    expect(t.view('r1').title).toBe('Meu nome');
    t.runs[0]!.finish();
    await a;
  });

  it('chat_log não é reenviado quando só um subagente mudou (o log da raiz é o mesmo)', async () => {
    const t = setup();
    const a = (await startChat(t, 'a')).done;
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit(sub('r1', 'x'));
    await t.tick(15);
    const n = chatLogs(t).length;
    t.runs[0]!.emit(msg('r1', 'só no subagente', 'x'));
    await t.tick(15);
    expect(chatLogs(t).length).toBe(n);
    t.runs[0]!.emit(msg('r1', 'agora na raiz'));
    await t.tick(15);
    expect(chatLogs(t).length).toBe(n + 1);
    t.runs[0]!.finish();
    await a;
  });

  it('novo agente sem chat: a conversa mostra a tarefa da pessoa, não o prompt interno em inglês', async () => {
    const t = setup();
    const p = t.c.handle({ type: 'spawn', agentType: 'reader', task: 'leia notes.txt', runId: null });
    await t.tick(15);
    const first = chatLogs(t).at(-1)!.events[0]!.payload as any;
    expect(first).toEqual({ role: 'user', text: 'Novo node (reader): leia notes.txt' });
    expect(t.runs[0]!.opts.args.at(-1)).toContain('subagent_type "reader"'); // o prompt real segue em inglês
    t.runs[0]!.finish();
    await p;
  });

});

describe('RunController: opções do chat, anexos, CLIs e capacidades', () => {
  const start = async (t: T, msg: Record<string, unknown>) => {
    const done = t.c.handle({ type: 'start', prompt: 'x', ...msg } as any);
    await t.tick();
    return { done };
  };

  it('options viram --model/--effort/--permission-mode do chat e aparecem na view', async () => {
    const t = setup();
    const p = (await start(t, { options: { model: 'opus', effort: 'high', permissionMode: 'plan' } })).done;
    const args = t.runs[0]!.opts.args;
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus', '--effort', 'high', '--permission-mode', 'plan']));
    expect(args.indexOf('--permission-mode') + 1).toBe(args.indexOf('plan'));
    expect(t.view('r1').options).toEqual({ model: 'opus', effort: 'high', permissionMode: 'plan' });
    t.runs[0]!.finish();
    await p;
  });

  it('sem options usa os padrões das settings e não manda --model/--effort', async () => {
    const t = setup({}, { permissionMode: 'acceptEdits' });
    const p = (await start(t, {})).done;
    const args = t.runs[0]!.opts.args;
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(t.view('r1').options).toBeUndefined();
    t.runs[0]!.finish();
    await p;
  });

  it('as opções do chat valem também nos turnos retomados (respostas)', async () => {
    const t = setup();
    const p = (await start(t, { options: { model: 'sonnet', effort: 'low' } })).done;
    t.runs[0]!.emit(init('r1')); t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 2 });
    t.runs[0]!.finish();
    await p;
    const q = t.c.handle({ type: 'send', nodeId: 'r1:root', text: 'segue' });
    await t.tick();
    expect(t.runs[1]!.opts.args).toEqual(expect.arrayContaining(['--resume', 'sess-r1', '--model', 'sonnet', '--effort', 'low']));
    t.runs[1]!.finish();
    await q;
  });

  /** regras depois de --allowedTools, até a próxima flag */
  const rulesOf = (args: string[]) => {
    const i = args.indexOf('--allowedTools');
    const rest = args.slice(i + 1);
    const end = rest.findIndex((a) => a.startsWith('--'));
    return end === -1 ? rest : rest.slice(0, end);
  };

  /** Escolhe arquivos no seletor (único jeito de um caminho ser aceito pelo host). */
  const pick = async (t: T, paths: string[]) => {
    const picker = t as any;
    picker.setPicked(paths);
    await t.c.handle({ type: 'pickFiles', requestId: 'req' });
  };

  it('anexos: o prompt ganha a lista, a conversa mostra só os nomes e o que está FORA do projeto vira regra de LEITURA (sem --add-dir)', async () => {
    const t = setup();
    await pick(t, ['/proj/src/a.ts', '/outro/lugar/b.png', '/proj/dir']);
    const p = (await start(t, { prompt: 'analise', attachments: ['/proj/src/a.ts', '/outro/lugar/b.png', '/proj/dir'] })).done;
    const args = t.runs[0]!.opts.args;
    const prompt = args.at(-1)!;
    expect(prompt.startsWith('analise')).toBe(true);
    for (const f of ['/proj/src/a.ts', '/outro/lugar/b.png', '/proj/dir']) expect(prompt).toContain(`- ${f}`);
    expect(args).not.toContain('--add-dir'); // nunca libera a pasta inteira (nem para edição)
    expect(rulesOf(args)).toEqual(['Read(//outro/lugar/b.png)']); // só o arquivo de fora; os de dentro do projeto já são legíveis
    const warn = t.notices().find((n) => n.level === 'warn');
    expect(warn?.text).toContain('b.png');
    expect(warn?.text).toMatch(/somente leitura/i);
    await t.tick(15);
    const first = t.posted.filter((m) => m.type === 'chat_log').at(-1) as any;
    expect(first.events[0].payload).toEqual({ role: 'user', text: 'analise', attachments: ['a.ts', 'b.png', 'dir'] });
    t.runs[0]!.finish();
    await p;
  });

  it('pasta anexada fora do projeto libera só o conteúdo dela (Read(//pasta/**)), e as regras do usuário continuam junto', async () => {
    const t = setup({}, { allowedTools: ['Bash(npm test:*)'] });
    await pick(t, ['/fora/dir']);
    const p = (await start(t, { prompt: 'veja', attachments: ['/fora/dir'] })).done;
    const args = t.runs[0]!.opts.args;
    expect(rulesOf(args)).toEqual(['Bash(npm test:*)', 'Read(//fora/dir/**)']);
    t.runs[0]!.finish();
    await p;
  });

  it('anexo sem texto: o prompt é só a lista de arquivos e o título vem do nome do arquivo', async () => {
    const t = setup();
    await pick(t, ['/proj/a.txt']);
    const p = (await start(t, { prompt: '   ', attachments: ['/proj/a.txt'] })).done;
    const prompt = t.runs[0]!.opts.args.at(-1)!;
    expect(prompt.startsWith('Files attached')).toBe(true);
    expect(prompt).toContain('- /proj/a.txt');
    expect(t.view('r1').title).toBe('a.txt');
    t.runs[0]!.finish();
    await p;
  });

  it('caminho que NÃO veio do seletor é recusado (uma Webview comprometida não escolhe arquivos sozinha)', async () => {
    const t = setup();
    await t.c.handle({ type: 'start', prompt: 'x', attachments: ['/'] });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.notices().at(-1)!.text).toMatch(/seletor|anexo/i);
    expect(t.snaps().at(-1)?.runs ?? []).toEqual([]);
    await t.c.handle({ type: 'send', nodeId: 'r1:root', text: 'x', attachments: ['/etc/passwd'] });
    expect(t.startRun).not.toHaveBeenCalled();
  });

  it('o seletor filtra caminhos sensíveis (~/.ssh, ~/.claude, a pasta pessoal) e avisa; eles não podem ser anexados nem por mensagem direta', async () => {
    const t = setup();
    await pick(t, ['/home/u/.ssh/id_rsa', '/home/u', '/home/u/.claude/.credentials.json', '/home/u/proj/ok.txt']);
    const files = (t.posted.find((m) => m.type === 'files') as any).files;
    expect(files.map((f: any) => f.path)).toEqual(['/home/u/proj/ok.txt']);
    expect(t.notices().some((n) => n.level === 'warn' && /bloquead/i.test(n.text))).toBe(true);
    await t.c.handle({ type: 'start', prompt: 'x', attachments: ['/home/u/.ssh/id_rsa'] });
    expect(t.startRun).not.toHaveBeenCalled();
  });

  it('anexo que sumiu depois de escolhido: erro claro e nenhum chat é criado', async () => {
    const t = setup({ checkAttachments: async () => [] });
    t.setPicked(['/proj/sumiu.txt']);
    (t as any).allowPath('/proj/sumiu.txt');
    await t.c.handle({ type: 'start', prompt: 'x', attachments: ['/proj/sumiu.txt'] });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.snaps().at(-1)?.runs ?? []).toEqual([]);
  });

  it('send com anexos (resposta/continuação): prompt com a lista, regra de leitura e eco com os nomes', async () => {
    const t = setup();
    const id = await waitingChat(t);
    await pick(t, ['/fora/doc.pdf']);
    const p = t.c.handle({ type: 'send', nodeId: `${id}:root`, text: 'olhe isto', attachments: ['/fora/doc.pdf'] });
    await t.tick();
    const args = t.runs.at(-1)!.opts.args;
    expect(args.at(-1)).toContain('olhe isto');
    expect(args.at(-1)).toContain('- /fora/doc.pdf');
    expect(args).not.toContain('--add-dir');
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Read(//fora/doc.pdf)']));
    await t.c.handle({ type: 'inspect', nodeId: `${id}:root` });
    expect(t.logs().at(-1)!.events.at(-1)!.payload).toEqual({ role: 'user', text: 'olhe isto', attachments: ['doc.pdf'] });
    t.runs.at(-1)!.finish();
    await p;
  });

  it('send para subagente com anexos leva os arquivos dentro da mensagem repassada', async () => {
    const t = setup();
    const id = await waitingChat(t, (r) => [sub(r, 'a'), { type: 'node_meta', runId: r, nodeId: `${r}:a`, agentId: 'ag1', ts: 2 }]);
    await pick(t, ['/proj/n.txt']);
    const p = t.c.handle({ type: 'send', nodeId: `${id}:a`, text: 'leia', attachments: ['/proj/n.txt'] });
    await t.tick();
    const prompt = t.runs.at(-1)!.opts.args.at(-1)!;
    expect(prompt).toContain('SendMessage');
    expect(prompt).toContain('- /proj/n.txt');
    t.runs.at(-1)!.finish();
    await p;
  });

  it('pickFiles devolve os arquivos escolhidos (com nome e se é pasta) para o requestId; cancelar devolve lista vazia', async () => {
    const t = setup({ pickFiles: async () => ['/proj/a.txt', '/proj/dir'] });
    await t.c.handle({ type: 'pickFiles', requestId: 'req1' });
    expect(t.posted.find((m) => m.type === 'files')).toEqual({
      type: 'files', requestId: 'req1',
      files: [{ path: '/proj/a.txt', name: 'a.txt', isDir: false }, { path: '/proj/dir', name: 'dir', isDir: true }],
    });
    const none = setup({ pickFiles: async () => [] });
    await none.c.handle({ type: 'pickFiles', requestId: 'r2' });
    expect(none.posted.find((m) => m.type === 'files')).toEqual({ type: 'files', requestId: 'r2', files: [] });
    const boom = setup({ pickFiles: async () => { throw new Error('x'); } });
    await boom.c.handle({ type: 'pickFiles', requestId: 'r3' });
    expect(boom.posted.find((m) => m.type === 'files')).toEqual({ type: 'files', requestId: 'r3', files: [] });
  });

  it('listClis envia as CLIs instaladas; falha devolve lista vazia', async () => {
    const t = setup();
    await t.c.handle({ type: 'listClis' });
    expect(t.posted.find((m) => m.type === 'clis')).toEqual({ type: 'clis', clis: [{ id: 'claude', label: 'Claude Code', version: '2.1.287', supported: true }] });
    const bad = setup({ listClis: async () => { throw new Error('x'); } });
    await bad.c.handle({ type: 'listClis' });
    expect(bad.posted.find((m) => m.type === 'clis')).toEqual({ type: 'clis', clis: [] });
  });

  it('listCapabilities envia comandos e modelo padrão; usa cache de 60 s por projeto e atualiza depois', async () => {
    let now = 0;
    const capabilities = vi.fn(async () => ({ commands: [{ name: 'ping', kind: 'command' as const, group: 'comando' }], defaultModel: 'claude-x' }));
    const t = setup({ capabilities, nowMs: () => now });
    await t.c.handle({ type: 'listCapabilities' });
    expect(t.posted.find((m) => m.type === 'capabilities')).toEqual({ type: 'capabilities', commands: [{ name: 'ping', kind: 'command', group: 'comando' }], defaultModel: 'claude-x' });
    now = 30_000;
    await t.c.handle({ type: 'listCapabilities' });
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(t.posted.filter((m) => m.type === 'capabilities')).toHaveLength(2); // sempre responde
    now = 61_000;
    await t.c.handle({ type: 'listCapabilities' });
    expect(capabilities).toHaveBeenCalledTimes(2);
  });

  it('pedidos simultâneos de listCapabilities dividem UM só processo; resultado vazio não fica em cache', async () => {
    let calls = 0;
    const capabilities = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return calls === 1 ? { commands: [], defaultModel: undefined } : { commands: [{ name: 'ping', kind: 'command' as const, group: 'comando' }], defaultModel: 'm' };
    });
    const t = setup({ capabilities });
    await Promise.all([t.c.handle({ type: 'listCapabilities' }), t.c.handle({ type: 'listCapabilities' }), t.c.handle({ type: 'listCapabilities' })]);
    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(t.posted.filter((m) => m.type === 'capabilities')).toHaveLength(3);
    await t.c.handle({ type: 'listCapabilities' }); // o vazio anterior não foi guardado: tenta de novo
    expect(capabilities).toHaveBeenCalledTimes(2);
    expect((t.posted.filter((m) => m.type === 'capabilities').at(-1) as any).commands).toHaveLength(1);
  });

  it('listCapabilities sem pasta aberta ou com falha devolve lista vazia sem lançar', async () => {
    const t = setup({ cwd: () => undefined });
    await t.c.handle({ type: 'listCapabilities' });
    expect(t.posted.find((m) => m.type === 'capabilities')).toEqual({ type: 'capabilities', commands: [] });
    const bad = setup({ capabilities: async () => { throw new Error('x'); } });
    await bad.c.handle({ type: 'listCapabilities' });
    expect(bad.posted.find((m) => m.type === 'capabilities')).toEqual({ type: 'capabilities', commands: [] });
  });

});

describe('RunController: Codex e opções editáveis', () => {
  const startC = async (t: T, msg: Record<string, unknown>) => {
    const done = t.c.handle({ type: 'start', prompt: 'x', ...msg } as any);
    await t.tick();
    return { done };
  };
  const argsOf = (t: T, i = 0) => t.runs[i]!.opts.args;
  const codexThread = (runId: string, id = 'thread-9'): NormalizedEvent => ({ type: 'run_started', runId, sessionId: id, ts: 1 });

  it('chat no Codex: detecta o Codex (não o Claude), usa codexPath, adapter codex, sandbox padrão e prefixo da instrução de pergunta', async () => {
    const detect = vi.fn(async () => OK);
    const t = setup({ detect }, { codexPath: '/opt/codex' });
    const p = (await startC(t, { prompt: 'faça X', options: { cli: 'codex' } })).done;
    expect(detect).toHaveBeenCalledWith('/opt/codex', 'codex');
    const { opts } = t.runs[0]!;
    expect(opts.command).toBe('/opt/codex');
    expect(opts.adapter).toBe('codex');
    expect(opts.args.slice(0, 5)).toEqual(['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write']);
    const prompt = opts.args.at(-1)!;
    expect(prompt).toContain('visor-question');
    expect(prompt.endsWith('faça X')).toBe(true);
    expect(opts.args.at(-2)).toBe('--');
    expect(opts.args).not.toContain('--permission-mode');
    expect(opts.args).not.toContain('--append-system-prompt');
    expect(t.view('r1').options).toEqual({ cli: 'codex' });
    t.runs[0]!.finish();
    await p;
  });

  it('o Claude continua detectado como claude (a detecção recebe a CLI)', async () => {
    const detect = vi.fn(async () => OK);
    const t = setup({ detect });
    const p = (await startC(t, {})).done;
    expect(detect).toHaveBeenCalledWith('claude', 'claude');
    t.runs[0]!.finish();
    await p;
  });

  it('modelo, esforço e sandbox do chat do Codex viram -m, -c model_reasoning_effort e -s', async () => {
    const t = setup();
    const p = (await startC(t, { options: { cli: 'codex', model: 'gpt-x', effort: 'high', sandbox: 'read-only' } })).done;
    expect(argsOf(t)).toEqual(expect.arrayContaining(['-s', 'read-only', '-m', 'gpt-x', '-c', 'model_reasoning_effort="high"']));
    t.runs[0]!.finish();
    await p;
  });

  it('sandbox das settings vale quando o chat não escolhe', async () => {
    const t = setup({}, { codexSandbox: 'read-only' });
    const p = (await startC(t, { options: { cli: 'codex' } })).done;
    expect(argsOf(t)).toEqual(expect.arrayContaining(['-s', 'read-only']));
    t.runs[0]!.finish();
    await p;
  });

  it('opções que não combinam com a CLI são recusadas com aviso claro e nada é criado', async () => {
    const t = setup();
    await t.c.handle({ type: 'start', prompt: 'x', options: { cli: 'claude', effort: 'ultra' } });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.notices().at(-1)!.text).toMatch(/esforço/i);
    await t.c.handle({ type: 'start', prompt: 'x', options: { cli: 'codex', permissionMode: 'plan' } });
    await t.c.handle({ type: 'start', prompt: 'x', options: { sandbox: 'read-only' } });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.snaps().at(-1)?.runs ?? []).toEqual([]);
  });

  it('a conversa seguinte no Codex usa `exec resume` com o thread_id, sandbox via -c, sem repetir a instrução', async () => {
    const t = setup();
    const p = (await startC(t, { options: { cli: 'codex', model: 'gpt-x' } })).done;
    t.runs[0]!.emit(codexThread('r1'));
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 2 });
    t.runs[0]!.finish();
    await p;
    const q = t.c.handle({ type: 'send', nodeId: 'r1:root', text: 'segue' });
    await t.tick();
    const { opts } = t.runs[1]!;
    expect(opts.adapter).toBe('codex');
    expect(opts.args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(opts.args).toEqual(expect.arrayContaining(['-c', 'sandbox_mode="workspace-write"', '-m', 'gpt-x']));
    expect(opts.args.slice(-3)).toEqual(['--', 'thread-9', 'segue']); // sem o prefixo da instrução
    expect(opts.args).not.toContain('-s');
    expect(opts.resume).toEqual({ subagents: [], tasks: {} });
    t.runs[1]!.finish();
    await q;
  });

  it('o Codex não tem subagentes: "novo agente" num chat do Codex é recusado', async () => {
    const t = setup();
    const p = (await startC(t, { options: { cli: 'codex' } })).done;
    t.runs[0]!.emit(codexThread('r1'));
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'done', ts: 2 });
    t.runs[0]!.finish();
    await p;
    await t.c.handle({ type: 'spawn', agentType: 'reader', task: 'x', runId: 'r1' });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.notices().at(-1)!.text).toMatch(/subagente/i);
    expect(t.startRun).toHaveBeenCalledTimes(1);
  });

  it('anexos no Codex: caminhos no prompt, sem regras de permissão do Claude e sem aviso de "fora do projeto"', async () => {
    const t = setup();
    t.setPicked(['/fora/a.txt']);
    await t.c.handle({ type: 'pickFiles', requestId: 'q' });
    const p = (await startC(t, { options: { cli: 'codex' }, attachments: ['/fora/a.txt'] })).done;
    const args = argsOf(t);
    expect(args.at(-1)).toContain('- /fora/a.txt');
    expect(args).not.toContain('--allowedTools');
    expect(t.notices().some((n) => n.level === 'warn')).toBe(false);
    t.runs[0]!.finish();
    await p;
  });

  it('a verificação de login é por CLI: um chat de cada, duas detecções, e o ready reenvia as duas com o id da CLI', async () => {
    const detect = vi.fn(async (_cmd: string, cli?: string) => (cli === 'codex' ? ({ state: 'ok', version: '0.157.1', authMethod: 'ChatGPT' } as CliCheck) : OK));
    const t = setup({ detect });
    const a = (await startC(t, {})).done;
    const b = (await startC(t, { options: { cli: 'codex' } })).done;
    expect(detect).toHaveBeenCalledTimes(2);
    t.posted.length = 0;
    await t.c.handle({ type: 'ready' });
    const clis = t.posted.filter((m) => m.type === 'cli') as any[];
    expect(clis.map((m) => m.cli).sort()).toEqual(['claude', 'codex']);
    expect(clis.find((m) => m.cli === 'codex').check.authMethod).toBe('ChatGPT');
    t.runs.forEach((r) => r.finish());
    await Promise.all([a, b]);
  });

  it('Codex não instalado ou deslogado: diagnóstico e nenhum chat criado', async () => {
    const t = setup({ detect: async () => ({ state: 'not_authenticated', version: '1', message: 'rode codex login' }) });
    await t.c.handle({ type: 'start', prompt: 'x', options: { cli: 'codex' } });
    expect(t.startRun).not.toHaveBeenCalled();
    expect(t.posted.find((m) => m.type === 'cli')).toMatchObject({ cli: 'codex' });
  });

  // ---------- editar as opções depois de criado ----------
  it('setOptions troca modelo/esforço/permissões do chat; valem a partir da próxima mensagem (retomada) e a CLI não muda', async () => {
    const t = setup();
    const id = await waitingChat(t);
    await t.c.handle({ type: 'setOptions', runId: id, options: { model: 'haiku', effort: 'low', permissionMode: 'plan' } });
    expect(t.view(id).options).toEqual({ model: 'haiku', effort: 'low', permissionMode: 'plan' });
    const p = t.c.handle({ type: 'send', nodeId: `${id}:root`, text: 'segue' });
    await t.tick();
    const args = t.runs.at(-1)!.opts.args;
    expect(args).toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'low', '--permission-mode', 'plan']));
    t.runs.at(-1)!.finish();
    await p;
  });

  it('setOptions {} volta aos padrões; preserva o cli do chat; chat desconhecido é ignorado', async () => {
    const t = setup();
    const p = (await startC(t, { options: { cli: 'codex', model: 'gpt-x' } })).done;
    t.runs[0]!.finish();
    await p;
    await t.c.handle({ type: 'setOptions', runId: 'r1', options: {} });
    expect(t.view('r1').options).toEqual({ cli: 'codex' });
    await t.c.handle({ type: 'setOptions', runId: 'r1', options: { sandbox: 'read-only', effort: 'low' } });
    expect(t.view('r1').options).toEqual({ cli: 'codex', sandbox: 'read-only', effort: 'low' });
    await t.c.handle({ type: 'setOptions', runId: 'zzz', options: { model: 'x' } });
    expect(t.snaps().at(-1)!.runs).toHaveLength(1);
  });

  it('setOptions que não combina com a CLI do chat é recusado e não altera nada', async () => {
    const t = setup();
    const p = (await startC(t, { options: { cli: 'codex' } })).done;
    t.runs[0]!.finish();
    await p;
    await t.c.handle({ type: 'setOptions', runId: 'r1', options: { permissionMode: 'plan' } });
    expect(t.notices().at(-1)).toMatchObject({ level: 'error' });
    expect(t.view('r1').options).toEqual({ cli: 'codex' });
    await t.c.handle({ type: 'setOptions', runId: 'r1', options: { cli: 'claude' } });
    expect(t.view('r1').options).toEqual({ cli: 'codex' }); // a CLI é fixa por chat
  });

  it('mudar as opções com o chat executando não interrompe o turno: valem para o próximo', async () => {
    const t = setup();
    const p = (await startC(t, { options: { model: 'opus' } })).done;
    await t.c.handle({ type: 'setOptions', runId: 'r1', options: { model: 'haiku' } });
    expect(t.view('r1').options).toEqual({ model: 'haiku' });
    expect(argsOf(t)).toEqual(expect.arrayContaining(['--model', 'opus'])); // o turno em andamento seguiu como começou
    t.runs[0]!.finish();
    await p;
  });

  it('erro de um chat do Codex: o aviso traz o motivo do evento de erro, não o ruído do stderr', async () => {
    const t = setup();
    const p = (await startC(t, { options: { cli: 'codex', model: 'nao-existe' } })).done;
    const r = t.runs[0]!;
    r.emit(codexThread('r1'));
    r.emit({ type: 'node_event', runId: 'r1', nodeId: 'r1:root', kind: 'error', payload: "The 'nao-existe' model is not supported when using Codex with a ChatGPT account.", ts: 2 });
    r.emit({ type: 'run_finished', runId: 'r1', status: 'error', ts: 3 });
    r.finish(result({ exitCode: 1, stderrTail: 'Reading additional input from stdin...' }));
    await p;
    const last = t.notices().at(-1)!;
    expect(last.level).toBe('error');
    expect(last.text).toContain('not supported when using Codex');
    expect(last.text).not.toContain('Reading additional input');
  });

  it('sem evento de erro continua usando o final do stderr (comportamento anterior)', async () => {
    const t = setup();
    const p = (await startC(t, { options: { cli: 'codex' } })).done;
    t.runs[0]!.emit(codexThread('r1'));
    t.runs[0]!.emit({ type: 'run_finished', runId: 'r1', status: 'error', ts: 3 });
    t.runs[0]!.finish(result({ exitCode: 2, stderrTail: 'algo no stderr' }));
    await p;
    expect(t.notices().at(-1)!.text).toContain('algo no stderr');
  });
});

describe('configuração inicial dos CLIs', () => {
  const MISSING: CliCheck = { state: 'not_installed', message: 'sem cli' };

  it('recheckCli sem cli verifica os dois, mas não incomoda com Codex ausente', async () => {
    const detect = vi.fn(async (_c: string, cli?: string) => (cli === 'codex' ? MISSING : OK));
    const { c, posted } = setup({ detect });
    await c.handle({ type: 'recheckCli' });
    const checks = posted.filter((m) => m.type === 'cli') as any[];
    expect(checks.map((m) => m.cli)).toEqual(['claude']);
  });

  it('recheckCli com cli posta sempre, inclusive ausente', async () => {
    const { c, posted } = setup({ detect: async () => MISSING });
    await c.handle({ type: 'recheckCli', cli: 'codex' });
    expect(posted).toContainEqual({ type: 'cli', check: MISSING, cli: 'codex' });
  });

  it('installCli e loginCli delegam ao terminal', async () => {
    const setupDeps = { install: vi.fn(), login: vi.fn(), pickPath: vi.fn(), savePath: vi.fn() };
    const { c } = setup({ setup: setupDeps } as any);
    await c.handle({ type: 'installCli', cli: 'claude' });
    await c.handle({ type: 'loginCli', cli: 'codex' });
    expect(setupDeps.install).toHaveBeenCalledWith('claude');
    expect(setupDeps.login).toHaveBeenCalledWith('codex', 'codex');
  });

  it('pickCliPath grava o caminho só se o executável responde', async () => {
    const setupDeps = { install: vi.fn(), login: vi.fn(), pickPath: vi.fn(async () => '/x/claude'), savePath: vi.fn() };
    const { c, posted } = setup({ setup: setupDeps, detect: async () => OK } as any);
    await c.handle({ type: 'pickCliPath', cli: 'claude' });
    expect(setupDeps.savePath).toHaveBeenCalledWith('claude', '/x/claude');
    expect(posted).toContainEqual({ type: 'cli', check: OK, cli: 'claude' });
  });

  it('pickCliPath com arquivo que não responde avisa e não grava', async () => {
    const setupDeps = { install: vi.fn(), login: vi.fn(), pickPath: vi.fn(async () => '/x/lixo'), savePath: vi.fn() };
    const { c, notices } = setup({ setup: setupDeps, detect: async () => MISSING } as any);
    await c.handle({ type: 'pickCliPath', cli: 'claude' });
    expect(setupDeps.savePath).not.toHaveBeenCalled();
    expect(notices()[0]?.level).toBe('error');
  });

  it('pickCliPath cancelado não faz nada', async () => {
    const setupDeps = { install: vi.fn(), login: vi.fn(), pickPath: vi.fn(async () => undefined), savePath: vi.fn() };
    const { c, posted } = setup({ setup: setupDeps } as any);
    await c.handle({ type: 'pickCliPath', cli: 'claude' });
    expect(setupDeps.savePath).not.toHaveBeenCalled();
    expect(posted.filter((m) => m.type === 'cli')).toEqual([]);
  });
});

describe('CLI sem login', () => {
  const LOGGED_OUT: CliCheck = { state: 'not_authenticated', version: '1', message: 'login' };

  it('avisa que a mensagem não foi enviada (chat novo e retomada) em vez de descartar em silêncio', async () => {
    let check: CliCheck = OK;
    const t = setup({ detect: async () => check });
    const first = (await startChat(t)).done;
    t.runs.at(-1)!.emit(init('r1'));
    t.runs.at(-1)!.finish();
    await first;
    check = LOGGED_OUT;
    await t.c.handle({ type: 'recheckCli', cli: 'claude' }); // o banner passa a mostrar o problema
    const before = t.notices().length;
    await t.c.handle({ type: 'send', nodeId: 'r1:root', text: 'oi' });
    expect(t.notices().slice(before).some((n) => n.level === 'error' && /não enviada/.test(n.text))).toBe(true);
    expect(t.startRun).toHaveBeenCalledTimes(1);
    await t.c.handle({ type: 'start', prompt: 'novo' });
    expect(t.notices().at(-1)!.text).toMatch(/não enviada/);
    expect(t.startRun).toHaveBeenCalledTimes(1);
  });

  it('"Verificar de novo" responde com um aviso, e voltar ao painel reconfere só o que estava com problema', async () => {
    let check: CliCheck = LOGGED_OUT;
    const detect = vi.fn(async () => check);
    const t = setup({ detect });
    await t.c.handle({ type: 'recheckCli', cli: 'claude' });
    expect(t.notices().at(-1)!.text).toMatch(/continua/);
    check = OK;
    await t.c.refreshProblems();
    expect((t.posted.filter((m) => m.type === 'cli').at(-1) as any).check.state).toBe('ok');
    const calls = detect.mock.calls.length;
    await t.c.refreshProblems(); // já está ok: não executa o CLI de novo
    expect(detect.mock.calls.length).toBe(calls);
  });
});
