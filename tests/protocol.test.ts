import { describe, it, expect } from 'vitest';
import { parseWebviewMessage, describeRejected, MAX_PROMPT_BYTES, MAX_PASTE_BASE64 } from '../src/protocol';

describe('parseWebviewMessage', () => {
  it('aceita ready, cancel e start válido', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'cancel', runId: 'r' })).toEqual({ type: 'cancel', runId: 'r' });
    expect(parseWebviewMessage({ type: 'start', prompt: 'faça X' })).toEqual({ type: 'start', prompt: 'faça X' });
  });

  it('descarta campos extras', () => {
    expect(parseWebviewMessage({ type: 'cancel', runId: 'r', evil: 1 })).toEqual({ type: 'cancel', runId: 'r' });
  });

  it('rejeita prompt vazio, só espaços, não-string e gigante', () => {
    for (const prompt of ['', '   \n', 5, null, undefined, 'x'.repeat(MAX_PROMPT_BYTES + 1)]) {
      expect(parseWebviewMessage({ type: 'start', prompt })).toBeNull();
    }
    expect(parseWebviewMessage({ type: 'start', prompt: 'x'.repeat(MAX_PROMPT_BYTES) })).not.toBeNull();
  });

  it('rejeita prompt com byte nulo (spawn lançaria) e prompt grande em bytes (acentos)', () => {
    expect(parseWebviewMessage({ type: 'start', prompt: 'oi\0mundo' })).toBeNull();
    expect(parseWebviewMessage({ type: 'start', prompt: 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1) })).toBeNull();
    expect(parseWebviewMessage({ type: 'start', prompt: 'é'.repeat(MAX_PROMPT_BYTES / 2) })).not.toBeNull();
  });

  it('rejeita tipos desconhecidos e formas inesperadas sem lançar', () => {
    for (const raw of [null, undefined, 3, 'start', [], {}, { type: 7 }, { type: 'rm -rf' }]) {
      expect(parseWebviewMessage(raw)).toBeNull();
    }
  });

  it('aceita inspect com id (string curta) ou null e dismissAuth', () => {
    expect(parseWebviewMessage({ type: 'inspect', nodeId: 'r1:t1' })).toEqual({ type: 'inspect', nodeId: 'r1:t1' });
    expect(parseWebviewMessage({ type: 'inspect', nodeId: null })).toEqual({ type: 'inspect', nodeId: null });
    expect(parseWebviewMessage({ type: 'dismissAuth' })).toEqual({ type: 'dismissAuth' });
  });

  it('rejeita inspect com id inválido (não-string, vazio, enorme)', () => {
    for (const nodeId of [5, undefined, '', 'x'.repeat(301), {}]) {
      expect(parseWebviewMessage({ type: 'inspect', nodeId })).toBeNull();
    }
  });

  it('aceita send, spawn, markDone e listAgents válidos', () => {
    expect(parseWebviewMessage({ type: 'send', nodeId: 'r:root', text: 'Azul' })).toEqual({ type: 'send', nodeId: 'r:root', text: 'Azul' });
    expect(parseWebviewMessage({ type: 'spawn', agentType: 'code-reviewer', task: 'revise src/a.ts' })).toEqual({ type: 'spawn', agentType: 'code-reviewer', task: 'revise src/a.ts', runId: null });
    expect(parseWebviewMessage({ type: 'markDone', runId: 'r' })).toEqual({ type: 'markDone', runId: 'r' });
    expect(parseWebviewMessage({ type: 'listAgents' })).toEqual({ type: 'listAgents' });
  });

  it('send e spawn aplicam as mesmas regras do prompt (vazio, byte nulo, bytes) e validam ids/tipos', () => {
    for (const text of ['', '  ', 'a\0b', 5, 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1)]) {
      expect(parseWebviewMessage({ type: 'send', nodeId: 'r:root', text })).toBeNull();
      expect(parseWebviewMessage({ type: 'spawn', agentType: 'x', task: text })).toBeNull();
    }
    for (const nodeId of ['', 5, undefined, null, 'x'.repeat(301)]) {
      expect(parseWebviewMessage({ type: 'send', nodeId, text: 'ok' })).toBeNull();
    }
    for (const agentType of ['', 'com espaço', 'a"b', 'x'.repeat(101), 5, '../../etc', 'a\nb']) {
      expect(parseWebviewMessage({ type: 'spawn', agentType, task: 'ok' })).toBeNull();
    }
  });

  it('start aceita título opcional (limpo, curto); cancel e markDone exigem runId', () => {
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', title: '  Meu chat ' })).toEqual({ type: 'start', prompt: 'x', title: 'Meu chat' });
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', title: '   ' })).toEqual({ type: 'start', prompt: 'x' });
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', title: 'a\nb\tc' })).toEqual({ type: 'start', prompt: 'x', title: 'a b c' });
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', title: 'x'.repeat(300) })).toBeNull();
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', title: 5 })).toBeNull();
    expect(parseWebviewMessage({ type: 'cancel', runId: 'r1' })).toEqual({ type: 'cancel', runId: 'r1' });
    expect(parseWebviewMessage({ type: 'markDone', runId: 'r1' })).toEqual({ type: 'markDone', runId: 'r1' });
    for (const t of ['cancel', 'markDone']) {
      for (const runId of [undefined, '', 5, 'x'.repeat(301)]) expect(parseWebviewMessage({ type: t, runId })).toBeNull();
    }
  });

  it('spawn aceita runId (string) ou ausente/null para criar um chat novo', () => {
    expect(parseWebviewMessage({ type: 'spawn', agentType: 'a', task: 't', runId: 'r1' })).toEqual({ type: 'spawn', agentType: 'a', task: 't', runId: 'r1' });
    expect(parseWebviewMessage({ type: 'spawn', agentType: 'a', task: 't', runId: null })).toEqual({ type: 'spawn', agentType: 'a', task: 't', runId: null });
    expect(parseWebviewMessage({ type: 'spawn', agentType: 'a', task: 't' })).toEqual({ type: 'spawn', agentType: 'a', task: 't', runId: null });
    expect(parseWebviewMessage({ type: 'spawn', agentType: 'a', task: 't', runId: 5 })).toBeNull();
  });

  it('aceita removeChat (com runId) e cancelPending', () => {
    expect(parseWebviewMessage({ type: 'removeChat', runId: 'r1' })).toEqual({ type: 'removeChat', runId: 'r1' });
    expect(parseWebviewMessage({ type: 'removeChat' })).toBeNull();
    expect(parseWebviewMessage({ type: 'cancelPending' })).toEqual({ type: 'cancelPending' });
  });

  it('título: remove caracteres de controle, de largura zero e de direção (bidi)', () => {
    const evil = 'a\u202Eb\u200Bc\u0007d\u2066e';
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', title: evil })).toEqual({ type: 'start', prompt: 'x', title: 'abcde' });
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', title: '\u202E\u200B' })).toEqual({ type: 'start', prompt: 'x' });
  });

  it('rename exige runId e um título não vazio, limpo', () => {
    expect(parseWebviewMessage({ type: 'rename', runId: 'r1', title: '  Novo nome ' })).toEqual({ type: 'rename', runId: 'r1', title: 'Novo nome' });
    for (const title of ['', '   ', '\u202E', 5, undefined, 'x'.repeat(201)]) {
      expect(parseWebviewMessage({ type: 'rename', runId: 'r1', title })).toBeNull();
    }
    expect(parseWebviewMessage({ type: 'rename', title: 'x' })).toBeNull();
  });

  it('moveNode valida números finitos e limites; tamanho é opcional', () => {
    expect(parseWebviewMessage({ type: 'moveNode', nodeId: 'r:a', x: 10.5, y: -20 })).toEqual({ type: 'moveNode', nodeId: 'r:a', x: 10.5, y: -20 });
    expect(parseWebviewMessage({ type: 'moveNode', nodeId: 'r:a', x: 1, y: 2, width: 400, height: 300 })).toEqual({ type: 'moveNode', nodeId: 'r:a', x: 1, y: 2, width: 400, height: 300 });
    const bad = [
      { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: '1', y: 0 }, { x: 2e6, y: 0 }, { x: 0, y: -2e6 },
      { x: 0, y: 0, width: 10 }, { x: 0, y: 0, height: 99999 }, { x: 0, y: 0, width: 'a' },
    ];
    for (const b of bad) expect(parseWebviewMessage({ type: 'moveNode', nodeId: 'r:a', ...b })).toBeNull();
    expect(parseWebviewMessage({ type: 'moveNode', x: 0, y: 0 })).toBeNull();
  });

  it('start aceita options e attachments válidos e rejeita inválidos', () => {
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', options: { model: 'opus', effort: 'high' }, attachments: ['/a/b.txt'] }))
      .toEqual({ type: 'start', prompt: 'x', options: { model: 'opus', effort: 'high' }, attachments: ['/a/b.txt'] });
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', options: {}, attachments: [] })).toEqual({ type: 'start', prompt: 'x' });
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', options: { model: '--x' } })).toBeNull();
    expect(parseWebviewMessage({ type: 'start', prompt: 'x', attachments: ['relativo'] })).toBeNull();
  });

  it('send aceita attachments; texto vazio com anexo é permitido', () => {
    expect(parseWebviewMessage({ type: 'send', nodeId: 'r:root', text: 'olhe', attachments: ['/a'] })).toEqual({ type: 'send', nodeId: 'r:root', text: 'olhe', attachments: ['/a'] });
    expect(parseWebviewMessage({ type: 'send', nodeId: 'r:root', text: '', attachments: ['/a'] })).toEqual({ type: 'send', nodeId: 'r:root', text: '', attachments: ['/a'] });
    expect(parseWebviewMessage({ type: 'send', nodeId: 'r:root', text: '   ' })).toBeNull();
    expect(parseWebviewMessage({ type: 'send', nodeId: 'r:root', text: 'x', attachments: [3] })).toBeNull();
  });

  it('pasteImage aceita só imagens conhecidas, base64 e tamanho limitado', () => {
    const ok = { type: 'pasteImage', requestId: 'a', mime: 'image/png', data: 'aGVsbG8=' };
    expect(parseWebviewMessage(ok)).toEqual(ok);
    expect(parseWebviewMessage({ ...ok, mime: 'text/html' })).toBeNull();
    expect(parseWebviewMessage({ ...ok, data: 'não é base64!' })).toBeNull();
    expect(parseWebviewMessage({ ...ok, data: '' })).toBeNull();
    expect(parseWebviewMessage({ ...ok, requestId: '' })).toBeNull();
    expect(parseWebviewMessage({ ...ok, data: 'A'.repeat(MAX_PASTE_BASE64 + 4) })).toBeNull();
  });

  it('pickFiles, listClis e listCapabilities', () => {
    expect(parseWebviewMessage({ type: 'pickFiles', requestId: 'abc' })).toEqual({ type: 'pickFiles', requestId: 'abc' });
    for (const requestId of ['', 5, undefined, 'x'.repeat(101)]) expect(parseWebviewMessage({ type: 'pickFiles', requestId })).toBeNull();
    expect(parseWebviewMessage({ type: 'listClis' })).toEqual({ type: 'listClis' });
    expect(parseWebviewMessage({ type: 'listCapabilities' })).toEqual({ type: 'listCapabilities' });
  });

  it('mensagens da configuração inicial dos CLIs', () => {
    expect(parseWebviewMessage({ type: 'recheckCli' })).toEqual({ type: 'recheckCli' });
    expect(parseWebviewMessage({ type: 'recheckCli', cli: 'codex' })).toEqual({ type: 'recheckCli', cli: 'codex' });
    expect(parseWebviewMessage({ type: 'recheckCli', cli: 'x' })).toBeNull();
    for (const type of ['installCli', 'loginCli', 'pickCliPath']) {
      expect(parseWebviewMessage({ type, cli: 'claude' })).toEqual({ type, cli: 'claude' });
      expect(parseWebviewMessage({ type })).toBeNull();
      expect(parseWebviewMessage({ type, cli: 'bash' })).toBeNull();
    }
  });

  it('anexo com separadores de linha unicode ou marcas de direção no caminho é rejeitado', () => {
    for (const bad of ['/a\u2028b', '/a\u2029b', '/a\u0085b', '/a\u202Eb', '/a\u2066b']) {
      expect(parseWebviewMessage({ type: 'send', nodeId: 'r:root', text: 'x', attachments: [bad] })).toBeNull();
    }
  });
});

