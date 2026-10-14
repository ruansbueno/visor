import { describe, it, expect } from 'vitest';
import { createDiagLog, NO_LOG } from '../../src/ext/diag-log';

const at = () => new Date('2026-10-14T12:00:00.000Z');

describe('createDiagLog', () => {
  it('info: horário ISO, evento e campos k=v; undefined some; texto com espaço vai entre aspas', () => {
    const lines: string[] = [];
    const log = createDiagLog((l) => lines.push(l), () => false, at);
    log.info('exit', { pid: 42, code: 0, cancelled: false, signal: undefined, stderr: 'deu ruim aqui' });
    expect(lines).toEqual(['2026-10-14T12:00:00.000Z exit pid=42 code=0 cancelled=false stderr="deu ruim aqui"']);
  });

  it('debug só escreve com debugOn() verdadeiro, lido a cada chamada', () => {
    const lines: string[] = [];
    let on = false;
    const log = createDiagLog((l) => lines.push(l), () => on, at);
    log.debug('snapshot', { bytes: 10 });
    on = true;
    log.debug('snapshot', { bytes: 20 });
    expect(lines).toEqual(['2026-10-14T12:00:00.000Z snapshot bytes=20']);
    expect(log.debugEnabled()).toBe(true);
  });

  it('NO_LOG não faz nada e não lança', () => {
    expect(() => { NO_LOG.info('x'); NO_LOG.debug('y'); }).not.toThrow();
    expect(NO_LOG.debugEnabled()).toBe(false);
  });
});
