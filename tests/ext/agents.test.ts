import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgentFile, listProjectAgents, mergeAgents, BUILTIN_AGENTS } from '../../src/ext/agents';

describe('parseAgentFile', () => {
  it('lê name e description do frontmatter', () => {
    expect(parseAgentFile('---\nname: echo\ndescription: Repeats the text.\ntools: Read\n---\nCorpo')).toEqual({ name: 'echo', description: 'Repeats the text.' });
  });
  it('aceita aspas e CRLF', () => {
    expect(parseAgentFile('---\r\nname: "rev"\r\ndescription: \'Revisa\'\r\n---\r\n')).toEqual({ name: 'rev', description: 'Revisa' });
  });
  it('sem frontmatter, sem name ou nome inválido devolve null', () => {
    expect(parseAgentFile('só texto')).toBeNull();
    expect(parseAgentFile('---\ndescription: x\n---')).toBeNull();
    expect(parseAgentFile('---\nname: com espaço\n---')).toBeNull();
  });
  it('description ausente vira string vazia e muito longa é truncada', () => {
    expect(parseAgentFile('---\nname: a\n---')).toEqual({ name: 'a', description: '' });
    expect(parseAgentFile(`---\nname: a\ndescription: ${'x'.repeat(900)}\n---`)!.description.length).toBeLessThanOrEqual(301);
  });
});

describe('listProjectAgents / mergeAgents', () => {
  it('lista .claude/agents/*.md do projeto, ignora o resto e tolera pasta ausente', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'visor-ag-'));
    expect(await listProjectAgents(cwd)).toEqual([]);
    mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
    writeFileSync(path.join(cwd, '.claude/agents/echo.md'), '---\nname: echo\ndescription: Eco\n---\n');
    writeFileSync(path.join(cwd, '.claude/agents/ruim.md'), 'sem frontmatter');
    writeFileSync(path.join(cwd, '.claude/agents/notas.txt'), '---\nname: x\n---');
    expect(await listProjectAgents(cwd)).toEqual([{ name: 'echo', description: 'Eco' }]);
  });

  it('projeto vem primeiro, os nativos não duplicam nomes e a ordem é estável', () => {
    const out = mergeAgents([{ name: 'Plan', description: 'meu plan' }, { name: 'echo', description: 'e' }]);
    expect(out.filter((a) => a.name === 'Plan')).toEqual([{ name: 'Plan', description: 'meu plan' }]);
    expect(out.map((a) => a.name).slice(0, 2)).toEqual(['echo', 'Plan']);
    expect(BUILTIN_AGENTS.map((a) => a.name)).toEqual(expect.arrayContaining(['general-purpose', 'Explore', 'Plan']));
  });
});
