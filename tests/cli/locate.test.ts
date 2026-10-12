import { describe, it, expect } from 'vitest';
import { candidatePaths, findCli, installCommand, loginCommand, shellQuote } from '../../src/cli/locate';
import type { ExecFn } from '../../src/cli/detect';

const miss = { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' };
const hit = (stdout = '2.1.0') => ({ code: 0, stdout, stderr: '' });

describe('candidatePaths', () => {
  it('macOS/Linux: pastas usuais do instalador nativo, npm global, Homebrew e nvm', () => {
    const p = candidatePaths('claude', { platform: 'darwin', home: '/Users/u', env: {}, listDir: (d) => (d === '/Users/u/.nvm/versions/node' ? ['v20.1.0'] : []) });
    expect(p).toContain('/Users/u/.local/bin/claude');
    expect(p).toContain('/Users/u/.claude/local/claude');
    expect(p).toContain('/opt/homebrew/bin/claude');
    expect(p).toContain('/usr/local/bin/claude');
    expect(p).toContain('/Users/u/.nvm/versions/node/v20.1.0/bin/claude');
  });

  it('Windows: só .exe (execFile não executa .cmd) e usa USERPROFILE', () => {
    const p = candidatePaths('codex', { platform: 'win32', home: 'C:\\Users\\u', env: { USERPROFILE: 'C:\\Users\\u' }, listDir: () => [] });
    expect(p.every((x) => x.endsWith('codex.exe'))).toBe(true);
    expect(p.length).toBeGreaterThan(0);
  });
});

describe('findCli', () => {
  const opts = { platform: 'linux' as const, home: '/home/u', env: { SHELL: '/bin/zsh' }, listDir: () => [] };

  it('usa o shell de login para descobrir o caminho', async () => {
    const exec: ExecFn = async (c, args) => {
      if (c === '/bin/zsh') return hit('algum ruído\n/home/u/.nvm/bin/claude\n');
      return c === '/home/u/.nvm/bin/claude' && args[0] === '--version' ? hit() : miss;
    };
    expect(await findCli('claude', exec, opts)).toBe('/home/u/.nvm/bin/claude');
  });

  it('cai nos caminhos conhecidos quando o shell não ajuda', async () => {
    const exec: ExecFn = async (c) => (c === '/home/u/.local/bin/claude' ? hit() : miss);
    expect(await findCli('claude', exec, opts)).toBe('/home/u/.local/bin/claude');
  });

  it('ignora saída do shell que não é caminho absoluto', async () => {
    const exec: ExecFn = async (c) => (c === '/bin/zsh' ? hit('claude: not found') : miss);
    expect(await findCli('claude', exec, opts)).toBeUndefined();
  });

  it('devolve undefined se nada responde', async () => {
    expect(await findCli('codex', async () => miss, opts)).toBeUndefined();
  });
});

describe('comandos do terminal', () => {
  it('instalação por plataforma', () => {
    expect(installCommand('claude', 'darwin')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installCommand('claude', 'linux')).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installCommand('claude', 'win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(installCommand('codex', 'darwin')).toBe('npm i -g @openai/codex');
  });

  it('login usa o caminho configurado, entre aspas se tiver espaço', () => {
    expect(loginCommand('claude', 'claude', 'linux')).toBe('claude');
    expect(loginCommand('codex', 'codex', 'linux')).toBe('codex login');
    expect(loginCommand('claude', '/Users/a b/claude', 'darwin')).toBe("'/Users/a b/claude'");
    expect(loginCommand('codex', 'C:\\Users\\a b\\codex.exe', 'win32')).toBe('& "C:\\Users\\a b\\codex.exe" login');
  });

  it('shellQuote escapa aspas simples', () => {
    expect(shellQuote("a'b c")).toBe("'a'\\''b c'");
  });
});
