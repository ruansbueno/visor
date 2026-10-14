import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessRegistry, signatureOf, type RegistryOs } from '../../src/ext/process-registry';

const SIG = '-p --output-format stream-json';

function fakeOs(procs: Record<number, string>, alive: number[] = []) {
  const killed: [number, string][] = [];
  const later: (() => void)[] = [];
  const o: RegistryOs = {
    commandOf: (pid) => procs[pid],
    isAlive: (pid) => alive.includes(pid) || pid in procs,
    killGroup: (pid, signal) => { killed.push([pid, signal]); },
    later: (fn) => { later.push(fn); },
  };
  return { o, killed, runLater: () => later.splice(0).forEach((f) => f()) };
}
const file = () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'visor-reg-')), 'sub');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'processes.json');
};

describe('ProcessRegistry', () => {
  it('signatureOf usa os 3 primeiros argumentos (nunca o prompt)', () => {
    expect(signatureOf(['-p', '--output-format', 'stream-json', '--verbose'])).toBe(SIG);
    expect(signatureOf(['exec', '--json', '--skip-git-repo-check', '-s', 'x', '--', 'prompt secreto'])).toBe('exec --json --skip-git-repo-check');
  });

  it('add/remove gravam no arquivo (criando a pasta)', () => {
    const f = file();
    const r = new ProcessRegistry(f, fakeOs({}).o, 10);
    r.add({ pid: 500, startedAt: 1, signature: SIG });
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([{ pid: 500, owner: 10, startedAt: 1, signature: SIG }]);
    expect(r.size).toBe(1);
    r.remove(500);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([]);
  });

  it('não apaga as entradas de outra janela ao gravar', () => {
    const f = file();
    new ProcessRegistry(f, fakeOs({}).o, 10).add({ pid: 500, startedAt: 1, signature: SIG });
    new ProcessRegistry(f, fakeOs({}).o, 20).add({ pid: 600, startedAt: 2, signature: SIG });
    expect(JSON.parse(readFileSync(f, 'utf8')).map((e: { pid: number }) => e.pid).sort()).toEqual([500, 600]);
  });

  it('reapOrphans mata só o que é de dono morto e com o comando conferindo (SIGTERM e depois SIGKILL)', () => {
    const f = file();
    writeFileSync(f, JSON.stringify([
      { pid: 500, owner: 10, startedAt: 1, signature: SIG },              // dono morto, comando confere → mata
      { pid: 501, owner: 10, startedAt: 1, signature: SIG },              // pid reaproveitado por outro programa → não mata
      { pid: 502, owner: 20, startedAt: 1, signature: SIG },              // dono vivo (outra janela) → não mata, fica
      { pid: 503, owner: 10, startedAt: 1, signature: SIG },              // já morreu → some
    ]));
    const { o, killed, runLater } = fakeOs({ 500: `claude ${SIG} --verbose`, 501: '/usr/bin/vim', 502: `claude ${SIG}` }, [20]);
    const r = new ProcessRegistry(f, o, 30);
    expect(r.reapOrphans()).toBe(1);
    expect(killed).toEqual([[500, 'SIGTERM']]);
    runLater();
    expect(killed).toEqual([[500, 'SIGTERM'], [500, 'SIGKILL']]);
    expect(JSON.parse(readFileSync(f, 'utf8')).map((e: { pid: number }) => e.pid)).toEqual([502]);
  });

  it('sem como conferir o comando (Windows), descarta a entrada sem matar', () => {
    const f = file();
    writeFileSync(f, JSON.stringify([{ pid: 500, owner: 10, startedAt: 1, signature: SIG }]));
    const { o, killed } = fakeOs({});
    o.isAlive = (pid) => pid === 500;
    const r = new ProcessRegistry(f, o, 30);
    expect(r.reapOrphans()).toBe(0);
    expect(killed).toEqual([]);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual([]);
  });

  it('arquivo corrompido ou ausente não lança', () => {
    const f = file();
    expect(new ProcessRegistry(f, fakeOs({}).o, 30).reapOrphans()).toBe(0);
    writeFileSync(f, '{ isto não é json');
    expect(() => new ProcessRegistry(f, fakeOs({}).o, 30).reapOrphans()).not.toThrow();
    writeFileSync(f, JSON.stringify([{ pid: 'x' }, null, { pid: 1, owner: 2, startedAt: 3, signature: '' }]));
    expect(new ProcessRegistry(f, fakeOs({}).o, 30).reapOrphans()).toBe(0);
  });
});
