import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs } from '../cli/claude-args';
import { buildCodexArgs } from '../cli/codex-args';
import type { Capabilities } from '../cli/capabilities';
import type { CliCheck } from '../cli/detect';
import { optionsError, type ChatOptions, type CliId } from '../core/options';
import type { ProcessRun, ProcessRunOptions } from '../cli/process-run';
import { QUESTION_INSTRUCTION } from '../cli/question-instruction';
import type { ResumeSeed } from '../cli/stream-adapter';
import type { NormalizedEvent } from '../core/schema';
import { toEventViews, toRunView } from '../core/snapshot';
import { RunStore } from '../core/store';
import { alwaysSuggestion } from '../core/permission';
import { userMessageLine, type PermissionDecision } from '../cli/claude-input';
import type { AgentInfo, AttachedFile, CliInfo, HostMessage, NodeBox, WebviewMessage } from '../protocol';
import { mergeAgents } from './agents';
import { NO_LOG, type DiagLog } from './diag-log';
import { isSensitivePath, readRule } from './files';
import type { VisorSettings } from './settings';

export interface ControllerDeps {
  post(msg: HostMessage): void;
  cwd(): string | undefined;
  settings(): VisorSettings;
  detect(command: string, cli?: CliId): Promise<CliCheck>;
  prefs: { authBannerDismissed(): boolean; dismissAuthBanner(): void };
  listAgents(cwd: string): Promise<AgentInfo[]>;
  listClis(): Promise<CliInfo[]>;
  /** skills/comandos e modelo padrão informados pelo próprio CLI (lê o `init`, sem gastar tokens) */
  capabilities(cwd: string): Promise<Capabilities>;
  /** abre o seletor de arquivos do VS Code; devolve os caminhos escolhidos ([] se cancelar) */
  pickFiles(): Promise<string[]>;
  /** grava uma imagem colada num arquivo temporário e devolve o caminho */
  savePastedImage(mime: string, bytes: Buffer): Promise<string>;
  /** confere quais caminhos existem e se são pastas */
  checkAttachments(paths: string[]): Promise<AttachedFile[]>;
  /** configuração inicial dos CLIs (terminal e seletor de arquivo do VS Code) */
  setup?: {
    install(cli: CliId): void;
    login(cli: CliId, command: string): void;
    pickPath(cli: CliId): Promise<string | undefined>;
    savePath(cli: CliId, path: string): void;
  };
  nowMs?(): number;
  homedir?(): string;
  startRun(runId: string, opts: ProcessRunOptions, onEvent: (e: NormalizedEvent) => void): ProcessRun;
  flushMs?: number;
  newRunId?(): string;
  /** log de diagnóstico (canal "Visor"); ausente nos testes que não o verificam */
  log?: DiagLog;
}

/** Uma conversa independente: um run (sessão do Claude) com seu grafo e seu processo. */
interface Chat {
  store: RunStore;
  active?: ProcessRun;
  busy: boolean;
  cancelRequested: boolean;
  /** pedidos de permissão do Claude aguardando a pessoa (com a entrada e as sugestões completas, só no host) */
  pending: Map<string, Extract<NormalizedEvent, { type: 'permission_request' }>>;
  /** o processo ativo já emitiu o fim do turno, mas segue vivo (tarefas em segundo plano) */
  turnOver: boolean;
  /** opções com que o processo ativo foi iniciado (a resposta pelo stdin só vale se não mudaram) */
  activeOptions?: string;
  /** termina quando o turno em andamento termina (para esperar o processo sair antes de retomar) */
  turn?: Promise<void>;
  /** o processo ativo está sendo trocado por outro: o cancelamento não é da pessoa, então sem aviso */
  replacing?: boolean;
  /** watchdog: com o turno encerrado, o processo vivo ficou sem dar sinal */
  stalled?: boolean;
  stallTimer?: NodeJS.Timeout;
  /** o processo ativo respondeu "sem login": a próxima mensagem vai para um processo novo */
  authLost?: boolean;
}

interface Turn {
  prompt: string;
  fresh: boolean;
  echo?: { nodeId: string; text: string; attachments?: string[] };
  /** anexos desta mensagem (já conferidos): definem as pastas extras liberadas ao agente */
  attachments?: AttachedFile[];
  /** node que enviou a mensagem: recebe um answer_ack */
  ack?: string;
}

const CAPS_TTL_MS = 60_000;
const FLUSH_MS = 150; // intervalo entre atualizações da Webview durante a execução

/** Acrescenta ao texto a lista de arquivos anexados (o agente lê pelas ferramentas dele). */
function withAttachments(text: string, files: AttachedFile[]): string {
  if (files.length === 0) return text;
  const list = files.map((f) => `- ${f.path}${f.isDir ? ' (directory)' : ''}`).join('\n');
  const header = `Files attached by the user (read them with your tools as needed):\n${list}`;
  return text.trim() ? `${text}\n\n${header}` : header;
}

/** Anexos que ficam fora do projeto (o agente só pode ler o projeto; esses ganham uma regra de leitura própria). */
function outsideFiles(files: AttachedFile[], cwd: string): AttachedFile[] {
  return files.filter((f) => {
    const rel = path.relative(cwd, f.path);
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  });
}

const TITLE_MAX = 40;
const CHAT_LOG_EVENTS = 100; // eventos mais recentes mostrados no cartão do chat
const CHAT_LOG_CHARS = 4000; // limite de texto por evento no cartão

