import { createInterface } from 'node:readline';

const mode = process.argv[2];
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.trim() === '') continue;
  const message = JSON.parse(line);
  if (message.method === 'fixture/emit') {
    for (const frame of message.params.frames) process.stdout.write(`${JSON.stringify(frame)}\n`);
  } else if (message.method === 'fixture/inspect') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: { argv: process.argv.slice(2), marker: process.env.DSH_BRIDGE_TEST_MARKER },
    })}\n`);
  } else if (message.method === 'fixture/stderr') {
    process.stderr.write(message.params.text);
  } else if (message.method === 'fixture/inspect-electron') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, marker: process.env.DSH_BRIDGE_TEST_MARKER,
    } }) + '\n');
  } else {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}
if (mode === 'final-line') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'final', result: 'EOF' }));
if (mode === 'nonzero') process.exitCode = 23;