describe('describeRejected (aviso quando o host descarta uma mensagem da Webview)', () => {
  it('start/send/spawn/rename inválidos geram um aviso em português; outros tipos e lixo, nada', () => {
    for (const t of ['start', 'send', 'spawn', 'rename']) expect(describeRejected({ type: t })).toMatch(/não foi enviada|inválid/i);
    expect(describeRejected({ type: 'send', attachments: ['/a\u2028b'] })).toMatch(/anexo/i);
    for (const raw of [null, 5, 'x', {}, { type: 'ready' }, { type: 'inspect' }, { type: 'moveNode' }]) expect(describeRejected(raw)).toBeNull();
  });

  it('setOptions: runId + opções válidas; {} ou ausente limpa; inválido é rejeitado', () => {
    expect(parseWebviewMessage({ type: 'setOptions', runId: 'r1', options: { model: 'opus', effort: 'high' } })).toEqual({ type: 'setOptions', runId: 'r1', options: { model: 'opus', effort: 'high' } });
    expect(parseWebviewMessage({ type: 'setOptions', runId: 'r1', options: { sandbox: 'read-only' } })).toEqual({ type: 'setOptions', runId: 'r1', options: { sandbox: 'read-only' } });
    expect(parseWebviewMessage({ type: 'setOptions', runId: 'r1', options: {} })).toEqual({ type: 'setOptions', runId: 'r1', options: {} });
    expect(parseWebviewMessage({ type: 'setOptions', runId: 'r1' })).toEqual({ type: 'setOptions', runId: 'r1', options: {} });
    for (const bad of [{ model: '--x' }, { effort: 'bogus' }, { sandbox: 'rm' }, 'x', 5]) expect(parseWebviewMessage({ type: 'setOptions', runId: 'r1', options: bad })).toBeNull();
    for (const runId of [undefined, '', 5, 'x'.repeat(301)]) expect(parseWebviewMessage({ type: 'setOptions', runId, options: {} })).toBeNull();
  });
});
