/** Campos de uma linha de diagnóstico. Nunca passar prompts, mensagens, tokens, e-mail ou caminhos de credencial. */
export type DiagFields = Record<string, string | number | boolean | undefined>;

export interface DiagLog {
  info(event: string, fields?: DiagFields): void;
  /** Só escreve com `visor.debugLog` ligado. */
  debug(event: string, fields?: DiagFields): void;
  /** Para não calcular campos caros (ex.: tamanho do snapshot) à toa. */
  debugEnabled(): boolean;
}

const value = (v: string | number | boolean) => (typeof v === 'string' && /[\s"=]/.test(v) ? JSON.stringify(v) : String(v));

/** Uma linha por evento: `<ISO> <evento> k=v ...`, fácil de ler no canal de saída e de filtrar com grep. */
export function createDiagLog(append: (line: string) => void, debugOn: () => boolean, now: () => Date = () => new Date()): DiagLog {
  const line = (event: string, fields: DiagFields = {}) =>
    [now().toISOString(), event, ...Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${value(v!)}`)].join(' ');
  return {
    info: (event, fields) => append(line(event, fields)),
    debug: (event, fields) => {
      if (debugOn()) append(line(event, fields));
    },
    debugEnabled: debugOn,
  };
}

export const NO_LOG: DiagLog = { info() {}, debug() {}, debugEnabled: () => false };
