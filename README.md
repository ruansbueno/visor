# Visor - for AI devs

[![Latest release](https://img.shields.io/github/v/release/ruansbueno/visor)](https://github.com/ruansbueno/visor/releases/latest)

See your coding agents' work as a **canvas**: each conversation is a card, each subagent a node linked to it, with live status (running, waiting for your answer, done, error).

Visor is a **visual wrapper around the CLIs you already have installed**. It is not its own client, has no login screen, and never reads or stores credentials.

## Features

- **Parallel chats** on the same canvas, with a message box on every card, agent questions answered in place, and conversation resume.
- **Claude Code and Codex**: pick the CLI, model, effort and permissions (sandbox, on Codex) before you start and on every message. The Codex model list comes from the CLI itself.
- **Claude Code subagents** show up as nodes; you can spawn a new one under a chat.
- **Attachments and `/`**: attach files and use the skills and commands Claude Code reports.
- Click a node to see its tool calls and messages, like in the Claude Code tab.
- Activity bar icon: opening it shows the canvas in the editor.

## Install

Visor is on the VS Code Marketplace:

1. In VS Code, open the Extensions view (`Cmd/Ctrl+Shift+X`), search for **Visor - for AI devs** and click **Install**.
   Or from a terminal: `code --install-extension ruansbueno.visor-for-ai-devs`
2. Click the Visor icon (a circle of dots) in the activity bar, or run **Visor: Open agents canvas** from the Command Palette.

Prefer a manual install? Download the `visor-for-ai-devs-*.vsix` from the [latest release](https://github.com/ruansbueno/visor/releases/latest) and use **Install from VSIX…** in the Extensions view `…` menu.

Make sure at least one CLI below is installed **and that you have logged in to it yourself** (run `claude` or `codex` once in a terminal).

### Build from source

```bash
git clone https://github.com/ruansbueno/visor.git
cd visor
npm install
npm run build
npx @vscode/vsce package --no-dependencies   # produces the .vsix
```

## Requirements

- VS Code 1.90 or later.
- At least one CLI, installed and logged in by you:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`)
  - [Codex](https://github.com/openai/codex) (`codex`)
- Tested with Claude Code 2.1.287 and Codex 0.157.1. Other versions may work but were not verified.
- Tested on macOS only. Windows and Linux are not verified yet.

## Compliance statement

- Uses **your own account and your own installation** of the CLIs; you install them and log in from the terminal.
- Never reads tokens, credentials, the Keychain, or the history files the CLIs keep on your machine.
- Offers no login, does no proxying and resells no access: it just runs the CLI command and shows its output.
- Attachments only come from the file picker, and sensitive folders (such as `~/.ssh`, `~/.aws`, `~/.claude`) are blocked.
- Unrestricted modes (`bypassPermissions` on Claude, `danger-full-access` on Codex) run immediately, with no confirmation dialog.
- Works only in trusted workspaces.

Visor is an independent project and is **not affiliated with or endorsed by Anthropic or OpenAI**. You are responsible for following each CLI's terms of use.

## Settings

| Key | Purpose |
| --- | --- |
| `visor.claudePath` / `visor.codexPath` | Executable paths, if they are not on your PATH. |
| `visor.permissionMode` / `visor.allowedTools` | Default Claude Code permissions (headless mode, no interactive approval). |
| `visor.codexSandbox` | Default Codex sandbox (`read-only`, `workspace-write`, `danger-full-access`). |
| `visor.parallelWarningThreshold` | Number of simultaneous chats from which a warning is shown. |

## Commands

- **Visor: Abrir canvas de agentes** (open the canvas)
- **Visor: Cancelar todas as execuções** (cancel all runs)

The UI is currently in Portuguese.

## Development

```bash
npm install
npm test          # vitest
npm run build     # dist/extension.cjs and dist/webview.*
```

Open the folder in VS Code and press F5 (or `code --extensionDevelopmentPath=. <folder>`). The specification (in Portuguese) is in `spec-harness-multiagentes-v0.4.md`.

## License

[MIT](LICENSE)
