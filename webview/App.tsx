import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { HostMessage, WebviewMessage } from '../src/protocol';
import { Banner } from './Banner';
import { ContextMenu } from './ContextMenu';
import { buildOptions, type PillValues } from './option-lists';
import type { ChatCtx } from './chat-context';
import { GraphView } from './GraphView';
import { InputContext, type InputCtx } from './input-context';
import type { Move } from './moves';
import { NewChatDialog } from './NewChatDialog';
import { NewNodeDialog } from './NewNodeDialog';
import { NodeModal } from './NodeModal';
import { initialState, isBusy, isRunning, reduce, runOfNode } from './state';
import { Toolbar } from './Toolbar';

const vscode = acquireVsCodeApi();
const send = (m: WebviewMessage) => vscode.postMessage(m);

export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [now, setNow] = useState(() => Date.now());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // CLI/modelo/esforço/permissões escolhidos na barra de baixo para o PRÓXIMO chat ('' = padrão).
  const [quick, setQuick] = useState<PillValues>({ cli: 'claude', model: '', effort: '', perm: '' });
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [newAgentRun, setNewAgentRun] = useState<string | undefined>(undefined);
  const anyRunning = state.runs.some(isRunning);

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostMessage>) => dispatch(e.data);
    window.addEventListener('message', onMessage);
    send({ type: 'ready' });
    send({ type: 'recheckCli' }); // configuração inicial: avisa já se o CLI não foi encontrado ou não tem login
    send({ type: 'listClis' }); // a barra de baixo mostra o seletor de CLI se houver mais de uma instalada
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const select = useCallback((nodeId: string | null) => {
    dispatch({ type: 'select', nodeId });
    send({ type: 'inspect', nodeId });
  }, []);
  const closeModal = useCallback(() => select(null), [select]);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeNewChat = useCallback(() => setNewChatOpen(false), []);
  const openNewChat = useCallback(() => {
    send({ type: 'listClis' });
    send({ type: 'listCapabilities' });
    setNewChatOpen(true);
  }, []);
  const inputCtx = useMemo<InputCtx>(
    () => ({
      requestFiles: (requestId) => send({ type: 'pickFiles', requestId }),
      picked: state.picked,
      consumePicked: () => dispatch({ type: 'files_consumed' }),
      commands: state.caps.commands,
      requestCommands: () => send({ type: 'listCapabilities' }),
    }),
    [state.picked, state.caps.commands],
  );
  const closeNewAgent = useCallback(() => setNewAgentOpen(false), []);
  const openNewAgent = useCallback((runId?: string) => {
    send({ type: 'listAgents' });
    setNewAgentRun(runId);
    setNewAgentOpen(true);
  }, []);
  const onMove = useCallback((m: Move) => {
    dispatch({ type: 'moved', nodeId: m.nodeId, box: m.box });
    if (m.persist) send({ type: 'moveNode', nodeId: m.nodeId, ...m.box });
  }, []);
  const chatCtx = useMemo<ChatCtx>(
    () => ({
      onRename: (runId, title) => send({ type: 'rename', runId, title }),
      onCancel: (runId) => send({ type: 'cancel', runId }),
      onMarkDone: (runId) => send({ type: 'markDone', runId }),
      onRemove: (runId) => send({ type: 'removeChat', runId }),
      onAddAgent: (runId) => openNewAgent(runId),
      onSend: (nodeId, text, attachments) => send({ type: 'send', nodeId, text, ...(attachments.length ? { attachments } : {}) }),
      onOptions: (runId, options) => send({ type: 'setOptions', runId, options: options ?? {} }),
      models: (cli) => state.clis.find((c) => c.id === cli)?.models,
    }),
    [openNewAgent, state.clis],
  );

  const cancelPending = useCallback(() => send({ type: 'cancelPending' }), []);

  const inspectedRun = runOfNode(state.runs, state.inspectedId);
  const inspected = inspectedRun?.nodes.find((n) => n.id === state.inspectedId);

  // Com um diálogo aberto o fundo fica inerte (sem Tab/clique atrás), para o Esc e o foco não se misturarem.
  const dialogOpen = !!(inspected && inspectedRun) || newChatOpen || newAgentOpen;
  const inert = dialogOpen;

  return (
    <InputContext.Provider value={inputCtx}>
    <div className="app">
      <Banner
        inert={inert}
        checks={state.checks}
        notices={state.notices}
        authDismissed={state.authDismissed}
        onDismiss={(id) => dispatch({ type: 'dismiss', id })}
        onDismissAuth={() => send({ type: 'dismissAuth' })}
        onSetup={send}
      />
      <div
        className="canvas"
        {...(inert ? { inert: '' } : {})}
        onContextMenu={(e) => {
          // Em cima de um node ou dos controles do zoom não abrimos o menu do canvas.
          if ((e.target as Element).closest('.react-flow__node, .react-flow__controls')) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <GraphView runs={state.runs} boxes={state.layout} logs={state.chatLogs} now={now} chat={chatCtx} onSelectAgent={select} onMove={onMove} />
      </div>
      <Toolbar
        inert={inert}
        auth={state.authDismissed ? state.checks : null}
        starting={state.starting}
        quick={quick}
        onQuick={setQuick}
        clis={state.clis}
        defaultModel={state.caps.defaultModel}
        onStart={(prompt, attachments) => {
          const options = buildOptions(quick);
          send({ type: 'start', prompt, ...(options ? { options } : {}), ...(attachments.length ? { attachments } : {}) });
        }}
        onCancelPending={cancelPending}
        onNewChat={openNewChat}
        onNewAgent={() => openNewAgent()}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={[
            { label: 'Novo agente…', onSelect: () => openNewAgent() },
            { label: 'Novo chat…', onSelect: openNewChat },
          ]}
        />
      )}
      {inspected && inspectedRun && (
        <NodeModal
          title={inspected.agentType}
          subtitle={inspectedRun.title || 'Chat'}
          status={inspected.status}
          canSend={!isBusy(inspectedRun)}
          events={state.log && state.log.nodeId === inspected.id ? state.log.events : null}
          total={state.log?.nodeId === inspected.id ? state.log.total : 0}
          onSend={(text, attachments) => send({ type: 'send', nodeId: inspected.id, text, ...(attachments.length ? { attachments } : {}) })}
          onClose={closeModal}
        />
      )}
      {newChatOpen && (
        <NewChatDialog
          clis={state.clis}
          defaultModel={state.caps.defaultModel}
          initial={quick}
          onClose={closeNewChat}
          onCreate={(prompt, options, attachments) => {
            send({ type: 'start', prompt, ...(options ? { options } : {}), ...(attachments.length ? { attachments } : {}) });
            setNewChatOpen(false);
          }}
        />
      )}
      {newAgentOpen && (
        <NewNodeDialog
          agents={state.agents}
          runs={state.runs}
          initialRunId={newAgentRun}
          onClose={closeNewAgent}
          onCreate={(agentType, task, runId) => {
            send({ type: 'spawn', agentType, task, runId });
            setNewAgentOpen(false);
          }}
        />
      )}
    </div>
    </InputContext.Provider>
  );
}
