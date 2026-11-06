import { createInterface } from 'node:readline';

function send(frame) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n'); }
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (frame.method === 'session/new') send({ id: frame.id, result: { sessionId: 'desktop-regression' } });
  else if (frame.method === 'session/close') send({ id: frame.id, result: {} });
  else if (frame.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'desktop-regression', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({
        electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
        launchMarker: process.env.DSH_TEST_LAUNCH_MARKER,
        sessionMarker: process.env.DSH_TEST_SESSION_MARKER,
      }) },
    } } });
    send({ id: frame.id, result: { stopReason: 'end_turn' } });
  }
}
