import * as vscode from 'vscode';
import { CAPABILITIES_ARGS, readCapabilities } from '../cli/capabilities';
import { detectClis } from '../cli/clis';
import { detectClaude, detectCodex, execText } from '../cli/detect';
import { findCli, installCommand, loginCommand } from '../cli/locate';
import type { CliId } from '../core/options';
import { startProcessRun } from '../cli/process-run';
import { describeRejected, parseWebviewMessage, type HostMessage } from '../protocol';
import { buildWebviewHtml, makeNonce } from './html';
import { listProjectAgents } from './agents';
import { checkAttachments } from './files';
import { RunController } from './run-controller';
import { DEFAULT_SETTINGS, parseSettings, type VisorSettings } from './settings';

const AUTH_DISMISSED_KEY = 'visor.authBannerDismissed';

const PATH_KEY: Record<CliId, 'claudePath' | 'codexPath'> = { claude: 'claudePath', codex: 'codexPath' };
const RETRY_MS = 30_000;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Visor');
  let panel: vscode.WebviewPanel | undefined;

  // Com o caminho no padrão, o VS Code pode não enxergar o CLI que o terminal enxerga (PATH diferente):
  // procuramos nos lugares usuais e lembramos o achado nesta sessão (não mexe na configuração).
  const found: Partial<Record<CliId, string>> = {};
  const lastTry: Partial<Record<CliId, number>> = {};
  const readSettings = (): VisorSettings => {
    const cfg = parseSettings((key) => vscode.workspace.getConfiguration('visor').get(key));
    return {
      ...cfg,
      claudePath: cfg.claudePath === DEFAULT_SETTINGS.claudePath ? (found.claude ?? cfg.claudePath) : cfg.claudePath,
      codexPath: cfg.codexPath === DEFAULT_SETTINGS.codexPath ? (found.codex ?? cfg.codexPath) : cfg.codexPath,
    };
  };
  const ensureCli = async (cli: CliId, force: boolean): Promise<void> => {
    const cfg = parseSettings((key) => vscode.workspace.getConfiguration('visor').get(key));
    if (cfg[PATH_KEY[cli]] !== DEFAULT_SETTINGS[PATH_KEY[cli]] || found[cli]) return;
    if (!force && Date.now() - (lastTry[cli] ?? 0) < RETRY_MS) return;
    lastTry[cli] = Date.now();
    if (!(await execText(DEFAULT_SETTINGS[PATH_KEY[cli]], ['--version'])).spawnError) return;
    const where = await findCli(cli, execText);
    if (where) found[cli] = where;
  };
  const openTerminal = (name: string, text: string) => {
    const t = vscode.window.createTerminal({ name, ...(process.platform === 'win32' ? { shellPath: 'powershell.exe' } : {}) });
    t.show();
    t.sendText(text, true);
  };

  const controller = new RunController({
    post: (msg: HostMessage) => {
      void panel?.webview.postMessage(msg);
    },
    cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    settings: readSettings,
    detect: async (command, cli = 'claude') => {
      await ensureCli(cli, true);
      const cmd = command === DEFAULT_SETTINGS[PATH_KEY[cli]] ? (found[cli] ?? command) : command;
      return cli === 'codex' ? detectCodex(execText, cmd) : detectClaude(execText, cmd);
    },
    setup: {
      install: (cli) => openTerminal(`Visor: instalar ${cli === 'codex' ? 'Codex' : 'Claude Code'}`, installCommand(cli, process.platform)),
      login: (cli, command) => openTerminal(`Visor: login ${cli === 'codex' ? 'Codex' : 'Claude Code'}`, loginCommand(cli, command, process.platform)),
      pickPath: async (cli) => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Usar este executável',
          title: cli === 'codex' ? 'Escolha o executável do Codex' : 'Escolha o executável do Claude Code',
        });
        return picked?.[0]?.fsPath;
      },
      savePath: (cli, p) => {
        delete found[cli];
        void vscode.workspace.getConfiguration('visor').update(PATH_KEY[cli], p, vscode.ConfigurationTarget.Global);
      },
    },
    confirmBypass: async () => {
      const yes = 'Executar sem restrições';
      const pick = await vscode.window.showWarningMessage(
        'Este chat vai rodar sem restrições (bypassPermissions no Claude Code, danger-full-access no Codex): o agente pode executar qualquer comando e alterar qualquer arquivo sem pedir aprovação. Continuar?',
        { modal: true },
        yes,
      );
      return pick === yes;
    },
    listAgents: listProjectAgents,
    listClis: async () => {
      await Promise.all([ensureCli('claude', false), ensureCli('codex', false)]);
      const cfg = readSettings();
      return detectClis(execText, { claude: cfg.claudePath, codex: cfg.codexPath });
    },
    capabilities: async (cwd) => {
      await ensureCli('claude', false);
      const cfg = readSettings();
      // Só até o `init` (skills, comandos, modelo padrão): o processo é encerrado assim que o emite; sem sessão gravada e sem hooks.
      return readCapabilities({ command: cfg.claudePath, args: CAPABILITIES_ARGS, cwd });
    },
    pickFiles: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        openLabel: 'Anexar',
      });
      return (picked ?? []).map((u) => u.fsPath);
    },
    checkAttachments,
    prefs: {
      authBannerDismissed: () => context.globalState.get<boolean>(AUTH_DISMISSED_KEY, false),
      dismissAuthBanner: () => {
        void context.globalState.update(AUTH_DISMISSED_KEY, true);
      },
    },
    startRun: startProcessRun,
  });

  const openCanvas = () => {
    if (panel) {
      panel.reveal();
      return;
    }
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    panel = vscode.window.createWebviewPanel('visor.canvas', 'Visor — Agentes', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    const web = panel.webview;
    web.html = buildWebviewHtml({
      cspSource: web.cspSource,
      nonce: makeNonce(),
      scriptUri: web.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: web.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')).toString(),
    });
    web.onDidReceiveMessage((raw: unknown) => {
      const msg = parseWebviewMessage(raw);
      if (msg) {
        controller.handle(msg).catch((err) => log.appendLine(String(err)));
        return;
      }
      // A Webview já limpou o campo: sem este aviso a pessoa perderia a mensagem sem saber.
      const why = describeRejected(raw);
      if (why) void web.postMessage({ type: 'notice', level: 'error', text: why } satisfies HostMessage);
    });
    panel.onDidDispose(() => {
      panel = undefined; // as conversas continuam; reabrir o canvas reenvia o snapshot de todas
    });
  };

  // Ícone na barra lateral: ao abrir a vista, o canvas abre no editor; o botão reabre se a aba foi fechada.
  const sidebar: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      const nonce = makeNonce();
      view.webview.options = { enableScripts: true };
      view.webview.html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>body{padding:12px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)}p{opacity:.8;line-height:1.4}
button{width:100%;padding:6px 10px;border:0;border-radius:2px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head>
<body><p>As conversas e os agentes aparecem no canvas, aberto no editor.</p><button id="open">Abrir canvas</button>
<script nonce="${nonce}">const api=acquireVsCodeApi();document.getElementById('open').addEventListener('click',()=>api.postMessage('open'));</script></body></html>`;
      view.webview.onDidReceiveMessage((m: unknown) => {
        if (m === 'open') openCanvas();
      });
      if (view.visible) openCanvas();
      view.onDidChangeVisibility(() => {
        if (view.visible) openCanvas();
      });
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('visor.sidebar', sidebar),
    vscode.commands.registerCommand('visor.openCanvas', openCanvas),
    vscode.commands.registerCommand('visor.cancelRun', () => controller.cancelAll()),
    log,
    { dispose: () => controller.dispose() },
  );
}

export function deactivate(): void {}
