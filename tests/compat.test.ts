import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acpBridge } from '../server/bridge.ts';

const fixture = fileURLToPath(new URL('./fixtures/stdio-agent.mjs', import.meta.url));

async function exchange({
  messages,
  mode = 'roundtrip',
  command = process.execPath,
  args = [fixture, mode, 'argument with spaces'],
  originalElectronRunAsNode,
}: {
  messages: unknown[];
  mode?: string;
  command?: string;
  args?: string[];
  originalElectronRunAsNode?: string | null;
}) {
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', `(${acpBridge.toString()})(${originalElectronRunAsNode === undefined ? '' : JSON.stringify(originalElectronRunAsNode)})`, '--', command, ...args,
  ], {
    stdio: 'pipe', windowsHide: true,
    env: { ...process.env, DSH_BRIDGE_TEST_MARKER: 'session environment value', ...(originalElectronRunAsNode !== undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', error => {
    if (!('code' in error) || error.code !== 'EPIPE') throw error;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const timer = setTimeout(() => { child.kill(); }, 10_000);
  try {
    child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
    const code = await closed;
    assert.notEqual(code, null, `bridge was killed or timed out: ${stderr}`);
    const frames: unknown[] = stdout.trim() === '' ? [] : stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    return { code, frames, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function emit(...frames: unknown[]) {
  return { jsonrpc: '2.0', method: 'fixture/emit', params: { frames } };
}

for (const original of [null, '0', '1']) {
  test(`the bridge restores the target Electron flag to ${JSON.stringify(original)}`, async () => {
    const result = await exchange({ originalElectronRunAsNode: original,
      messages: [{ jsonrpc: '2.0', id: 'env', method: 'fixture/inspect-electron' }],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.frames, [{ jsonrpc: '2.0', id: 'env', result: { electronRunAsNode: original, marker: 'session environment value' } }]);
  });
}

test('missing permission rawInput becomes an empty object without changing actions or request IDs', async () => {
  const request = {
    jsonrpc: '2.0', id: 43, method: 'session/request_permission',
    params: {
      sessionId: 'native-session', toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
    },
  };
  const result = await exchange({ messages: [emit(request)] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, [{
    ...request, params: { ...request.params, toolCall: { ...request.params.toolCall, rawInput: {} } },
  }]);
});

test('explicit permission inputs pass through unchanged', async () => {
  const requests = [{ path: 'file with spaces' }, null, 'explicit scalar'].map((rawInput, id) => ({
    jsonrpc: '2.0', id, method: 'session/request_permission',
    params: { sessionId: 's', toolCall: { toolCallId: `call-${id}`, rawInput }, options: [] },
  }));
  const result = await exchange({ messages: [emit(...requests)] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, requests);
});

test('tool text content reaches rawOutput and existing rawOutput stays authoritative', async () => {
  const update = {
    sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '5' } }],
  };
  const notification = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } };
  const explicit = {
    ...notification, params: { ...notification.params, update: { ...update, rawOutput: { value: 7 } } },
  };
  const result = await exchange({ messages: [emit(notification, explicit)] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, [{
    ...notification, params: { ...notification.params, update: { ...update, rawOutput: '5' } },
  }, explicit]);
});

test('failed tools retain real error content', async () => {
  const update = {
    sessionUpdate: 'tool_call_update', toolCallId: 'failed', status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'permission denied by fixture' } }],
  };
  const frame = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } };
  const result = await exchange({ messages: [emit(frame)] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, [{
    ...frame, params: { ...frame.params, update: { ...update, rawOutput: 'permission denied by fixture' } },
  }]);
});

test('failed tools without content still have a usable error', async () => {
  const frame = {
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'failed', status: 'failed' } },
  };
  const result = await exchange({ messages: [emit(frame)] });
  assert.equal(result.code, 0, result.stderr);
  const [response] = result.frames;
  assert.ok(response && typeof response === 'object' && 'params' in response);
  const params = response.params;
  assert.ok(params && typeof params === 'object' && 'update' in params);
  const update = params.update;
  assert.ok(update && typeof update === 'object' && 'rawOutput' in update);
  assert.ok(update.rawOutput !== null && update.rawOutput !== undefined && update.rawOutput !== '');
});

