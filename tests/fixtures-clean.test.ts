import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeValue, makeContext } from '../scripts/sanitize-fixtures';

const dirs = ['fixtures/stream', 'fixtures/hooks', 'fixtures/turns', 'fixtures/codex'];
const files = dirs.flatMap((d) =>
  readdirSync(d).filter((f) => f.endsWith('.ndjson')).map((f) => path.join(d, f)),
);

describe('fixtures não contêm dados pessoais', () => {
  it('há fixtures para verificar', () => expect(files.length).toBeGreaterThan(0));

  for (const f of files) {
    it(`${f}`, () => {
      const text = readFileSync(f, 'utf8');
      const user = os.userInfo().username;
      if (user.length > 3) expect(text).not.toContain(user);
      expect(text).not.toContain(os.homedir());
      expect(text).not.toMatch(/\/Users\/(?!user\b)[^/"\\]+/);
      expect(text).not.toMatch(/\/home\/(?!user\b)[^/"\\]+/);
      const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
      expect(emails.filter((e) => e !== 'user@example.com')).toEqual([]);
      expect(text).not.toMatch(/claude-\d{3,}/);
      for (const key of ['rate_limit_info', '"plugins"', '"mcp_servers"', '"slash_commands"', '"skills"', '"memory_paths"', '"messaging_socket_path"']) {
        expect(text).not.toContain(key);
      }
    });
  }
});

describe('sanitizeValue', () => {
  it('mapeia o mesmo UUID para o mesmo valor falso e é idempotente', () => {
    const ctx = makeContext();
    const id = '492d6a59-284f-440e-8984-5c4c9bdbc932';
    const once = sanitizeValue({ a: id, b: [id], rate_limit_info: { x: 1 } }, ctx) as any;
    expect(once.a).toBe(once.b[0]);
    expect(once.a).not.toBe(id);
    expect('rate_limit_info' in once).toBe(false);
    expect(sanitizeValue(once, makeContext())).toEqual(once);
  });

  it('troca e-mail e caminho do usuário', () => {
    const out = sanitizeValue({ m: `x@y.com ${os.homedir()}/p` }, makeContext()) as any;
    expect(out.m).toBe('user@example.com /home/user/p');
  });
});
