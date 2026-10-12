import type { NodeStatus } from '../src/core/schema';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`;
}

export const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'aguardando',
  running: 'executando',
  waiting: 'aguardando resposta',
  done: 'concluído',
  error: 'erro',
  cancelled: 'cancelado',
};

export const STATUS_GLYPH: Record<NodeStatus, string> = {
  pending: '○',
  running: '●',
  waiting: '?',
  done: '✓',
  error: '✕',
  cancelled: '■',
};
