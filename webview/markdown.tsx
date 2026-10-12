import { Fragment, type ReactNode } from 'react';

// Renderizador de markdown mínimo e seguro: tudo vira elementos React (texto escapado pelo React),
// sem HTML cru e sem <a> — nada clicável vindo do agente.

const LOOKAHEAD = 2000;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lit = '';
  let k = 0;
  const flush = () => {
    if (lit) out.push(lit);
    lit = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '`') {
      const j = text.indexOf('`', i + 1);
      if (j > i + 1 && j - i <= LOOKAHEAD) {
        flush();
        out.push(<code key={k++}>{text.slice(i + 1, j)}</code>);
        i = j + 1;
        continue;
      }
    } else if (c === '*' && text[i + 1] === '*') {
      const j = text.indexOf('**', i + 2);
      if (j > i + 2 && j - i <= LOOKAHEAD) {
        flush();
        out.push(<strong key={k++}>{inline(text.slice(i + 2, j))}</strong>);
        i = j + 2;
        continue;
      }
    } else if (c === '*') {
      const next = text[i + 1];
      if (next && !/\s/.test(next) && next !== '*') {
        const j = text.indexOf('*', i + 1);
        if (j > i + 1 && j - i <= LOOKAHEAD && !/\s/.test(text[j - 1]!) && text[j + 1] !== '*') {
          flush();
          out.push(<em key={k++}>{inline(text.slice(i + 1, j))}</em>);
          i = j + 1;
          continue;
        }
      }
    } else if (c === '[') {
      const m = LINK.exec(text.slice(i, i + LOOKAHEAD));
      if (m) {
        lit += `${m[1]} (${m[2]})`;
        i += m[0].length;
        continue;
      }
    }
    lit += c;
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^\s*```(.*)$/;
const FENCE_END = /^\s*```\s*$/;
const HEADING = /^#{1,6}\s+(.+)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function lines(ls: string[]): ReactNode[] {
  return ls.flatMap((l, idx) => (idx === 0 ? [<Fragment key={idx}>{inline(l)}</Fragment>] : [<br key={`b${idx}`} />, <Fragment key={idx}>{inline(l)}</Fragment>]));
}

const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || UL.test(l) || OL.test(l) || QUOTE.test(l);

export function Markdown({ text }: { text: string }) {
  const src = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < src.length) {
    const line = src[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1]!.trim().split(/\s+/)[0] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < src.length && !FENCE_END.test(src[i]!)) body.push(src[i++]!);
      i += 1; // fecha o bloco (ou passa do fim, se não houve fechamento)
      if (lang !== 'visor-question') blocks.push(<pre key={key++}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push(<div key={key++} className="md-h">{inline(h[1]!)}</div>);
      i += 1;
      continue;
    }
    const ul = UL.test(line);
    if (ul || OL.test(line)) {
      const re = ul ? UL : OL;
      const items: ReactNode[] = [];
      while (i < src.length && re.test(src[i]!)) items.push(<li key={items.length}>{inline(re.exec(src[i++]!)![1]!)}</li>);
      blocks.push(ul ? <ul key={key++}>{items}</ul> : <ol key={key++}>{items}</ol>);
      continue;
    }
    if (QUOTE.test(line)) {
      const q: string[] = [];
      while (i < src.length && QUOTE.test(src[i]!)) q.push(QUOTE.exec(src[i++]!)![1]!);
      blocks.push(<blockquote key={key++}>{lines(q)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < src.length && src[i]!.trim() && !(para.length > 0 && startsBlock(src[i]!))) para.push(src[i++]!);
    blocks.push(<p key={key++}>{lines(para)}</p>);
  }
  return <>{blocks}</>;
}
