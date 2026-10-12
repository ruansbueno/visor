import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const props = pkg.contributes.configuration.properties;

it('visor.claudePath só pode ser definido nas settings da máquina (nunca pelo workspace clonado)', () => {
  expect(props['visor.claudePath'].scope).toBe('machine');
});

it('o padrão de permissão é conservador e a extensão aponta para o bundle cjs', () => {
  expect(props['visor.permissionMode'].default).toBe('acceptEdits');
  expect(pkg.main).toBe('./dist/extension.cjs');
});

it('a extensão fica desabilitada em workspaces não confiáveis (ela roda o CLI e os hooks do projeto)', () => {
  expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(false);
});
