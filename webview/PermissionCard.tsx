import { useEffect, useRef, useState } from 'react';
import type { PermissionPrompt } from '../src/core/schema';

export type PermissionChoice = 'allow' | 'allow_always' | 'deny';

/** Pedido de permissão de ferramenta do Claude Code: a pessoa decide aqui, sem sair do Visor. */
export function PermissionCard({ prompt, more, onAnswer }: { prompt: PermissionPrompt; more: number; onAnswer(choice: PermissionChoice): void }) {
  const first = useRef<HTMLButtonElement>(null);
  const [locked, setLocked] = useState(false);
  const unlock = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(unlock.current), []);
  // Foco no primeiro botão para dar para decidir pelo teclado, mas só se ninguém estiver com o foco:
  // quem está digitando num campo não pode aprovar sem querer com um Espaço/Enter.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) first.current?.focus({ preventScroll: true });
  }, [prompt.requestId]);
  // Logo depois de uma decisão o próximo pedido pode ocupar o mesmo lugar: trava um instante para um duplo clique não aprová-lo.
  const answer = (choice: PermissionChoice) => {
    if (locked) return;
    setLocked(true);
    clearTimeout(unlock.current);
    unlock.current = setTimeout(() => setLocked(false), 600);
    onAnswer(choice);
  };
  return (
    <div className="permission-card" role="group" aria-label="Pedido de permissão">
      <div className="question-title"><span className="spinner" aria-hidden="true" /> Permissão necessária: <strong>{prompt.tool}</strong></div>
      {prompt.summary && <pre className="permission-summary">{prompt.summary}</pre>}
      <div className="question-options">
        <button ref={first} className="option" disabled={locked} onClick={() => answer('allow')}>Permitir</button>
        {prompt.hasAlways && <button className="option" disabled={locked} onClick={() => answer('allow_always')}>Permitir sempre</button>}
        <button className="option deny" disabled={locked} onClick={() => answer('deny')}>Negar</button>
      </div>
      {more > 0 && <div className="question-hint">+{more} {more === 1 ? 'pedido' : 'pedidos'} na fila.</div>}
    </div>
  );
}
