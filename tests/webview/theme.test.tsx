// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useIsDark } from '../../webview/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  return createElement('span', { id: 'probe' }, useIsDark() ? 'dark' : 'light');
}

describe('useIsDark', () => {
  it('acompanha a troca de tema feita pelo VS Code na classe do body', async () => {
    document.body.className = 'vscode-dark';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    expect(host.textContent).toBe('dark');
    await act(async () => {
      document.body.className = 'vscode-light';
      await Promise.resolve();
    });
    expect(host.textContent).toBe('light');
    await act(async () => {
      document.body.className = 'vscode-high-contrast vscode-dark';
      await Promise.resolve();
    });
    expect(host.textContent).toBe('dark');
    await act(async () => root.unmount());
  });
});
