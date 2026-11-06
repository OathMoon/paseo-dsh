import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import contribute from '../index.server.ts'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const dsh = path.resolve(plugin, '../deepseek-harness')
const root = await mkdtemp(path.join(tmpdir(), 'paseo-dsh-history-'))
const cwd = path.join(root, 'workspace')
const wrongCwd = path.join(root, 'other workspace')
await mkdir(cwd)
await mkdir(wrongCwd)
console.log(`Artifacts: ${root}`)
const fixture = path.join(dsh, 'apps/cli/tests/profiles/acp/tests/fixtures/control-surface')
const patch = path.join(root, 'fixture.yml')
const adapterPath = path.join(fixture, 'control-surface-llm.ts')
const fixtureRequire = createRequire(adapterPath)
const adapter = path.join(root, 'history-model.ts')
await writeFile(adapter, (await readFile(adapterPath, 'utf8'))
  .replace("'@deepseek-ai/dsh-llm'", JSON.stringify(pathToFileURL(fixtureRequire.resolve('@deepseek-ai/dsh-llm')).href))
  .replace("'control-add'", '`control-add-${options.messages.length}`')
  .replace('const text = `model=${options.model}; tool=5`', 'const memory = options.messages.filter(m => m.role === "user" && m.source?.kind === "user").flatMap(m => m.content).filter(b => b.type === "text").map(b => b.text).find(t => t.startsWith("remember ")) ?? "missing"; const text = `model=${options.model}; tool=5; memory=${memory}`'))
await writeFile(patch, (await readFile(path.join(fixture, 'cordis.yml'), 'utf8')).replace('./control-surface-llm.ts', pathToFileURL(adapter).href))
const launch = { command: process.execPath, args: [path.join(dsh, 'apps/cli/lib/bin.js'), '--profile', 'acp', '--patch', patch], env: {
  ...process.env, DSH_HOME: path.join(root, 'home'), DSH_AGENTS_HOME: path.join(root, 'agents'),
  DSH_CONFORMANCE_PERSISTENCE_ROOT: path.join(root, 'sessions'), DSH_TELEMETRY_DISABLED: '1',
} }
let provider
contribute({ registerProvider(value) { provider = value } })
const config = { cwd, env: {}, settings: {}, persist: true, mcpServers: { fixture: { type: 'stdio', command: process.execPath,
  args: [path.join(dsh, 'packages/mcp/mcp-client/tests/fixture-server.ts')] } } }
let connection
let events
async function connect() {
  connection = await provider.connect({ launch, versions: [1], capabilities: ['prompt.message', 'session.persistence', 'session.configure', 'permission'] })
  console.log(`Negotiated: ${connection.capabilities.join(', ')}`)
  events = []
  connection.onEvent(event => events.push(event))
}
async function until(predicate, start = 0) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const failed = events.slice(start).find(e => e.type === 'request.failed' || e.type === 'session.runtime_failed')
    if (failed) throw Error(JSON.stringify(failed))
    const result = events.slice(start).find(predicate)
    if (result) return result
    await delay(20)
  }
  throw Error('Missing history verification event')
}
async function open(persistence, history = 'replay') {
  await connection.send({ type: 'session.open', sessionId: 'history', requestId: 'open', history, config, ...(persistence ? { persistence } : {}) })
  await until(e => e.type === 'session.ready')
  return events.find(e => e.type === 'session.opened').persistence
}
async function prompt(text) {
  const start = events.length
  await connection.send({ type: 'session.prompt', sessionId: 'history', prompt: { clientMessageId: text, delivery: 'auto', input: {
    type: 'message', content: [{ type: 'text', text }],
  } } })
  const result = await until(e => e.type === 'session.turn' && e.state !== 'started', start)
  assert.equal(result.state, 'completed')
}
function assertHistory(turns) {
  const items = new Map(events.filter(e => e.type === 'timeline.item').map(e => [e.item.id, e.item]))
  assert.equal([...items.values()].filter(i => i.type === 'user_message').length, turns)
  assert.equal([...items.values()].filter(i => i.type === 'assistant_message' && i.text.includes('model=alpha; tool=5')).length, turns)
  assert.ok([...items.values()].some(i => i.type === 'tool_call' && i.status === 'completed' && i.detail.output === '5'))
  assert.equal([...items.values()].filter(i => i.type === 'tool_call' && i.status === 'completed').length, turns)
}
try {
  await connect()
  const original = await open(undefined, 'skip')
  const memory = `remember ${randomUUID()}`
  await prompt(memory)
  await connection.close()
  await connect()
  const restored = await open(original)
  assert.deepEqual(restored, original)
  assertHistory(1)
  const secondStart = events.length
  await prompt('second history addition')
  assert.ok(events.slice(secondStart).some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text.includes(memory)))
  await connection.close()
  await connect()
  const again = await open(original)
  assert.deepEqual(again, original)
  assertHistory(2)
  await writeFile(path.join(root, 'events.json'), JSON.stringify(events, null, 2))
  await connection.send({ type: 'session.close', sessionId: 'history', requestId: 'close' })
  await until(e => e.type === 'session.closed')
  for (const [requestId, persistence, target] of [
    ['wrong-cwd', original, wrongCwd],
    ['missing-session', { version: 1, data: { sessionId: '00000000-0000-4000-8000-000000000000' } }, cwd],
  ]) {
    await connection.send({ type: 'session.open', sessionId: requestId, requestId, history: 'replay', persistence, config: { ...config, cwd: target } })
    const deadline = Date.now() + 90000
    while (!events.some(e => e.type === 'request.failed' && e.requestId === requestId) && Date.now() < deadline) await delay(20)
    assert.ok(events.some(e => e.type === 'request.failed' && e.requestId === requestId), `${requestId} must fail explicitly`)
    assert.ok(!events.some(e => e.type === 'session.opened' && e.sessionId === requestId))
  }
  console.log('PASS: native UUID preserved, two process restarts, complete user/assistant/tool history, another turn, invalid handles/cwd rejected.')
} finally { await connection?.close() }
