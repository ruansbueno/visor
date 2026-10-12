import { describe, it, expect } from 'vitest';
import { buildWebviewHtml, makeNonce } from '../../src/ext/html';

const html = buildWebviewHtml({ cspSource: 'vscode-webview://abc', nonce: 'N0NCE', scriptUri: 'vscode-webview://abc/dist/webview.js', styleUri: 'vscode-webview://abc/dist/webview.css' });

describe('buildWebviewHtml', () => {
  it('CSP: default-src none, script só com nonce, sem unsafe-eval', () => {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-N0NCE'");
    expect(csp).not.toContain('unsafe-eval');
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!;
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('o script carrega com o mesmo nonce e a div raiz existe', () => {
    expect(html).toContain('<script nonce="N0NCE" src="vscode-webview://abc/dist/webview.js"></script>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<link rel="stylesheet" href="vscode-webview://abc/dist/webview.css">');
  });

  it('não permite que valores injetem aspas no HTML', () => {
    const evil = buildWebviewHtml({ cspSource: 'x', nonce: 'n', scriptUri: 'a"><script>alert(1)</script>', styleUri: 's' });
    expect(evil).not.toContain('<script>alert(1)</script>');
  });
});

describe('makeNonce', () => {
  it('gera valores diferentes, só com caracteres seguros e com entropia suficiente', () => {
    const a = makeNonce(), b = makeNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});
