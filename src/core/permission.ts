const MAX_SUMMARY = 2000;
const MAX_LABEL = 100;
// Controles, largura zero e marcas de direção (bidi) podem enganar a leitura do que está sendo aprovado.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

const clean = (s: string) => s.replace(UNSAFE, '');

/** Nome curto e seguro (ferramenta) para mostrar na tela. */
export function cleanLabel(s: string): string {
  const t = clean(s);
  return t.length > MAX_LABEL ? t.slice(0, MAX_LABEL) + '…' : t;
}

/** Texto curto e seguro do que o agente quer fazer, para a pessoa decidir. */
export function summarizeToolInput(tool: string, input: Record<string, unknown>, description?: string): string {
  let text = '';
  if (tool === 'Bash' && typeof input.command === 'string') text = input.command;
  else if (typeof input.file_path === 'string') text = input.file_path;
  else if (Object.keys(input).length > 0) {
    try {
      text = JSON.stringify(input) ?? '';
    } catch {
      text = '';
    }
  }
  if (!text) text = description ?? '';
  text = clean(text);
  // Texto longo: começo e fim. O fim de um comando é justamente onde algo perigoso pode se esconder.
  if (text.length <= MAX_SUMMARY) return text;
  const half = MAX_SUMMARY / 2;
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

/** Primeira sugestão do CLI que cria uma regra "permitir" (é o que "Permitir sempre" aplica). */
export function alwaysSuggestion(suggestions: unknown[]): unknown | undefined {
  return suggestions.find((s) => !!s && typeof s === 'object' && (s as any).type === 'addRules' && (s as any).behavior === 'allow');
}