test('failed tools with empty content still have a readable error', async () => {
  const frame = {
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'empty-failed', status: 'failed', content: [] } },
  };
  const result = await exchange({ messages: [emit(frame)] });
  assert.equal(result.code, 0, result.stderr);
  const [response] = result.frames;
  assert.ok(response && typeof response === 'object' && 'params' in response);
  const params = response.params;
  assert.ok(params && typeof params === 'object' && 'update' in params);
  const update = params.update;
  assert.ok(update && typeof update === 'object' && 'rawOutput' in update);
  assert.ok(update.rawOutput !== null && update.rawOutput !== undefined && update.rawOutput !== '');
});

test('non-text tool content remains inspectable and explicit null output is preserved', async () => {
  const content = { type: 'resource_link', name: 'report', uri: 'file:///report.txt' };
  const update = {
    sessionUpdate: 'tool_call_update', toolCallId: 'resource', status: 'completed', content: [content],
  };
  const frame = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } };
  const explicit = { ...frame, params: { ...frame.params, update: { ...update, rawOutput: null } } };
  const result = await exchange({ messages: [emit(frame, explicit)] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, [{
    ...frame, params: { ...frame.params, update: { ...update, rawOutput: JSON.stringify(content) } },
  }, explicit]);
});

test('permission decisions and cancel frames cross both pipes without remapping', async () => {
  const frames = [
    { jsonrpc: '2.0', id: 'approve', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
    { jsonrpc: '2.0', id: 44, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    { jsonrpc: '2.0', id: 45, result: { outcome: { outcome: 'cancelled' } } },
    { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'native-session' } },
  ];
  const result = await exchange({ messages: frames });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, frames);
});

test('launch arguments and session environment remain visible to the target', async () => {
  const result = await exchange({ messages: [{ jsonrpc: '2.0', id: 'inspect', method: 'fixture/inspect' }] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, [{
    jsonrpc: '2.0', id: 'inspect',
    result: { argv: ['roundtrip', 'argument with spaces'], marker: 'session environment value' },
  }]);
});

test('Windows command-script paths and arguments with spaces survive launch', {
  skip: process.platform !== 'win32',
}, async () => {
  const command = fileURLToPath(new URL('./fixtures/stdio agent.cmd', import.meta.url));
  const result = await exchange({
    command, args: ['roundtrip', 'argument with spaces'],
    messages: [{ jsonrpc: '2.0', id: 'cmd-inspect', method: 'fixture/inspect' }],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.frames, [{
    jsonrpc: '2.0', id: 'cmd-inspect',
    result: { argv: ['roundtrip', 'argument with spaces'], marker: 'session environment value' },
  }]);
});

test('stderr remains separate and the final frame survives EOF without a newline', async () => {
  const result = await exchange({ mode: 'final-line', messages: [{
    jsonrpc: '2.0', method: 'fixture/stderr', params: { text: 'fixture diagnostic\n' },
  }] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, 'fixture diagnostic\n');
  assert.deepEqual(result.frames, [{ jsonrpc: '2.0', id: 'final', result: 'EOF' }]);
});

test('target failure exits nonzero with no fabricated protocol response', async () => {
  const result = await exchange({ mode: 'nonzero', messages: [] });
  assert.equal(result.code, 23, result.stderr);
  assert.deepEqual(result.frames, []);
});

test('missing executable reports failure on stderr', async () => {
  const result = await exchange({ command: `${process.execPath}.does-not-exist`, args: [], messages: [] });
  assert.notEqual(result.code, 0);
  assert.notEqual(result.stderr.trim(), '');
  assert.deepEqual(result.frames, []);
});
