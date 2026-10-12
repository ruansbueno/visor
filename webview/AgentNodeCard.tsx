import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { formatDuration, STATUS_GLYPH, STATUS_LABEL } from './format';
import type { AgentNodeData } from './graph';

/** Node de um agente (subagente) ligado ao cartão do chat que o chamou. */
export const AgentNodeCard = memo(function AgentNodeCard({ data }: NodeProps) {
  const d = data as unknown as AgentNodeData & { now: number };
  const end = d.endedAt ?? d.now;
  const duration = d.startedAt ? formatDuration(end - d.startedAt) : '';
  return (
    <div className={`agent-node status-${d.status}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="agent-name"><span className="agent-title" title={d.label}>{d.label}</span></div>
      <div className="agent-meta">
        <span className="status-badge">
          <span aria-hidden="true">{STATUS_GLYPH[d.status]}</span> {STATUS_LABEL[d.status]}
        </span>
        <span>{duration}</span>
      </div>
      {d.eventCount > 0 && <div className="agent-events">{d.eventCount} eventos</div>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});
