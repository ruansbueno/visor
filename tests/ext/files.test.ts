import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAttachments, isSensitivePath, readRule } from '../../src/ext/files';

describe('checkAttachments', () => {
  it('devolve arquivos e pastas existentes, na ordem, ignorando os que não existem', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'visor-att-'));
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    mkdirSync(path.join(dir, 'sub'));
    const out = await checkAttachments([path.join(dir, 'a.txt'), path.join(dir, 'nao-existe'), path.join(dir, 'sub')]);
    expect(out).toEqual([
      { path: path.join(dir, 'a.txt'), name: 'a.txt', isDir: false },
      { path: path.join(dir, 'sub'), name: 'sub', isDir: true },
    ]);
  });
  it('lista vazia devolve lista vazia', async () => {
    expect(await checkAttachments([])).toEqual([]);
  });
});

describe('isSensitivePath', () => {
  const home = '/home/u';
  it.each([
    ['/'], ['/home/u'], ['/home/u/'], ['/home/u/.ssh'], ['/home/u/.ssh/id_rsa'], ['/home/u/.claude'], ['/home/u/.claude/.credentials.json'],
    ['/home/u/.claude.json'], ['/home/u/.aws/credentials'], ['/home/u/.gnupg/x'], ['/home/u/.kube/config'], ['/home/u/.netrc'],
    ['/home/u/.config/gcloud/creds.db'], ['/home/u/Library/Keychains/login.keychain-db'], ['/home/u/proj/../.ssh/id_rsa'],
  ])('bloqueia %s', (p) => expect(isSensitivePath(p, home)).toBe(true));

  it.each([['/home/u/proj/a.txt'], ['/home/u/.sshfoo/x'], ['/home/u/notas.txt'], ['/tmp/x'], ['/home/u2/.ssh/x'], ['/home/u/proj/.claude/agents/a.md']])('permite %s', (p) =>
    expect(isSensitivePath(p, home)).toBe(false));

  it('ignora maiúsculas quando o sistema não diferencia (macOS/Windows) e entende caminhos do Windows', () => {
    expect(isSensitivePath('/Home/U/.SSH/id', home, true)).toBe(true);
    expect(isSensitivePath('/Home/U/.SSH/id', home, false)).toBe(false);
    expect(isSensitivePath('C:\\Users\\u\\.ssh\\key', 'C:\\Users\\u', true)).toBe(true);
    expect(isSensitivePath('C:\\Users\\u', 'C:\\Users\\u', true)).toBe(true);
    expect(isSensitivePath('C:\\Users\\u\\proj\\a.txt', 'C:\\Users\\u', true)).toBe(false);
  });
});

describe('readRule (liberação de LEITURA de um anexo fora do projeto)', () => {
  it('arquivo vira Read(//caminho); pasta vira Read(//pasta/**); espaços e vírgulas ficam intactos', () => {
    expect(readRule({ path: '/a/b c,d.txt', name: 'x', isDir: false })).toBe('Read(//a/b c,d.txt)');
    expect(readRule({ path: '/a/docs', name: 'docs', isDir: true })).toBe('Read(//a/docs/**)');
    expect(readRule({ path: '/a/docs/', name: 'docs', isDir: true })).toBe('Read(//a/docs/**)');
  });
  it('caminho do Windows vira a forma //c/...', () => {
    expect(readRule({ path: 'C:\\x\\y z.txt', name: 'y', isDir: false })).toBe('Read(//c/x/y z.txt)');
    expect(readRule({ path: 'D:\\dados', name: 'dados', isDir: true })).toBe('Read(//d/dados/**)');
  });
});
