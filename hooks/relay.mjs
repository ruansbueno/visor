// Executado pelos hooks do claude. Regra de ouro: nunca atrapalhar a sessão do usuário.
// Sempre sai com 0 e nunca escreve em stdout (stdout de hook pode ser interpretado pelo CLI).
import net from 'node:net';

const pipe = process.env.VISOR_PIPE;
const runId = process.env.VISOR_RUN_ID;
let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  if (!pipe || !runId) process.exit(0);
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const bail = setTimeout(() => process.exit(0), 1000);
  const sock = net.connect(pipe);
  sock.on('error', () => process.exit(0));
  sock.end(JSON.stringify({ runId, payload }) + '\n', () => {
    clearTimeout(bail);
    process.exit(0);
  });
});