/** Primeira linha do texto, numa linha só e curta; vazio se não houver texto. */
function titleFrom(text: string): string {
  const line = (text.split('\n').map((s) => s.trim()).find(Boolean) ?? '').replace(/\s+/g, ' ');
  return line.length > TITLE_MAX ? line.slice(0, TITLE_MAX).trimEnd() + '…' : line;
}

/** Texto do último evento de erro do nó raiz (ex.: o motivo de um `turn.failed` do Codex), se houver. */
function lastErrorEvent(store: RunStore): string | undefined {
  const errors = store.eventsOf(store.rootId).filter((e) => e.kind === 'error');
  const last = errors[errors.length - 1]?.payload;
  return typeof last === 'string' && last ? last.slice(-500) : undefined;
}

export class RunController {
  private readonly chats = new Map<string, Chat>();
  private readonly pendingStarts = new Set<{ cancelled: boolean }>();
  private inspected?: string;
  private timer?: NodeJS.Timeout;
  private readonly lastChecks = new Map<CliId, CliCheck>();
  private untitled = 0;
  private startingCount = 0;
  private caps?: { at: number; cwd: string; value: Capabilities };
  private readonly capsInflight = new Map<string, Promise<Capabilities | undefined>>();
  /** reverificação do login em voo (vários chats perdendo o login ao mesmo tempo dividem uma só) */
  private authRecheck?: Promise<void>;
  /** caminhos que o seletor de arquivos devolveu: só estes podem ser anexados (a Webview não escolhe sozinha) */
  private readonly pickedPaths = new Set<string>();
  /** imagens coladas que o próprio Visor gravou: ficam fora do projeto de propósito, então não avisamos */
  private readonly pastedPaths = new Set<string>();
  /** posições/tamanhos que a pessoa escolheu no canvas (memória do host, como as conversas) */
  private readonly boxes = new Map<string, NodeBox>();
  /** chats que mudaram desde o último snapshot (para só reenviar o log do node inspecionado quando preciso) */
  private readonly dirty = new Set<string>();
  /** quantos eventos da raiz já foram enviados no chat_log de cada chat */
  private readonly sentLogCount = new Map<string, number>();

  constructor(private readonly deps: ControllerDeps) {}

  private get log(): DiagLog {
    return this.deps.log ?? NO_LOG;
  }

