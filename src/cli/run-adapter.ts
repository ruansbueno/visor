import type { NormalizedEvent } from '../core/schema';

/** O que o runner precisa de um adaptador de CLI: converter linhas de saída em eventos e fechar o run. */
export interface RunAdapter {
  malformedLines: number;
  push(line: string): NormalizedEvent[];
  end(cancelled: boolean): NormalizedEvent[];
  /** Há tarefa em segundo plano pendente (só o Claude informa): o processo não deve ser encerrado ainda. */
  hasBackgroundTasks?(): boolean;
}
