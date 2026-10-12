import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITIES_ARGS, parseInit, readCapabilities } from '../../src/cli/capabilities';

const init = {
  type: 'system', subtype: 'init', model: 'claude-sonnet-5-5',
  slash_commands: ['ping', 'superpowers:brainstorming', 'review', 'superpowers:executing-plans'],
  skills: ['superpowers:brainstorming', 'superpowers:executing-plans'],
};

describe('parseInit', () => {
  it('separa skills de comandos, agrupa por plugin e ordena', () => {
    const out = parseInit(init);
    expect(out.defaultModel).toBe('claude-sonnet-5-5');
    expect(out.commands).toEqual([
      { name: 'ping', kind: 'command', group: 'comando' },
      { name: 'review', kind: 'command', group: 'comando' },
      { name: 'superpowers:brainstorming', kind: 'skill', group: 'superpowers' },
      { name: 'superpowers:executing-plans', kind: 'skill', group: 'superpowers' },
    ]);
  });
  it('skill sem prefixo de plugin vai no grupo "skill"; duplicatas e itens inválidos somem', () => {
    const out = parseInit({ slash_commands: ['x', 'x', 5, '', 'a b'], skills: ['x'] });
    expect(out.commands).toEqual([{ name: 'x', kind: 'skill', group: 'skill' }]);
  });
  it('init sem listas ou de forma estranha não lança', () => {
    expect(parseInit({})).toEqual({ commands: [], defaultModel: undefined });
    expect(() => parseInit(null as any)).not.toThrow();
    expect(parseInit({ model: 5 }).defaultModel).toBeUndefined();
  });
});

describe('readCapabilities (processo real = CLI falso)', () => {
  const fake = path.resolve('fixtures/fake-claude.mjs');
  const file = (lines: unknown[]) => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'visor-cap-')), 'init.ndjson');
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return f;
  };

  it('lê o init e encerra o processo sem esperar o fim (o fake fica "pendurado")', async () => {
    const f = file([{ type: 'system', subtype: 'hook_started' }, init]);
    const t0 = Date.now();
    const out = await readCapabilities({ command: process.execPath, args: [fake, f, '--hang'], cwd: process.cwd(), timeoutMs: 8000 });
    expect(out.commands.map((c) => c.name)).toContain('ping');
    expect(out.defaultModel).toBe('claude-sonnet-5-5');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('CLI ausente ou sem init dentro do prazo devolve vazio', async () => {
    expect(await readCapabilities({ command: 'visor-nao-existe', args: [], cwd: process.cwd(), timeoutMs: 2000 })).toEqual({ commands: [], defaultModel: undefined });
    const f = file([{ type: 'assistant' }]);
    const t0 = Date.now();
    const out = await readCapabilities({ command: process.execPath, args: [fake, f, '--hang'], cwd: process.cwd(), timeoutMs: 600 });
    expect(out.commands).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('linhas malformadas antes do init são ignoradas', async () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'visor-cap-')), 'bad.ndjson');
    writeFileSync(f, 'lixo\n{"type":"x\n' + JSON.stringify(init) + '\n');
    const out = await readCapabilities({ command: process.execPath, args: [fake, f, '--hang'], cwd: process.cwd(), timeoutMs: 8000 });
    expect(out.commands.length).toBeGreaterThan(0);
  });
});

describe('CAPABILITIES_ARGS (leitura do init com o menor efeito colateral possível)', () => {
  it('não grava sessão, desliga os hooks do projeto/plugins e termina no prompt depois de "--"', () => {
    expect(CAPABILITIES_ARGS).toContain('--no-session-persistence');
    const i = CAPABILITIES_ARGS.indexOf('--settings');
    expect(JSON.parse(CAPABILITIES_ARGS[i + 1]!)).toEqual({ disableAllHooks: true });
    expect(CAPABILITIES_ARGS.slice(-2)).toEqual(['--', 'hi']);
    expect(CAPABILITIES_ARGS).not.toContain('--model'); // senão o "modelo padrão" lido do init seria o forçado
  });
});
