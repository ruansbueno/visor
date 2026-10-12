import { it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

it('o bundle da webview existe, não usa eval/new Function e inclui o app', () => {
  expect(existsSync('dist/webview.js')).toBe(true);
  const js = readFileSync('dist/webview.js', 'utf8');
  expect(js).not.toMatch(/\beval\(/);
  expect(js).not.toMatch(/new Function\(/);
  expect(js).toContain('clique com o bot');
  expect(existsSync('dist/webview.css')).toBe(true);
});
