import { randomBytes } from 'node:crypto';

export function makeNonce(): string {
  return randomBytes(18).toString('base64url');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildWebviewHtml(o: { cspSource: string; nonce: string; scriptUri: string; styleUri: string }): string {
  const csp = [
    "default-src 'none'",
    `style-src ${o.cspSource} 'unsafe-inline'`, // React Flow aplica estilos inline
    `script-src 'nonce-${o.nonce}'`,
    `font-src ${o.cspSource}`,
    `img-src ${o.cspSource} data:`,
  ].join('; ');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${esc(o.styleUri)}">
<title>Visor — Agentes</title>
</head>
<body>
<div id="root"></div>
<script nonce="${esc(o.nonce)}" src="${esc(o.scriptUri)}"></script>
</body>
</html>`;
}
