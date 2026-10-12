import { describe, it, expect } from 'vitest';
import { detectClaude, detectCodex, execText, type ExecFn } from '../../src/cli/detect';

type R = { code: number | null; stdout: string; stderr: string; spawnError?: string };
const fake = (version: R, auth: R): ExecFn => async (_c, args) => (args[0] === '--version' ? version : auth);
const ok = (stdout: string, code = 0): R => ({ code, stdout, stderr: '' });

describe('detectClaude', () => {
  it('CLI ausente (spawnError) vira not_installed com instrução', async () => {
    const r = await detectClaude(fake({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }, ok('')));
    expect(r.state).toBe('not_installed');
    expect((r as any).message).toMatch(/Instale/);
    expect((r as any).message).toMatch(/visor\.claudePath/);
  });

  it('logado vira ok com versão e método, sem vazar o e-mail', async () => {
    const out = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.com', configDirectory: '/x' });
    const r = await detectClaude(fake(ok('2.1.267 (Claude Code)\n'), ok(out)));
    expect(r).toEqual({ state: 'ok', version: '2.1.267', authMethod: 'claude.ai' });
    expect(JSON.stringify(r)).not.toContain('a@b.com');
  });

  it('não logado vira not_authenticated (mesmo com exit code diferente de zero)', async () => {
    const r = await detectClaude(fake(ok('2.1.267 (Claude Code)'), ok('{"loggedIn":false}', 1)));
    expect(r.state).toBe('not_authenticated');
    expect((r as any).message).toMatch(/faça login/);
  });

  it('saída sem JSON (CLI sem auth status) vira unknown', async () => {
    const r = await detectClaude(fake(ok('1.0.0'), ok('error: unknown command', 1)));
    expect(r).toMatchObject({ state: 'unknown', version: '1.0.0' });
  });

  it('JSON sem loggedIn booleano vira unknown', async () => {
    const r = await detectClaude(fake(ok('1.0.0'), ok('{"loggedIn":"yes"}')));
    expect(r.state).toBe('unknown');
  });

  it('authMethod ausente vira "desconhecido"', async () => {
    const r = await detectClaude(fake(ok('1.0.0'), ok('{"loggedIn":true}')));
    expect(r).toMatchObject({ state: 'ok', authMethod: 'desconhecido' });
  });
});

describe('execText (processo real)', () => {
  it('comando inexistente retorna spawnError', async () => {
    const r = await execText('visor-cli-que-nao-existe', ['--version']);
    expect(r.spawnError).toBeTruthy();
  });

  it('captura stdout e exit code de um processo real', async () => {
    const r = await execText(process.execPath, ['-e', 'console.log("oi"); process.exit(3)']);
    expect(r).toMatchObject({ code: 3, stdout: 'oi\n' });
  });

  it('detectClaude contra um binário que não é o claude resulta em unknown, não em exceção', async () => {
    const r = await detectClaude(execText, process.execPath);
    expect(r.state).toBe('unknown');
    expect((r as any).version).toMatch(/^v\d+/);
  });
});

describe('detectCodex', () => {
  const codex = (version: R, login: R): ExecFn => async (_c, args) => (args[0] === '--version' ? version : login);

  it('instalado e logado: ok com versão e método (só "Logged in using X" é lido)', async () => {
    const r = await detectCodex(codex(ok('codex-cli 0.157.1\n'), ok('Logged in using ChatGPT\n')));
    expect(r).toEqual({ state: 'ok', version: '0.157.1', authMethod: 'ChatGPT' });
  });
  it('ausente vira not_installed e cita visor.codexPath', async () => {
    const r = await detectCodex(codex({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }, ok('')));
    expect(r.state).toBe('not_installed');
    expect((r as any).message).toMatch(/visor\.codexPath/);
  });
  it('não logado (saída diferente ou código de erro) vira not_authenticated com a instrução de login', async () => {
    const r = await detectCodex(codex(ok('codex-cli 0.157.1'), { code: 1, stdout: 'Not logged in\n', stderr: '' }));
    expect(r.state).toBe('not_authenticated');
    expect((r as any).message).toMatch(/codex login/);
  });
  it('saída de login irreconhecível com código 0 vira unknown (tenta executar mesmo assim)', async () => {
    const r = await detectCodex(codex(ok('codex-cli 0.157.1'), ok('algo inesperado')));
    expect(r).toMatchObject({ state: 'unknown', version: '0.157.1' });
  });
  it('contra um binário que não é o codex resulta em unknown/not_authenticated, nunca em exceção', async () => {
    await expect(detectCodex(execText, process.execPath)).resolves.toBeTruthy();
  });
});
