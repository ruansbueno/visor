import { useSyncExternalStore } from 'react';

/** O VS Code troca o tema mudando a classe do <body> (sem recarregar a Webview): `vscode-light`, `vscode-high-contrast-light`… */
export function isLightTheme(): boolean {
  const c = document.body.classList;
  return c.contains('vscode-light') || c.contains('vscode-high-contrast-light');
}

function subscribe(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange);
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
}

/** `true` no tema escuro; re-renderiza quando a pessoa troca de tema. */
export function useIsDark(): boolean {
  return !useSyncExternalStore(subscribe, isLightTheme);
}
