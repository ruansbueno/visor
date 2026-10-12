import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CliCheck } from '../src/cli/detect';
import type { CliId } from '../src/core/options';
import type { WebviewMessage } from '../src/protocol';
import { formatDuration } from './format';
import type { Usage } from './state';

export type SetupAction = Extract<WebviewMessage, { type: 'recheckCli' | 'installCli' | 'loginCli' | 'pickCliPath' }>;

const CLI_NAME: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex' };

/** "reinicia em 2h 10min (às 14:30)"; `resetsAt` vem em segundos desde a época. */
function resetLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return '';
  const at = resetsAt * 1000;
  if (at <= now) return 'já reiniciou';
  const when = new Date(at);
  const sameDay = when.toDateString() === new Date(now).toDateString();
  const clock = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `reinicia em ${formatDuration(at - now)} (${sameDay ? 'às' : `${when.toLocaleDateString([], { weekday: 'short' })},`} ${clock})`;
}

function UsageRow(props: { label: string; value: number | undefined; resetsAt: number | undefined; now: number }) {
  const { label, value, resetsAt, now } = props;
  const pct = value === undefined ? undefined : Math.round(value * 100);
  return (
    <div className="usage-row">
      <span>{label}</span>
      <span className="usage-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, pct ?? 0)}%` }} /></span>
      <span>{pct === undefined ? '—' : `${pct}%`}</span>
      <span className="usage-reset">{resetLabel(resetsAt, now)}</span>
    </div>
  );
}

export function AccountMenu(props: { checks: Partial<Record<CliId, CliCheck>>; usage: Usage | null; onSetup(action: SetupAction): void }) {
  const { checks, usage, onSetup } = props;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);

  // Posição fixa calculada a partir do botão e limitada à janela: o painel nunca fica cortado.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const margin = 8;
      const width = Math.min(340, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
      setPos({ left, bottom: Math.max(margin, window.innerHeight - r.top + 6), width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const close = () => setOpen(false);
    const onDown = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Captura: o canvas (React Flow) interrompe a propagação dos cliques, então o listener normal nunca os veria.
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', close);
    document.addEventListener('keydown', onKey);
    return () => { clearInterval(tick); document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('blur', close); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const ids = (Object.keys(checks) as CliId[]).filter((id) => checks[id]);
  const hasProblem = ids.some((id) => checks[id]!.state !== 'ok');
  return (
    <span className="account-menu" ref={ref}>
      <button ref={btnRef} className={`icon-btn gear${hasProblem ? ' has-problem' : ''}`} aria-label="Conta e uso" aria-expanded={open} aria-haspopup="dialog" title="Conta e uso" onClick={() => setOpen((o) => !o)}>⚙</button>
      {open && (
        <div className="account-panel" role="dialog" aria-label="Conta e uso" style={pos ? { left: pos.left, bottom: pos.bottom, width: pos.width } : { visibility: 'hidden' }}>
          {ids.length === 0 && <div className="usage-reset">Verificando os CLIs…</div>}
          {ids.map((id) => {
            const c = checks[id]!;
            return (
              <section key={id} className="account-cli">
                <div className="account-head">
                  <strong>{CLI_NAME[id]}</strong>
                  <span className={`account-state ${c.state}`}>{c.state === 'ok' ? `✓ ${c.authMethod}` : c.state === 'not_installed' ? 'não instalado' : c.state === 'not_authenticated' ? 'sem login' : 'não verificado'}</span>
                </div>
                {c.state === 'ok' ? (
                  <div className="usage-reset">CLI {c.version} · a extensão não acessa suas credenciais.</div>
                ) : (
                  <div className="usage-reset">{c.message}</div>
                )}
                <div className="setup-actions">
                  {c.state === 'not_installed' && (
                    <>
                      <button className="secondary small" onClick={() => onSetup({ type: 'installCli', cli: id })}>Instalar</button>
                      <button className="secondary small" onClick={() => onSetup({ type: 'pickCliPath', cli: id })}>Escolher caminho…</button>
                    </>
                  )}
                  {c.state === 'not_authenticated' && <button className="small" onClick={() => onSetup({ type: 'loginCli', cli: id })}>Fazer login</button>}
                  <button className="secondary small" onClick={() => onSetup({ type: 'recheckCli', cli: id })}>Verificar de novo</button>
                </div>
                {id === 'claude' && c.state === 'ok' && (
                  usage ? (
                    <div className="usage">
                      <UsageRow label="Sessão (5h)" value={usage.fiveHour} resetsAt={usage.fiveHourResetsAt} now={now} />
                      <UsageRow label="Semana" value={usage.sevenDay} resetsAt={usage.sevenDayResetsAt} now={now} />
                    </div>
                  ) : (
                    <div className="usage-reset">O uso aparece depois da primeira mensagem enviada por aqui.</div>
                  )
                )}
              </section>
            );
          })}
        </div>
      )}
    </span>
  );
}
