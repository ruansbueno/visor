import type { CliCheck } from '../src/cli/detect';
import type { CliId } from '../src/core/options';
import type { SetupAction } from './AccountMenu';
import type { Notice } from './state';


export function Banner(props: {
  checks: Partial<Record<CliId, CliCheck>>;
  notices: Notice[];
  authDismissed: boolean;
  onDismiss(id: number): void;
  onDismissAuth(): void;
  onSetup(action: SetupAction): void;
  inert?: boolean;
}) {
  const { checks, notices, authDismissed, onDismiss, onDismissAuth, onSetup, inert } = props;
  const entries = (Object.keys(checks) as CliId[]).map((id) => [id, checks[id]!] as const);
  const oks = entries.filter((e): e is readonly [CliId, Extract<CliCheck, { state: 'ok' }>] => e[1].state === 'ok');
  const problems = entries.filter(([, c]) => c.state !== 'ok');
  return (
    <div className="banners" {...(inert ? { inert: '' } : {})}>
      {oks.length > 0 && !authDismissed && (
        <div className="banner info" role="status">
          <span>
            Autenticação: {oks.map(([id, c], i) => (id === 'claude' ? `${c.authMethod} · via CLI do Claude Code ${c.version}` : `${i ? ' · ' : ''}Codex: ${c.authMethod} (${c.version})`)).join('')}
            . A extensão não acessa suas credenciais.
          </span>
          <button className="link" onClick={onDismissAuth} aria-label="Dispensar aviso de autenticação">×</button>
        </div>
      )}
      {problems.map(([id, c]) => c.state !== 'ok' && (
        <div key={id} className={`banner ${c.state === 'unknown' ? 'warn' : 'error'}`} role="alert">
          <span>{c.message}</span>
          <span className="setup-actions">
            {c.state === 'not_installed' && (
              <>
                <button onClick={() => onSetup({ type: 'installCli', cli: id })}>Instalar</button>
                <button onClick={() => onSetup({ type: 'pickCliPath', cli: id })}>Escolher caminho…</button>
              </>
            )}
            {c.state === 'not_authenticated' && <button onClick={() => onSetup({ type: 'loginCli', cli: id })}>Fazer login</button>}
            <button onClick={() => onSetup({ type: 'recheckCli', cli: id })}>Verificar de novo</button>
          </span>
        </div>
      ))}
      {notices.map((n) => (
        <div key={n.id} className={`banner ${n.level}`} role={n.level === 'error' ? 'alert' : 'status'}>
          <span>{n.text}</span>
          <button className="link" onClick={() => onDismiss(n.id)} aria-label="Dispensar aviso">×</button>
        </div>
      ))}
    </div>
  );
}
