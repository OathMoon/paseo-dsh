import contribute from '../../index.server.ts';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

let registration;
contribute({ registerProvider(provider) { registration = provider; } });
const launchEnv = { ...process.env, DSH_TEST_LAUNCH_MARKER: 'daemon launch value' };
delete launchEnv.ELECTRON_RUN_AS_NODE;
let connection;
const events = [];
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const failed = events.find(event => event.type === 'request.failed' || event.type === 'session.runtime_failed');
    if (failed) throw Error(JSON.stringify(failed));
    const found = events.find(predicate);
    if (found) return found;
    await delay(10);
  }
  throw Error('Desktop provider did not reach the expected event');
}
try {
  connection = await registration.connect({ versions: [1], capabilities: ['prompt.message'], launch: {
    command: process.argv[2], args: [fileURLToPath(new URL('./desktop-agent.mjs', import.meta.url))], env: launchEnv,
  } });
  connection.onEvent(event => events.push(event));
  await connection.send({ type: 'session.open', sessionId: 's', requestId: 'open', history: 'skip', config: {
    cwd: process.cwd(), env: { DSH_TEST_SESSION_MARKER: 'per session value' }, mcpServers: {}, settings: {}, persist: false,
  } });
  await until(event => event.type === 'session.ready');
  await connection.send({ type: 'session.prompt', sessionId: 's', prompt: {
    clientMessageId: 'one', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'inspect environment' }] },
  } });
  await until(event => event.type === 'session.turn' && event.state === 'completed');
  const reply = events.find(event => event.type === 'timeline.item' && event.item.type === 'assistant_message');
  console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, target: JSON.parse(reply.item.text) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { await connection?.close(); }
