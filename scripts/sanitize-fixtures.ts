import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DROP_KEYS = new Set([
  'rate_limit_info', 'plugins', 'mcp_servers', 'slash_commands', 'terminal_slash_commands',
  'skills', 'agents', 'memory_paths', 'messaging_socket_path', 'apiKeySource',
  'session_crons', 'background_tasks',
]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export interface SanitizeContext {
  home: string;
  user: string;
  uuids: Map<string, string>;
}

export function makeContext(): SanitizeContext {
  return { home: os.homedir(), user: os.userInfo().username, uuids: new Map() };
}

function sanitizeString(s: string, ctx: SanitizeContext): string {
  let out = s;
  const enc = (p: string) => p.replace(/\//g, '-');
  out = out.split(enc(ctx.home) + '-').join('-home-user-'); // diretórios de projeto codificados
  out = out.split(ctx.home).join('/home/user');
  out = out.replace(/\/private\/tmp\/claude-\d+/g, '/tmp/claude-test').replace(/claude-\d{3,}/g, 'claude-test');
  if (ctx.user.length > 3) out = out.split(ctx.user).join('user');
  out = out.replace(EMAIL, 'user@example.com');
  out = out.replace(UUID, (m) => {
    const key = m.toLowerCase();
    let v = ctx.uuids.get(key);
    if (!v) {
      v = `00000000-0000-4000-8000-${String(ctx.uuids.size + 1).padStart(12, '0')}`;
      ctx.uuids.set(key, v);
    }
    return v;
  });
  return out;
}

export function sanitizeValue(value: unknown, ctx: SanitizeContext): unknown {
  if (typeof value === 'string') return sanitizeString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      out[k] = sanitizeValue(v, ctx);
    }
    return out;
  }
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = makeContext();
  for (const dir of ['fixtures/stream', 'fixtures/hooks', 'fixtures/turns', 'fixtures/codex']) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ndjson'))) {
      const file = path.join(dir, f);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const out = lines.map((l) => JSON.stringify(sanitizeValue(JSON.parse(l), ctx)));
      writeFileSync(file, out.join('\n') + '\n');
      console.log(`sanitizado: ${file} (${lines.length} linhas)`);
    }
  }
}
