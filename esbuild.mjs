import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info' };

const configs = [
  {
    ...common,
    entryPoints: ['src/ext/extension.ts'],
    outfile: 'dist/extension.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/index.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    loader: { '.css': 'css' },
    define: { 'process.env.NODE_ENV': '"production"' },
  },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  for (const c of configs) await build(c);
}
