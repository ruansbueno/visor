import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { StreamAdapter } from '../src/cli/stream-adapter';
import { RunStore } from '../src/core/store';

const dir = path.resolve('fixtures/stream');
const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));

describe('replay de fixtures reais de stream', () => {
  it('há fixtures gravadas', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f}: gera ao menos um subagente, todos fechados, run em done`, () => {
      const a = new StreamAdapter('r1');
      const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
      for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        for (const e of a.push(line)) s.apply(e);
      }
      const subs = [...s.nodes.values()].filter((n) => n.parentId !== null);
      expect(subs.length).toBeGreaterThan(0);
      expect(subs.every((n) => n.status === 'done')).toBe(true);
      expect(s.run.status).toBe('done');
      expect(a.malformedLines).toBe(0);
      expect(s.run.sessionId).toBeTruthy();
    });
  }
});

import { HookAdapter } from '../src/cli/hook-adapter';

const hookDir = path.resolve('fixtures/hooks');
const hookFiles = readdirSync(hookDir).filter((f) => f.endsWith('.ndjson'));

describe('replay de fixtures reais de hooks', () => {
  it('há fixtures gravadas', () => {
    expect(hookFiles.length).toBeGreaterThan(0);
  });

  for (const f of hookFiles) {
    it(`${f}: gera ao menos um subagente, todos fecham, run em done`, () => {
      const a = new HookAdapter('r1');
      const s = new RunStore({ runId: 'r1', source: 'terminal', cwd: '/p' });
      for (const line of readFileSync(path.join(hookDir, f), 'utf8').split('\n').filter(Boolean)) {
        for (const e of a.push(JSON.parse(line))) s.apply(e);
      }
      const subs = [...s.nodes.values()].filter((n) => n.parentId !== null);
      expect(subs.length).toBeGreaterThan(0);
      expect(subs.every((n) => n.status === 'done')).toBe(true);
      expect(s.run.status).toBe('done');
    });
  }
});

describe('atribuição de tool calls feitas dentro de subagente (fixtures reader)', () => {
  const callsOf = (s: RunStore) =>
    s.eventsOf([...s.nodes.keys()].find((k) => k !== 'r1:root')!).filter((e) => e.kind === 'tool_call');

  it('stream: o Read do subagente vai para o filho, não para a raiz', () => {
    const a = new StreamAdapter('r1');
    const s = new RunStore({ runId: 'r1', source: 'panel', cwd: '/p' });
    for (const line of readFileSync(path.join(dir, 'reader.ndjson'), 'utf8').split('\n')) {
      for (const e of a.push(line)) s.apply(e);
    }
    expect(callsOf(s).map((e) => (e.payload as any).name)).toEqual(['Read']);
    expect(s.eventsOf('r1:root').some((e) => (e.payload as any)?.name === 'Read')).toBe(false);
  });

  it('hooks: o Read do subagente vai para o filho, não para a raiz', () => {
    const a = new HookAdapter('r1');
    const s = new RunStore({ runId: 'r1', source: 'terminal', cwd: '/p' });
    for (const line of readFileSync(path.join(hookDir, 'reader.ndjson'), 'utf8').split('\n').filter(Boolean)) {
      for (const e of a.push(JSON.parse(line))) s.apply(e);
    }
    expect(callsOf(s).map((e) => (e.payload as any).name)).toEqual(['Read']);
    expect(s.eventsOf('r1:root').some((e) => (e.payload as any)?.name === 'Read')).toBe(false);
  });
});
