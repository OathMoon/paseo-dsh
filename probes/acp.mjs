// Requires the sibling DSH checkout and installed development dependencies.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import contribute from '../index.server.ts'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const dsh = path.resolve(plugin, '../deepseek-harness')
const root = await mkdtemp(path.join(process.env.PASEO_DSH_PROBE_DIR ?? tmpdir(), 'paseo-dsh-probe-'))
const workspace = path.join(root, 'requested workspace')
await mkdir(workspace)
console.log({ root, processDirectory: process.cwd(), workspace })
const fixture = path.join(dsh, 'apps/cli/tests/profiles/acp/tests/fixtures/control-surface')
const patch = path.join(root, 'cordis.yml')
await writeFile(patch, (await readFile(path.join(fixture, 'cordis.yml'), 'utf8'))
  .replace('./control-surface-llm.ts', pathToFileURL(path.join(fixture, 'control-surface-llm.ts')).href))
const args = [path.join(dsh, 'apps/cli/lib/bin.js'), '--profile', 'acp', '--patch', patch]
const env = {
  ...process.env, DSH_TELEMETRY_DISABLED: "1", DSH_HOME: path.join(root, 'home'), DSH_AGENTS_HOME: path.join(root, 'agents'),
  DSH_CONFORMANCE_PERSISTENCE_ROOT: path.join(root, 'sessions'),
}
let provider
contribute({ registerProvider(registration) { provider = registration } })
const connection = await provider.connect({
  launch: { command: process.execPath, args, env }, versions: [1],
  capabilities: ['prompt.message', 'session.list', 'permission', 'session.persistence', 'session.configure'],
})
console.log(connection.capabilities)
const events = []
connection.onEvent(event => { events.push(event); console.log(JSON.stringify(event)) })
async function until(predicate) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const failure = events.find(e => e.type === 'request.failed' || e.type === 'session.runtime_failed')
    if (failure) throw Error(JSON.stringify(failure))
    const event = events.find(predicate)
    if (event) return event
    await delay(40)
  }
  throw Error('Timed out waiting for provider event')
}
try {
  const sessionId = 'probe'
  const mcpServers = { fixture: { type: 'stdio', command: process.execPath,
    args: [path.join(dsh, 'packages/mcp/mcp-client/tests/fixture-server.ts')] } }
  await connection.send({ type: 'session.open', sessionId, requestId: 'open', history: 'skip',
    config: { cwd: workspace, env: {}, mcpServers, settings: {}, persist: true } })
  await until(e => e.type === 'session.ready')
  await connection.send({ type: 'session.prompt', sessionId, prompt: { clientMessageId: 'one',
    delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'exercise the attached server' }] } } })
  const end = await until(e => e.type === 'session.turn' && e.state !== 'started')
  assert.equal(end.state, 'completed')
  assert.ok(events.some(e => e.type === 'timeline.item' && e.item.type === 'assistant_message' && e.item.text.includes('tool=5')))
  assert.ok(events.some(e => e.type === 'timeline.item' && e.item.type === 'tool_call' && e.item.status === 'completed' && e.item.detail.output === '5'))
  await connection.send({ type: 'session.close', sessionId, requestId: 'close' })
  await until(e => e.type === 'session.closed')
  await connection.send({ type: 'sessions', cwd: workspace, requestId: 'list' })
  const listed = await until(e => e.type === 'sessions')
  const opened = events.find(e => e.type === 'session.opened')
  assert.ok(listed.sessions.some(s => s.cwd === workspace && s.persistence.data.sessionId === opened.persistence.data.sessionId))
} finally {
  await connection.close()
}


