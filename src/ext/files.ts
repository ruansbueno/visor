import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AttachedFile } from '../protocol';

/** Confere quais caminhos existem (e se são pastas). Não lê o conteúdo dos arquivos. */
export async function checkAttachments(paths: string[]): Promise<AttachedFile[]> {
  const out: AttachedFile[] = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (s.isFile() || s.isDirectory()) out.push({ path: p, name: path.basename(p) || p, isDir: s.isDirectory() });
    } catch {
      /* não existe mais: fica de fora e o controller avisa */
    }
  }
  return out;
}

// Dentro da pasta pessoal: credenciais, chaves e configurações de nuvem nunca devem ser anexadas.
const SENSITIVE_UNDER_HOME = ['.ssh', '.claude', '.claude.json', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.npmrc', '.config/gcloud', 'Library/Keychains'];

/** Barras normais, sem `.`/`..` nem barra final; minúsculas se o sistema de arquivos não diferencia maiúsculas. */
function norm(p: string, lower: boolean): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const out = (p.replace(/\\/g, '/').startsWith('/') ? '/' : '') + parts.join('/');
  return lower ? out.toLowerCase() : out;
}

/**
 * Caminhos que a extensão nunca repassa como anexo: a raiz, a pasta pessoal e os cantos de credenciais dela
 * (a regra de compliance §3.1: nada de tokens/credenciais).
 */
export function isSensitivePath(p: string, home: string, caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'): boolean {
  const np = norm(p, caseInsensitive);
  const nh = norm(home, caseInsensitive);
  if (np === '' || np === '/' || /^[a-z]:$/i.test(np)) return true;
  if (np === nh) return true;
  return SENSITIVE_UNDER_HOME.some((rel) => {
    const r = `${nh}/${caseInsensitive ? rel.toLowerCase() : rel}`;
    return np === r || np.startsWith(`${r}/`);
  });
}

/**
 * Regra de permissão que libera SÓ A LEITURA do anexo (nunca a pasta pai, nunca escrita):
 * `Read(//caminho)` para arquivo e `Read(//pasta/**)` para pasta.
 */
export function readRule(file: AttachedFile): string {
  let p = file.path.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/?/.exec(p);
  if (drive) p = `/${drive[1]!.toLowerCase()}/${p.slice(drive[0].length)}`;
  p = p.replace(/\/+$/, '');
  return `Read(/${p}${file.isDir ? '/**' : ''})`;
}
