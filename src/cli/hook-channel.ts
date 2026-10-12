import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';

export interface HookMessage {
  runId: string;
  payload: Record<string, unknown>;
}

export interface HookChannel {
  path: string;
  close(): Promise<void>;
}

export function createHookChannel(onMessage: (m: HookMessage) => void): Promise<HookChannel> {
  const id = randomBytes(6).toString('hex');
  const isWin = process.platform === 'win32';
  // Caminho de socket Unix tem limite (~104 chars no macOS); tmpdir + nome curto cabe.
  const p = isWin ? `\\\\.\\pipe\\visor-${id}` : path.join(os.tmpdir(), `visor-${id}.sock`);

  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    createInterface({ input: sock }).on('line', (line) => {
      try {
        const m = JSON.parse(line);
        if (m && typeof m.runId === 'string' && m.payload && typeof m.payload === 'object') {
          onMessage({ runId: m.runId, payload: m.payload });
        }
      } catch {
        /* linha inválida: ignorar */
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, () =>
      resolve({
        path: p,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              if (!isWin) rmSync(p, { force: true });
              done();
            });
          }),
      }),
    );
  });
}