  async handle(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postPrefs();
        for (const [cli, check] of this.lastChecks) this.deps.post({ type: 'cli', check, cli });
        if (this.boxes.size > 0) this.deps.post({ type: 'layout', boxes: Object.fromEntries(this.boxes) });
        this.postSnapshot(true);
        return;
      case 'start':
        return this.startChat(msg.prompt, msg.title, undefined, msg.options, msg.attachments);
      case 'cancel':
        this.cancelChat(msg.runId);
        return;
      case 'dismissAuth':
        this.deps.prefs.dismissAuthBanner();
        this.postPrefs();
        return;
      case 'inspect':
        this.inspected = msg.nodeId ?? undefined;
        this.postNodeLog();
        return;
      case 'send':
        return this.send(msg.nodeId, msg.text, msg.attachments);
      case 'permission':
        this.answerPermission(msg.runId, msg.requestId, msg.decision);
        return;
      case 'setOptions':
        this.setOptions(msg.runId, msg.options);
        return;
      case 'pickFiles':
        return this.pickFiles(msg.requestId);
      case 'pasteImage':
        return this.pasteImage(msg.requestId, msg.mime, msg.data);
      case 'listClis':
        return this.listClis();
      case 'recheckCli':
        return this.recheckCli(msg.cli);
      case 'installCli':
        this.deps.setup?.install(msg.cli);
        return;
      case 'loginCli':
        this.deps.setup?.login(msg.cli, this.commandOf(msg.cli));
        return;
      case 'pickCliPath':
        return this.pickCliPath(msg.cli);
      case 'listCapabilities':
        return this.listCapabilities();
      case 'spawn':
        return this.spawnAgent(msg.agentType, msg.task, msg.runId);
      case 'markDone':
        this.markDone(msg.runId);
        return;
      case 'keepWaiting': {
        const chat = this.chats.get(msg.runId);
        if (!chat) return;
        this.clearStall(chat);
        this.armStall(chat);
        this.flush();
        return;
      }
      case 'removeChat':
        this.removeChat(msg.runId);
        return;
      case 'rename': {
        const chat = this.chats.get(msg.runId);
        if (!chat) return;
        chat.store.run.title = msg.title;
        this.dirty.add(msg.runId);
        this.flush();
        return;
      }
      case 'moveNode': {
        if (!this.chatOfNode(msg.nodeId)) return; // só guardamos posição de nodes que existem
        const { type: _t, nodeId, ...box } = msg;
        this.boxes.set(nodeId, box);
        return;
      }
      case 'cancelPending':
        for (const token of this.pendingStarts) token.cancelled = true;
        return;
      case 'listAgents':
        return this.listAgents();
    }
  }

  /** Cancela todas as conversas ativas (e inícios ainda em andamento). `immediate`: sem esperar o SIGTERM (fechamento). */
  cancelAll(immediate = false): void {
    for (const token of this.pendingStarts) token.cancelled = true;
    for (const id of this.chats.keys()) this.cancelChat(id, immediate);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const chat of this.chats.values()) clearTimeout(chat.stallTimer);
    // O host pode encerrar antes de um timer de SIGKILL disparar: mata na hora.
    this.cancelAll(true);
  }

  // ---------- mensagens ao host/Webview ----------

  private notice(level: 'info' | 'warn' | 'error', text: string, chat?: Chat): void {
    const title = chat?.store.run.title;
    const prefix = chat && title && this.chats.size > 1 ? `${title}: ` : '';
    this.deps.post({ type: 'notice', level, text: prefix + text });
  }

  private postPrefs(): void {
    this.deps.post({ type: 'prefs', authBannerDismissed: this.deps.prefs.authBannerDismissed() });
  }

  private postSnapshot(forceLog = false): void {
    const t0 = Date.now();
    const runs = [...this.chats.values()].map((c) => toRunView(c.store, c.busy && !c.turnOver, { lingering: c.busy && c.turnOver, stalled: !!c.stalled }));
    this.deps.post({ type: 'snapshot', runs });
    if (this.log.debugEnabled()) {
      this.log.debug('snapshot', { chats: runs.length, bytes: JSON.stringify(runs).length, ms: Date.now() - t0 });
    }
    // O cartão de cada chat mostra a conversa ao vivo: reenvia só os chats que mudaram (ou todos, se pedido).
    for (const [id, chat] of this.chats) if (forceLog || this.dirty.has(id)) this.postChatLog(chat, forceLog);
    // O log do node inspecionado só é reenviado se o chat dele mudou (ou se foi pedido).
    const owner = this.inspected ? this.chatOfNode(this.inspected) : undefined;
    if (forceLog || !owner || this.dirty.has(owner.store.run.id)) this.postNodeLog();
    this.dirty.clear();
  }

  private postChatLog(chat: Chat, force: boolean): void {
    const root = chat.store.nodes.get(chat.store.rootId);
    // Só reenvia se a conversa da raiz mudou (eventos só de subagentes não alteram o que o cartão mostra).
    if (!force && root && this.sentLogCount.get(chat.store.run.id) === root.eventCount) return;
    this.sentLogCount.set(chat.store.run.id, root?.eventCount ?? 0);
    const events = toEventViews(chat.store.eventsOf(chat.store.rootId).slice(-CHAT_LOG_EVENTS), CHAT_LOG_CHARS);
    this.deps.post({ type: 'chat_log', runId: chat.store.run.id, events, total: root?.eventCount ?? 0 });
  }

  /** Envia só o log do node que a Webview está inspecionando (poucos dados, atualizado a cada flush). */
  private postNodeLog(): void {
    const id = this.inspected;
    if (!id) return;
    const store = this.chatOfNode(id)?.store;
    const node = store?.nodes.get(id);
    const events = node && store ? toEventViews(store.eventsOf(id)) : [];
    this.deps.post({ type: 'node_log', nodeId: id, events, total: node?.eventCount ?? 0 });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.postSnapshot();
    }, this.deps.flushMs ?? FLUSH_MS);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.postSnapshot();
  }

  private chatOfNode(nodeId: string): Chat | undefined {
    for (const chat of this.chats.values()) if (chat.store.nodes.has(nodeId)) return chat;
    return undefined;
  }

  // ---------- ações ----------

  private cancelChat(runId: string, immediate = false): void {
    const chat = this.chats.get(runId);
    if (!chat) return;
    if (chat.active) {
      if (immediate) chat.active.cancel({ immediate: true });
      else chat.active.cancel();
    } else if (chat.busy) chat.cancelRequested = true;
  }

  /** Decisão da pessoa sobre um pedido de permissão do Claude: vira o control_response no stdin do processo. */
  private answerPermission(runId: string, requestId: string, decision: 'allow' | 'allow_always' | 'deny'): void {
    const chat = this.chats.get(runId);
    const req = chat?.pending.get(requestId);
    if (!chat || !req) {
      this.notice('warn', 'Esse pedido de permissão não está mais ativo.', chat);
      return;
    }
    chat.pending.delete(requestId);
    this.armStall(chat);
    let answer: PermissionDecision;
    if (decision === 'deny') {
      answer = { behavior: 'deny', message: 'Negado pelo usuário no Visor.' };
    } else {
      const always = decision === 'allow_always' ? alwaysSuggestion(req.suggestions) : undefined;
      answer = { behavior: 'allow', updatedInput: req.input, ...(always ? { updatedPermissions: [always] } : {}) };
    }
    const delivered = chat.active?.respond(requestId, answer) ?? false;
    chat.store.apply({ type: 'permission_resolved', runId, requestId, ts: Date.now() });
    this.dirty.add(runId);
    this.schedule();
    if (!delivered) this.notice('warn', 'Não consegui entregar a permissão: o processo já terminou.', chat);
  }

  /** O processo terminou: os pedidos que ninguém respondeu não existem mais (nem para a tela). */
  private dropPendingPermissions(chat: Chat): void {
    for (const requestId of chat.pending.keys()) {
      chat.store.apply({ type: 'permission_resolved', runId: chat.store.run.id, requestId, ts: Date.now() });
    }
    chat.pending.clear();
  }

  /** Rearma o watchdog a cada sinal do processo; só conta com o turno encerrado e o processo vivo. */
  private armStall(chat: Chat): void {
    clearTimeout(chat.stallTimer);
    chat.stallTimer = undefined;
    const minutes = this.deps.settings().lingerTimeoutMinutes;
    if (!chat.turnOver || !chat.active || minutes <= 0) return;
    chat.stallTimer = setTimeout(() => {
      chat.stallTimer = undefined;
      // Com permissão pendente o processo espera a pessoa, não está travado.
      if (!chat.turnOver || !chat.active || chat.pending.size > 0) return;
      chat.stalled = true;
      this.log.info('stall', { runId: chat.store.run.id.slice(0, 8), pid: chat.active.pid, minutes });
      this.dirty.add(chat.store.run.id);
      this.flush();
    }, minutes * 60_000);
  }

  private clearStall(chat: Chat): void {
    clearTimeout(chat.stallTimer);
    chat.stallTimer = undefined;
    if (chat.stalled) {
      chat.stalled = false;
      this.dirty.add(chat.store.run.id);
    }
  }

  private markDone(runId: string): void {
    const chat = this.chats.get(runId);
    if (!chat || (chat.busy && !chat.turnOver) || chat.store.run.status !== 'waiting') return;
    chat.store.apply({ type: 'run_finished', runId, status: 'done', ts: Date.now() });
    this.dirty.add(runId);
    this.flush();
  }

  private removeChat(runId: string): void {
    const chat = this.chats.get(runId);
    if (!chat) return;
    if (chat.busy) {
      this.notice('warn', 'Esta conversa ainda está executando: cancele-a antes de removê-la.', chat);
      return;
    }
    if (this.inspected && chat.store.nodes.has(this.inspected)) this.inspected = undefined;
    this.chats.delete(runId);
    this.dirty.delete(runId);
    this.sentLogCount.delete(runId);
    for (const id of [...this.boxes.keys()]) if (id.startsWith(`${runId}:`)) this.boxes.delete(id);
    this.flush();
  }

  private async listAgents(): Promise<void> {
    let project: AgentInfo[] = [];
    try {
      const cwd = this.deps.cwd();
      if (cwd) project = await this.deps.listAgents(cwd);
    } catch {
      /* sem agentes do projeto: ficam só os nativos */
    }
    this.deps.post({ type: 'agents', agents: mergeAgents(project) });
  }

  /** Troca modelo/esforço/permissões (ou sandbox) de um chat: valem a partir da PRÓXIMA mensagem. A CLI é fixa. */
  private setOptions(runId: string, options: ChatOptions): void {
    const chat = this.chats.get(runId);
    if (!chat) return;
    const cli = chat.store.run.options?.cli;
    if (options.cli && options.cli !== (cli ?? 'claude')) {
      this.notice('error', 'A CLI não muda no meio de um chat: a sessão pertence a ela. Crie um chat novo para usar outra.', chat);
      return;
    }
    const { cli: _ignored, ...rest } = options;
    const next: ChatOptions = { ...(cli ? { cli } : {}), ...rest };
    const err = optionsError(next);
    if (err) {
      this.notice('error', err, chat);
      return;
    }
    if (Object.keys(next).length > 0) chat.store.run.options = next;
    else delete chat.store.run.options;
    this.dirty.add(runId);
    this.flush();
  }

  private async pasteImage(requestId: string, mime: string, data: string): Promise<void> {
    let files: AttachedFile[] = [];
    try {
      const saved = await this.deps.savePastedImage(mime, Buffer.from(data, 'base64'));
      files = await this.deps.checkAttachments([saved]);
      for (const f of files) {
        this.pickedPaths.add(f.path);
        this.pastedPaths.add(f.path);
      }
    } catch {
      this.notice('error', 'Não foi possível salvar a imagem colada.');
    }
    this.deps.post({ type: 'files', requestId, files });
  }

  private async pickFiles(requestId: string): Promise<void> {
    let files: AttachedFile[] = [];
    try {
      const home = this.deps.homedir?.() ?? os.homedir();
      const paths = await this.deps.pickFiles();
      const allowed = paths.filter((p) => !isSensitivePath(p, home));
      if (allowed.length < paths.length) {
        this.notice('warn', 'Alguns itens foram bloqueados como anexo: a pasta pessoal, chaves e credenciais (~/.ssh, ~/.claude, ~/.aws…) nunca são repassadas ao agente.');
      }
      files = allowed.length ? await this.deps.checkAttachments(allowed) : [];
      for (const f of files) this.pickedPaths.add(f.path);
    } catch {
      files = [];
    }
    this.deps.post({ type: 'files', requestId, files });
  }

  private commandOf(cli: CliId): string {
    const s = this.deps.settings();
    return cli === 'codex' ? s.codexPath : s.claudePath;
  }

  private async checkCli(cli: CliId, command = this.commandOf(cli)): Promise<CliCheck> {
    const check = await this.deps.detect(command, cli);
    this.lastChecks.set(cli, check);
    return check;
  }

  /** CLI ausente ou sem login: nada é enviado, e a pessoa precisa saber (o banner do topo passa despercebido). */
  private blockedByCli(check: CliCheck, cli: CliId, chat?: Chat): boolean {
    if (check.state !== 'not_installed' && check.state !== 'not_authenticated') return false;
    const name = cli === 'codex' ? 'Codex' : 'Claude Code';
    const why = check.state === 'not_installed' ? `o ${name} não foi encontrado` : `o ${name} não está autenticado`;
    this.notice('error', `Mensagem não enviada: ${why}. Use os botões do aviso no topo (Fazer login / Verificar de novo) e envie de novo.`, chat);
    return true;
  }

  /** O CLI respondeu "Not logged in" (ou 401) neste processo: banner de login, aviso no chat e uma reverificação. */
  private onAuthLost(chat: Chat): void {
    chat.authLost = true;
    this.log.info('auth_lost', { runId: chat.store.run.id.slice(0, 8), pid: chat.active?.pid });
    const prev = this.lastChecks.get('claude');
    const check: CliCheck = {
      state: 'not_authenticated',
      version: prev && 'version' in prev ? prev.version : '',
      message: 'O Claude Code perdeu o login neste processo (o terminal pode continuar logado). Clique em Verificar de novo; se continuar, faça login.',
    };
    this.lastChecks.set('claude', check);
    this.deps.post({ type: 'cli', check, cli: 'claude' });
    this.notice('error', 'O Claude Code respondeu "Not logged in". Use o aviso no topo: Verificar de novo / Fazer login.', chat);
    if (this.authRecheck) return;
    this.authRecheck = this.checkCli('claude')
      .then((c) => {
        this.deps.post({ type: 'cli', check: c, cli: 'claude' });
        if (c.state === 'ok') this.notice('info', 'Claude Code: o login do CLI está ok. Envie a mensagem de novo (o próximo turno usa um processo novo).');
      }, () => undefined)
      .finally(() => {
        this.authRecheck = undefined;
      });
  }

  /** Reconfere só os CLIs que estavam com problema (ex.: a pessoa fez login no terminal e voltou ao painel). */
  async refreshProblems(): Promise<void> {
    const bad = [...this.lastChecks].filter(([, c]) => c.state !== 'ok').map(([cli]) => cli);
    await Promise.all(
      bad.map(async (cli) => {
        const check = await this.checkCli(cli);
        this.deps.post({ type: 'cli', check, cli });
      }),
    );
  }

  /** Sem `only`, verifica os dois ao abrir o canvas; um CLI ausente que a pessoa nunca pediu fica quieto. */
  private async recheckCli(only?: CliId): Promise<void> {
    const ids: CliId[] = only ? [only] : ['claude', 'codex'];
    await Promise.all(
      ids.map(async (cli) => {
        const check = await this.checkCli(cli);
        if (!only && check.state === 'not_installed' && cli !== 'claude') {
          this.lastChecks.delete(cli);
          return;
        }
        this.deps.post({ type: 'cli', check, cli });
        if (only) {
          const name = cli === 'codex' ? 'Codex' : 'Claude Code';
          if (check.state === 'ok') this.notice('info', `${name}: tudo certo, pode enviar mensagens.`);
          else this.notice('warn', `${name}: o problema continua (${check.state === 'not_installed' ? 'não encontrado' : 'sem login'}).`);
        }
      }),
    );
  }

  private async pickCliPath(cli: CliId): Promise<void> {
    const picked = await this.deps.setup?.pickPath(cli);
    if (!picked) return;
    const check = await this.deps.detect(picked, cli);
    if (check.state === 'not_installed') {
      this.notice('error', `Esse arquivo não respondeu a --version como o ${cli === 'codex' ? 'Codex' : 'Claude Code'}: ${picked}`);
      return;
    }
    this.deps.setup?.savePath(cli, picked);
    this.lastChecks.set(cli, check);
    this.deps.post({ type: 'cli', check, cli });
    void this.listClis();
  }

  private async listClis(): Promise<void> {
    let clis: CliInfo[] = [];
    try {
      clis = await this.deps.listClis();
    } catch {
      /* sem detecção: o diálogo mostra só o padrão */
    }
    this.deps.post({ type: 'clis', clis });
  }

  private async listCapabilities(): Promise<void> {
    const cwd = this.deps.cwd();
    let caps: Capabilities | undefined;
    if (cwd) {
      const now = this.deps.nowMs?.() ?? Date.now();
      if (this.caps && this.caps.cwd === cwd && now - this.caps.at < CAPS_TTL_MS) {
        caps = this.caps.value;
      } else {
        // Vários pedidos ao mesmo tempo (abrir o diálogo + digitar "/") dividem um único processo.
        let pending = this.capsInflight.get(cwd);
        if (!pending) {
          pending = this.deps.capabilities(cwd).then(
            (value) => {
              // Resultado vazio (falha/timeout) não fica em cache: o próximo pedido tenta de novo.
              if (value.commands.length > 0) this.caps = { at: now, cwd, value };
              return value;
            },
            () => undefined,
          );
          this.capsInflight.set(cwd, pending);
          void pending.finally(() => this.capsInflight.delete(cwd));
        }
        caps = await pending;
      }
    }
    this.deps.post({ type: 'capabilities', commands: caps?.commands ?? [], ...(caps?.defaultModel ? { defaultModel: caps.defaultModel } : {}) });
  }

  /** Confere os anexos; se algum sumiu, avisa e devolve undefined (nada é enviado). */
  private async resolveAttachments(paths: string[] | undefined, chat?: Chat): Promise<AttachedFile[] | undefined> {
    if (!paths || paths.length === 0) return [];
    const home = this.deps.homedir?.() ?? os.homedir();
    if (paths.some((p) => !this.pickedPaths.has(p) || isSensitivePath(p, home))) {
      this.notice('error', 'Anexo não permitido: só arquivos escolhidos pelo seletor (e fora de pastas de credenciais) podem ser enviados.', chat);
      return undefined;
    }
    let files: AttachedFile[];
    try {
      files = await this.deps.checkAttachments(paths);
    } catch {
      files = [];
    }
    if (files.length !== paths.length) {
      this.notice('error', 'Algum anexo não existe mais ou não pôde ser lido. Anexe de novo e tente outra vez.', chat);
      return undefined;
    }
    return files;
  }

  private noticeOutside(files: AttachedFile[], cwd: string, chat?: Chat): void {
    const outside = outsideFiles(files, cwd).filter((f) => !this.pastedPaths.has(f.path));
    if (outside.length) {
      this.notice('info', `Fora do projeto: ${outside.map((f) => f.name).join(', ')}. O agente recebe acesso somente leitura a eles, só nesta mensagem.`, chat);
    }
  }

  private async send(nodeId: string, text: string, attachmentPaths?: string[]): Promise<void> {
    const chat = this.chatOfNode(nodeId);
    const node = chat?.store.nodes.get(nodeId);
    if (!chat || !node) {
      this.notice('error', 'Não encontrei esse node para enviar a mensagem.');
      this.deps.post({ type: 'answer_ack', nodeId, ok: false });
      return;
    }
    const files = await this.resolveAttachments(attachmentPaths, chat);
    if (!files) {
      this.deps.post({ type: 'answer_ack', nodeId, ok: false });
      return;
    }
    const names = files.map((f) => f.name);
    const echo = { nodeId, text, ...(names.length ? { attachments: names } : {}) };
    const message = withAttachments(text, files);
    if (node.parentId === null) return this.runTurn(chat, { prompt: message, fresh: false, echo, attachments: files, ack: nodeId });
    // Com o agentId dá para pedir a continuação exata; sem ele só dá para pedir ao orquestrador que tente.
    const prompt = node.agentId
      ? `Send a follow-up to the existing "${node.agentType}" subagent (agentId ${node.agentId}) using the SendMessage tool, ` +
        `with exactly this message. Do not start a new subagent. Then report what it replied.\n\nMessage:\n${message}`
      : `Continue the work of the "${node.agentType}" subagent you started earlier, passing it exactly this message ` +
        `(if you cannot continue it, start a new "${node.agentType}" subagent). Then report what it replied.\n\nMessage:\n${message}`;
    return this.runTurn(chat, { prompt, fresh: false, echo, attachments: files, ack: nodeId });
  }

  private spawnAgent(agentType: string, task: string, runId: string | null): Promise<void> {
    const prompt =
      `Use the Agent tool with subagent_type "${agentType}" to do the following task, ` +
      `then report back what it did:\n\n${task}`;
    if (runId) {
      const chat = this.chats.get(runId);
      if (!chat) {
        this.notice('error', 'Não encontrei essa conversa para criar o node.');
        return Promise.resolve();
      }
      if (chat.store.run.options?.cli === 'codex') {
        this.notice('error', 'O Codex não tem subagentes: não dá para criar um agente nesta conversa.', chat);
        return Promise.resolve();
      }
      return this.runTurn(chat, {
        prompt,
        fresh: false,
        echo: { nodeId: chat.store.rootId, text: `Novo node (${agentType}): ${task}` },
      });
    }
    return this.startChat(prompt, `${agentType} · ${titleFrom(task) || 'tarefa'}`, `Novo node (${agentType}): ${task}`);
  }

  // ---------- chats ----------

  /** `shown` é o que a conversa exibe como fala da pessoa (padrão: o próprio prompt). */
  private async startChat(prompt: string, title?: string, shown?: string, options?: ChatOptions, attachmentPaths?: string[]): Promise<void> {
    const token = { cancelled: false };
    this.pendingStarts.add(token);
    this.deps.post({ type: 'starting', count: ++this.startingCount });
    let chat: Chat | undefined;
    try {
      const optionsProblem = optionsError(options);
      if (optionsProblem) {
        this.notice('error', optionsProblem);
        return;
      }
      const cli: CliId = options?.cli ?? 'claude';
      const cwd = this.deps.cwd();
      if (!cwd) {
        this.notice('error', 'Abra uma pasta no VS Code antes de executar: o workspace é o diretório de trabalho do agente.');
        return;
      }
      const settings = this.deps.settings();

      const files = await this.resolveAttachments(attachmentPaths);
      if (!files) return;

      const check = await this.deps.detect(cli === 'codex' ? settings.codexPath : settings.claudePath, cli);
      this.lastChecks.set(cli, check);
      this.deps.post({ type: 'cli', check, cli });
      if (this.blockedByCli(check, cli)) return;

      if (token.cancelled) {
        this.notice('info', 'Execução cancelada.');
        return;
      }

      const runId = this.deps.newRunId?.() ?? randomUUID();
      const store = new RunStore({
        runId, source: 'panel', cwd, ...(options ? { options } : {}),
        title: title ?? (titleFrom(prompt.trim() ? prompt : files.map((f) => f.name).join(' ')) || `Chat ${++this.untitled}`),
      });
      store.apply({ type: 'run_started', runId, ts: Date.now() }); // aparece no canvas na hora; o init do CLI traz a sessão
      store.apply({ type: 'node_event', runId, nodeId: store.rootId, kind: 'message', payload: { role: 'user', text: shown ?? prompt, ...(files.length ? { attachments: files.map((f) => f.name) } : {}) }, ts: Date.now() });
      this.dirty.add(runId);
      chat = { store, busy: true, cancelRequested: false, pending: new Map(), turnOver: false };
      this.chats.set(runId, chat);
      this.warnIfManyInParallel(settings);
      this.postSnapshot();

      if (cli === 'claude') this.noticeOutside(files, cwd, chat);
      await this.runTurn(chat, { prompt: withAttachments(prompt, files), fresh: true, attachments: files });
    } catch (err) {
      if (chat) {
        chat.active = undefined;
        chat.busy = false;
        this.closeStore(chat);
      }
      this.notice('error', `Falha inesperada: ${err instanceof Error ? err.message : String(err)}`, chat);
    } finally {
      this.pendingStarts.delete(token);
      this.deps.post({ type: 'starting', count: --this.startingCount });
    }
  }

  private warnIfManyInParallel(settings: VisorSettings): void {
    const limit = settings.parallelWarningThreshold;
    if (limit <= 0) return;
    const running = [...this.chats.values()].filter((c) => c.store.run.status === 'running' || c.store.run.status === 'pending').length;
    if (running >= limit) {
      this.notice(
        'warn',
        `${running} conversas executando em paralelo: elas gastam o limite da assinatura mais rápido e podem editar os mesmos arquivos ao mesmo tempo.`,
      );
    }
  }

  /** Garante que um chat que não chegou a terminar (ex.: spawn lançou) não fique "executando" para sempre. */
  private closeStore(chat: Chat): void {
    const store = chat.store;
    if (store.run.status !== 'pending' && store.run.status !== 'running') return;
    store.apply({ type: 'run_started', runId: store.run.id, ts: Date.now() }); // no-op se já iniciou
    store.apply({ type: 'run_finished', runId: store.run.id, status: 'error', ts: Date.now() });
    this.dirty.add(store.run.id);
    this.flush();
  }

  private applyEcho(store: RunStore, t: Turn): void {
    if (!t.echo) return;
    store.apply({
      type: 'node_event', runId: store.run.id, nodeId: t.echo.nodeId, kind: 'message',
      payload: { role: 'user', text: t.echo.text, ...(t.echo.attachments?.length ? { attachments: t.echo.attachments } : {}) }, ts: Date.now(),
    });
  }

  /**
   * O turno acabou, mas o processo segue vivo (tarefas em segundo plano): a resposta vai pelo stdin dele, sem matar as tarefas.
   * Se o stdin já fechou, ou se a resposta precisa de opções/anexos que o processo não tem, encerra-o e retoma num processo novo.
   */
  private async answerLive(chat: Chat, t: Turn): Promise<void> {
    const store = chat.store;
    const active = chat.active!;
    const sameOptions = chat.activeOptions === JSON.stringify(store.run.options ?? {});
    const newRules = outsideFiles(t.attachments ?? [], store.run.cwd).length > 0;
    if (sameOptions && !newRules && !chat.authLost && active.sendUserMessage(t.prompt)) {
      this.applyEcho(store, t);
      store.apply({ type: 'run_resumed', runId: store.run.id, ts: Date.now() });
      chat.turnOver = false;
      this.clearStall(chat);
      this.armStall(chat);
      this.dirty.add(store.run.id);
      if (t.ack) this.deps.post({ type: 'answer_ack', nodeId: t.ack, ok: true });
      this.flush();
      return;
    }
    if (active.hasBackgroundTasks()) {
      this.notice('info', 'Havia tarefas em segundo plano neste chat: elas foram interrompidas para enviar a resposta num processo novo.', chat);
    }
    chat.replacing = true;
    active.cancel();
    await chat.turn;
    chat.replacing = false;
    return this.runTurn(chat, t);
  }

  /** Um turno do chat: o primeiro (fresh) ou uma continuação da mesma sessão (--resume). */
  private async runTurn(chat: Chat, t: Turn): Promise<void> {
    const store = chat.store;
    let acked = false;
    const ack = (ok: boolean) => {
      if (acked || !t.ack) return;
      acked = true;
      this.deps.post({ type: 'answer_ack', nodeId: t.ack, ok });
    };
    if (!t.fresh) {
      if (chat.busy) {
        if (chat.turnOver && chat.active) return this.answerLive(chat, t);
        this.notice('warn', 'Esta conversa ainda está executando. Cancele-a ou espere terminar.', chat);
        ack(false);
        return;
      }
      chat.busy = true;
      chat.cancelRequested = false;
      this.postSnapshot(); // a Webview passa a saber que este chat está ocupado
    }
    let release!: () => void;
    chat.turn = new Promise<void>((r) => (release = r));
    try {
      const settings = this.deps.settings();
      const options = store.run.options;
      const cli: CliId = options?.cli ?? 'claude';
      const effectiveMode = options?.permissionMode ?? settings.permissionMode;
      let resume: ResumeSeed | undefined;
      let sessionId: string | undefined;

      if (!t.fresh) {
        sessionId = store.run.sessionId;
        if (!sessionId) {
          this.notice('error', 'Não há uma sessão para continuar nesta conversa. Inicie uma execução primeiro.', chat);
          ack(false);
          return;
        }
        // Em turnos retomados reaproveita o diagnóstico do CLI, para não pagar duas chamadas a cada mensagem.
        const known = this.lastChecks.get(cli);
        if (!(known && (known.state === 'ok' || known.state === 'unknown'))) {
          const check = await this.deps.detect(cli === 'codex' ? settings.codexPath : settings.claudePath, cli);
          this.lastChecks.set(cli, check);
          this.deps.post({ type: 'cli', check, cli });
          if (this.blockedByCli(check, cli, chat)) {
            ack(false);
            return;
          }
        }
        if (chat.cancelRequested) {
          this.notice('info', 'Execução cancelada.', chat);
          ack(false);
          return;
        }
        const nodes = cli === 'codex' ? [] : [...store.nodes.values()].filter((n) => n.invocationId);
        resume = {
          subagents: nodes.map((n) => n.invocationId!),
          tasks: Object.fromEntries(nodes.filter((n) => n.agentId).map((n) => [n.agentId!, n.invocationId!])),
        };
        this.applyEcho(store, t);
        if (cli === 'claude') this.noticeOutside(t.attachments ?? [], store.run.cwd, chat);
        // O loading aparece na hora, antes de o processo emitir o primeiro evento.
        store.apply({ type: 'run_resumed', runId: store.run.id, ts: Date.now() });
        this.dirty.add(store.run.id);
        this.warnIfManyInParallel(settings);
      }

      let command: string;
      let args: string[];
      let input: string | undefined;
      if (cli === 'codex') {
        command = settings.codexPath;
        // O Codex não tem --append-system-prompt: a instrução de pergunta vai no começo da primeira mensagem
        // (a sessão guarda o contexto, então não se repete nas retomadas).
        args = buildCodexArgs({
          prompt: t.fresh ? `${QUESTION_INSTRUCTION}\n\n${t.prompt}` : t.prompt,
          sandbox: options?.sandbox ?? settings.codexSandbox,
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.effort ? { effort: options.effort } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
        });
      } else {
        command = settings.claudePath;
        input = userMessageLine(t.prompt);
        args = buildClaudeArgs({
          permissionMode: effectiveMode,
          // Só LEITURA dos anexos de fora do projeto, e só nesta mensagem (nunca a pasta pai, nunca escrita).
          allowedTools: [...settings.allowedTools, ...outsideFiles(t.attachments ?? [], store.run.cwd).map(readRule)],
          disallowedTools: settings.disallowedTools,
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.effort ? { effort: options.effort } : {}),
          resume: sessionId,
          appendSystemPrompt: QUESTION_INSTRUCTION,
        });
      }
      chat.turnOver = false;
      chat.authLost = false;
      chat.activeOptions = JSON.stringify(options ?? {});
      const run: ProcessRun = this.deps.startRun(
        store.run.id,
        {
          command, args, cwd: store.run.cwd,
          ...(cli === 'codex' ? { adapter: 'codex' as const } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(resume ? { resume } : {}),
        },
        (e) => {
          if (e.type === 'usage') {
            this.deps.post({ type: 'usage', ...(e.fiveHour !== undefined ? { fiveHour: e.fiveHour } : {}), ...(e.sevenDay !== undefined ? { sevenDay: e.sevenDay } : {}), ...(e.fiveHourResetsAt !== undefined ? { fiveHourResetsAt: e.fiveHourResetsAt } : {}), ...(e.sevenDayResetsAt !== undefined ? { sevenDayResetsAt: e.sevenDayResetsAt } : {}) });
            return;
          }
          if (e.type === 'auth_lost') {
            this.onAuthLost(chat);
            return;
          }
          if (e.type === 'run_finished' && chat.active === run) {
            this.log.info('result', { runId: store.run.id.slice(0, 8), pid: run.pid, status: e.status, bg: run.hasBackgroundTasks(), question: !!e.question });
          }
          if (e.type === 'permission_request') chat.pending.set(e.requestId, e);
          // Só o processo atual decide se o turno acabou (um processo antigo, sendo trocado, não conta).
          if (chat.active === run) {
            if (e.type === 'run_finished') chat.turnOver = true;
            if (e.type === 'run_resumed') chat.turnOver = false;
            this.clearStall(chat);
            this.armStall(chat);
          }
          store.apply(e);
          this.dirty.add(store.run.id);
          this.schedule();
        },
      );
      chat.active = run;
      ack(true);
      this.postSnapshot();

      const result = await run.done;
      chat.active = undefined;
      chat.turnOver = false;
      this.clearStall(chat);
      this.dropPendingPermissions(chat);
      // Nenhum run_finished chegou a ser aplicado (ex.: o processo morreu entre uma resposta pelo stdin e o
      // próximo "system init"): sem isto o chat ficaria preso em "running" para sempre, sem jeito de recuperar.
      if (store.run.status === 'running' || store.run.status === 'pending') {
        store.apply({ type: 'run_finished', runId: store.run.id, status: result.cancelled ? 'cancelled' : 'error', ts: Date.now() });
      }
      this.flush();

      if (result.cancelled) {
        if (!chat.replacing) this.notice('info', 'Execução cancelada.', chat);
      } else if (result.spawnError) {
        this.notice('error', `Não consegui executar o CLI: ${result.spawnError}`, chat);
      } else if (store.run.status === 'error') {
        // O Codex informa o motivo num evento de erro; o stderr dele só tem ruído. Sem evento, vale o stderr.
        const reason = lastErrorEvent(store) ?? result.stderrTail.trim().slice(-500);
        this.notice('error', `A execução terminou com erro (código ${result.exitCode}).${reason ? ` ${reason}` : ''}`, chat);
      }
      // Turno com erro: o próximo reconfere o CLI (o login pode ter caído no meio).
      if (store.run.status === 'error') this.lastChecks.delete(cli);
    } catch (err) {
      ack(false);
      chat.active = undefined;
      chat.turnOver = false;
      this.clearStall(chat);
      this.dropPendingPermissions(chat);
      this.closeStore(chat);
      this.notice('error', `Falha inesperada: ${err instanceof Error ? err.message : String(err)}`, chat);
    } finally {
      chat.busy = false;
      chat.cancelRequested = false;
      this.dirty.add(store.run.id);
      if (this.chats.get(store.run.id) === chat) this.flush();
      release();
    }
  }
}
