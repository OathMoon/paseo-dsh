import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import contribute from '../index.server.ts'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
let registration
contribute({ registerProvider(provider) { registration = provider } })
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-permission-probe-'))
const responses = path.join(scratch, 'outcomes.jsonl')
const connection = await registration.connect({
  launch: { command: process.execPath, args: [path.join(root, 'probes/fixtures/permission-agent.mjs')],
    env: { ...env, DSH_PERMISSION_RESPONSES: responses, DSH_PERMISSION_SNAPSHOT: path.resolve(root, '../deepseek-harness/snapshots/acp/escalation-rejected/stdout.expected.jsonl') } },
  versions: [1], capabilities: ['prompt.message', 'permission'],
})
const events = []
connection.onEvent(event => events.push(event))
async function until(predicate, start = 0) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const next = events.slice(start)
    const failed = next.find(event => event.type === 'request.failed' || event.type === 'session.runtime_failed')
    if (failed) throw Error(JSON.stringify(failed))
    const found = next.find(predicate)
    if (found) return found
    await delay(20)
  }
  throw Error('Missing expected provider event')
}
try {
  await connection.send({ type: 'session.open', sessionId: 's', requestId: 'open', history: 'skip',
    config: { cwd: root, mcpServers: {}, env: {}, settings: {}, persist: true } })
  await until(event => event.type === 'session.ready')
  for (const [text, behavior, selectedActionId] of [
    ['missing input', 'deny', 'reject-once'], ['explicit input', 'allow', 'allow-once'],
  ]) {
    const start = events.length
    await connection.send({ type: 'session.prompt', sessionId: 's', prompt: {
      clientMessageId: text, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] },
    } })
    const permission = await until(event => event.type === 'session.permission', start)
    assert.deepEqual(permission.request.input, text === 'missing input' ? {} : { marker: 'explicit' })
    await connection.send({ type: 'session.permission', sessionId: 's', permissionId: permission.request.id,
      response: { behavior, selectedActionId } })
    await until(event => event.type === 'session.turn' && event.state === 'completed', start)
    const reply = events.slice(start).find(event => event.type === 'timeline.item' && event.item.type === 'assistant_message')
    assert.equal(JSON.parse(reply.item.text).outcome.optionId, selectedActionId)
  }
  const start = events.length
  await connection.send({ type: 'session.prompt', sessionId: 's', prompt: {
    clientMessageId: 'cancel', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'cancel pending' }] },
  } })
  const pending = await until(event => event.type === 'session.permission', start)
  await connection.send({ type: 'session.interrupt', sessionId: 's', requestId: 'stop' })
  await until(event => event.type === 'session.turn' && event.state === 'canceled', start)
  const end = events.slice(start)
  assert.equal(end.filter(event => event.type === 'session.turn' && event.state === 'canceled').length, 1)
  const resolvedIndex = end.findIndex(event => event.type === 'session.permission_resolved')
  const canceledIndex = end.findIndex(event => event.type === 'session.turn' && event.state === 'canceled')
  assert.ok(resolvedIndex >= 0)
  assert.ok(resolvedIndex < canceledIndex)
  await connection.send({ type: 'session.permission', sessionId: 's', permissionId: pending.request.id,
    response: { behavior: 'allow', selectedActionId: 'allow-once' } })
  const deadline = Date.now() + 3000
  let outcomes = []
  while (Date.now() < deadline) {
    outcomes = (await readFile(responses, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
    if (outcomes.length === 3) break
    await delay(20)
  }
  assert.deepEqual(outcomes.map(value => value.outcome), [
    { outcome: 'selected', optionId: 'reject-once' },
    { outcome: 'selected', optionId: 'allow-once' },
    { outcome: 'cancelled' },
  ])
  console.log(`PASS: missing/explicit inputs, allow/deny IDs, one canceled turn, resolved before terminal, late reply ignored. Artifacts: ${scratch}`)
} finally { await connection.close() }
