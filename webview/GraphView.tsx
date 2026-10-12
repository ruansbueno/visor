import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventView, NodeBox, RunView } from '../src/protocol';
import { AgentNodeCard } from './AgentNodeCard';
import { ChatCard } from './ChatCard';
import { ChatContext, type ChatCtx } from './chat-context';
import { toFlow } from './graph';
import { toMoves, type Move } from './moves';
import { stabilizeNodes } from './stable';
import { useIsDark } from './theme';

const nodeTypes = { chat: ChatCard, agent: AgentNodeCard };
const FIT = { padding: 0.3, maxZoom: 1 };

/** Reenquadra o grafo quando muda o número de nodes, a menos que a pessoa já tenha movido/dado zoom. */
function AutoFit({ nodeCount, chatCount, userMoved }: { nodeCount: number; chatCount: number; userMoved: React.MutableRefObject<boolean> }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    userMoved.current = false; // chat novo ou removido: volta a enquadrar tudo
  }, [chatCount, userMoved]);
  useEffect(() => {
    if (userMoved.current) return;
    const id = requestAnimationFrame(() => {
      try {
        void fitView({ ...FIT, duration: 200 });
      } catch {
        /* sem layout ainda (ex.: ambiente de teste) */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [nodeCount, chatCount, fitView, userMoved]);
  return null;
}

export function GraphView(props: {
  runs: RunView[];
  boxes: Record<string, NodeBox>;
  logs: Record<string, { events: EventView[]; total: number }>;
  now: number;
  chat: ChatCtx;
  onSelectAgent(nodeId: string): void;
  onMove(move: Move): void;
}) {
  const { runs, boxes, logs, now, chat, onSelectAgent, onMove } = props;
  const flow = useMemo(() => toFlow(runs, boxes), [runs, boxes]);
  // Controlado: quem guarda a seleção somos nós (o React Flow só avisa por onNodesChange).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stable = useRef(new Map<string, Node>());
  const nodes = useMemo(
    () =>
      stabilizeNodes(
        stable.current,
        flow.nodes.map((n): Node => {
          const data = n.type === 'agent' ? { ...n.data, now } : { ...n.data, log: logs[n.data.runId] };
          return { ...n, data, selected: n.id === selectedId };
        }),
      ),
    [flow, now, logs, selectedId],
  );
  const dark = useIsDark();
  const userMoved = useRef(false);

  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === 'select') setSelectedId((cur) => (c.selected ? c.id : cur === c.id ? null : cur));
    }
    for (const move of toMoves(changes, nodes)) onMove(move);
  };

  return (
    <>
      <ChatContext.Provider value={chat}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => {
              if (node.type === 'agent') onSelectAgent(node.id);
            }}
            colorMode={dark ? 'dark' : 'light'}
            fitView
            fitViewOptions={FIT}
            onMoveStart={(event) => {
              if (event) userMoved.current = true; // gesto da pessoa (arrastar/zoom), não o fitView automático
            }}
            nodesConnectable={false}
            selectNodesOnDrag={false}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
          >
            <AutoFit nodeCount={flow.nodes.length} chatCount={runs.length} userMoved={userMoved} />
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </ChatContext.Provider>
      {runs.length === 0 && (
        <div className="empty-hint">Escreva um prompt e clique em Executar, ou clique com o botão direito para criar um chat ou um agente.</div>
      )}
    </>
  );
}
