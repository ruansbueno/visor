import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Um processo do CLI iniciado pelo Visor. `owner` é o pid do extension host (cada janela do VS Code tem o seu). */
export interface ProcEntry {
  pid: number;
  owner: number;
  startedAt: number;
  /** começo da linha de comando (os 3 primeiros argumentos), para não matar um pid reaproveitado */
  signature: string;
}

export interface RegistryOs {
  /** linha de comando atual do pid; undefined se não existe ou não dá para conferir */
  commandOf(pid: number): string | undefined;
  /** horário em que o pid começou a rodar (epoch ms); undefined se não existe ou não dá para conferir */
  startTimeOf(pid: number): number | undefined;
  isAlive(pid: number): boolean;
  /** encerra o grupo do processo (o CLI é líder de grupo: `detached`) */
  killGroup(pid: number, signal: NodeJS.Signals): void;
  later(fn: () => void, ms: number): void;
}

/** Os 3 primeiros argumentos: identificam o modo do CLI (`-p --output-format stream-json`, `exec --json ...`), nunca o prompt. */
export const signatureOf = (args: string[]): string => args.slice(0, 3).join(' ');

/** Tolerância entre o horário gravado e o que o SO informa agora (arredondamentos de segundo, relógio do SO). */
const START_TIME_TOLERANCE_MS = 5_000;

const isEntry = (e: unknown): e is ProcEntry => {
  const x = e as ProcEntry;
  return !!x && typeof x === 'object' && Number.isInteger(x.pid) && x.pid > 1 && Number.isInteger(x.owner)
    && typeof x.startedAt === 'number' && typeof x.signature === 'string' && x.signature.length > 0;
};

/**
 * Lista, em disco, dos processos do CLI que o Visor iniciou. Sobrevive ao VS Code: na ativação seguinte, os que ficaram
 * vivos com o dono já morto (host que caiu, VS Code fechado à força) são encerrados. Entradas de outras janelas vivas
 * nunca são tocadas. Nenhum erro de disco impede a extensão de funcionar.
 */
export class ProcessRegistry {
  private readonly mine = new Map<number, ProcEntry>();

  constructor(private readonly file: string, private readonly os: RegistryOs, private readonly owner: number) {}

  get size(): number {
    return this.mine.size;
  }

  add(e: Omit<ProcEntry, 'owner'>): void {
    this.mine.set(e.pid, { ...e, owner: this.owner });
    this.save();
  }

  remove(pid: number): void {
    if (this.mine.delete(pid)) this.save();
  }

  /** Encerra os órfãos de ativações anteriores. Devolve quantos foram encerrados. */
  reapOrphans(): number {
    let killed = 0;
    const keep: ProcEntry[] = [];
    for (const e of this.load()) {
      if (e.owner === this.owner) continue;
      if (this.os.isAlive(e.owner)) {
        keep.push(e); // outra janela do VS Code, ainda aberta: os processos são dela
        continue;
      }
      const cmd = this.os.commandOf(e.pid);
      if (!cmd || !cmd.includes(e.signature)) continue; // já morreu, pid reaproveitado ou sem como conferir
      // Além do comando, confere o horário de início: um pid reaproveitado para outro processo do mesmo nome
      // (ex.: outro `claude -p` iniciado por outra ferramenta ou janela, depois de a máquina reiniciar) não é confundido com o nosso.
      const startedAt = this.os.startTimeOf(e.pid);
      if (startedAt === undefined || Math.abs(startedAt - e.startedAt) > START_TIME_TOLERANCE_MS) continue;
      try {
        this.os.killGroup(e.pid, 'SIGTERM');
        this.os.later(() => {
          try {
            this.os.killGroup(e.pid, 'SIGKILL');
          } catch {
            /* saiu com o SIGTERM */
          }
        }, 2000);
        killed += 1;
      } catch {
        /* já terminou */
      }
    }
    this.write([...keep, ...this.mine.values()]);
    return killed;
  }

  private load(): ProcEntry[] {
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(data) ? data.filter(isEntry) : [];
    } catch {
      return [];
    }
  }

  /** Regrava as entradas das outras janelas como estão e as desta janela como estão agora. */
  private save(): void {
    this.write([...this.load().filter((e) => e.owner !== this.owner), ...this.mine.values()]);
  }

  private write(entries: ProcEntry[]): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${this.owner}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries));
      renameSync(tmp, this.file);
    } catch {
      /* sem disco: segue sem registro */
    }
  }
}

export const nodeRegistryOs: RegistryOs = {
  commandOf(pid) {
    // No Windows não há como conferir a linha de comando com segurança: a entrada é descartada, nada é encerrado.
    if (process.platform === 'win32') return undefined;
    const r = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const out = r.status === 0 ? r.stdout.trim() : '';
    return out || undefined;
  },
  startTimeOf(pid) {
    // Mesmo motivo do commandOf: sem isso no Windows, a entrada é descartada sem matar.
    if (process.platform === 'win32') return undefined;
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    if (r.status !== 0) return undefined;
    const ms = Date.parse(r.stdout.trim());
    return Number.isFinite(ms) ? ms : undefined;
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  killGroup(pid, signal) {
    process.kill(-pid, signal);
  },
  later(fn, ms) {
    setTimeout(fn, ms).unref();
  },
};
