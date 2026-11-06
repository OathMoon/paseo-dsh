import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyDshHistory } from '../server/dsh-history.mjs';

type Stream = { readable: ReadableStream<unknown>; writable: WritableStream<unknown> };

async function harness(events: unknown[] = [], failRead = false) {
  let enqueue: (frame: unknown) => void = () => { throw new Error('Input stream not ready'); };
  const frames: unknown[] = [];
  const opened: unknown[] = [];
  let closed = 0;
  const streams: Stream[] = [];
  const transport: Stream = {
    readable: new ReadableStream({ start(controller) { enqueue = frame => controller.enqueue(frame); } }),
    writable: new WritableStream({ write(frame) { frames.push(frame); } }),
  };
  await applyDshHistory({
    get: () => undefined,
    logger: { warn() {} },
    sessionPersistence: {
      async open(id: string, mode: string) {
        opened.push({ id, mode });
        return {
          async read() { if (failRead) throw new Error('read failure'); return { events }; },
          async close() { closed++; },
        };
      },
    },
  }, { stream: transport }, { apply(_ctx: unknown, config: { stream: Stream }) { streams.push(config.stream); } }, {
    resolve(name: string) {
      if (name === '@deepseek-ai/dsh-session') {
        return createRequire(fileURLToPath(new URL('../../deepseek-harness/apps/cli/lib/bin.js', import.meta.url))).resolve(name);
      }
      return createRequire(import.meta.url).resolve(name);
    },
  });
  const stream = streams[0];
  assert.ok(stream);
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  return {
    frames, opened, get closed() { return closed; },
    async send(frame: unknown) {
      const read = reader.read();
      enqueue(frame);
      return (await read).value;
    },
    receive: (frame: unknown) => writer.write(frame),
    async initialize(agentCapabilities: object) {
      await this.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      await this.receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities } });
    },
    async close() { await reader.cancel(); await writer.close(); },
  };
}

test('history compatibility advertises load only for an agent that can really resume', async () => {
  for (const capabilities of [{}, { sessionCapabilities: { resume: {} } }, { loadSession: true }]) {
    const h = await harness();
    try {
      await h.initialize(capabilities);
      assert.deepEqual(h.frames, [{ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities:
        'sessionCapabilities' in capabilities ? { ...capabilities, loadSession: true } : capabilities } }]);
    } finally { await h.close(); }
  }
});

test('an existing native load implementation remains authoritative', async () => {
  const h = await harness();
  try {
    await h.initialize({ loadSession: true, sessionCapabilities: { resume: {} } });
    const frame = { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's', cwd: '/workspace', mcpServers: [] } };
    assert.deepEqual(await h.send(frame), frame);
    await h.receive({ jsonrpc: '2.0', id: 2, result: {} });
    assert.deepEqual(h.opened, []);
  } finally { await h.close(); }
});

test('failed native resume preserves its error without reading or replaying history', async () => {
  const h = await harness();
  try {
    await h.initialize({ sessionCapabilities: { resume: {} } });
    const params = { sessionId: 's', cwd: '/wrong', mcpServers: [] };
    assert.deepEqual(await h.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params }),
      { jsonrpc: '2.0', id: 2, method: 'session/resume', params });
    const error = { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'cwd mismatch' } };
    await h.receive(error);
    assert.deepEqual(h.frames.at(-1), error);
    assert.deepEqual(h.opened, []);
  } finally { await h.close(); }
});

test('a failed history read closes its handle and cannot return successful load', async () => {
  const h = await harness([], true);
  try {
    await h.initialize({ sessionCapabilities: { resume: {} } });
    await h.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's' } });
    await h.receive({ jsonrpc: '2.0', id: 2, result: { configOptions: [] } });
    assert.deepEqual(h.opened, [{ id: 's', mode: 'read' }]);
    assert.equal(h.closed, 1);
    assert.deepEqual(h.frames.at(-1), { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Unable to replay persisted DSH session history' } });
  } finally { await h.close(); }
});

test('history replay preserves user, thought, tool and answer order before the load response', async () => {
  const h = await harness([
    { type: 'user/message', data: { id: 'system-injected', source: { kind: 'system' }, content: [{ type: 'text', text: 'not a user' }] } },
    { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'reasoning', text: 'checking' }] } } },
    { type: 'tool/call', data: { callId: 't1', name: 'read', arguments: '{"path":"marker"}' } },
    { type: 'tool/result', data: { message: { toolCallId: 't1', source: { kind: 'tool', callId: 't1' }, isError: false, content: [{ type: 'text', text: 'value' }] } } },
    { type: 'assistant/message', data: { message: { id: 'a2', content: [{ type: 'text', text: 'answer' }] } } },
  ]);
  try {
    await h.initialize({ sessionCapabilities: { resume: {} } });
    await h.send({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 's' } });
    const result = { jsonrpc: '2.0', id: 2, result: { configOptions: [] } };
    await h.receive(result);
    const updates = [
      { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'hello' } },
      { sessionUpdate: 'agent_thought_chunk', messageId: 'a1', content: { type: 'text', text: 'checking' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', kind: 'other', status: 'in_progress', rawInput: { path: 'marker' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'value' } }] },
      { sessionUpdate: 'agent_message_chunk', messageId: 'a2', content: { type: 'text', text: 'answer' } },
    ];
    assert.deepEqual(h.frames.slice(1), [...updates.map(update => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } })), result]);
    assert.equal(h.closed, 1);
  } finally { await h.close(); }
});
