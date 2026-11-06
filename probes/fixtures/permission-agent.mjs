import { createInterface } from 'node:readline'
import { readFile, appendFile } from 'node:fs/promises'

const snapshot = await readFile(process.env.DSH_PERMISSION_SNAPSHOT, 'utf8')
const request = snapshot.trim().split(/\r?\n/).map(line => JSON.parse(line))
  .find(frame => frame.method === 'session/request_permission')
let promptId
let permissionId = 42
let withdrawn = false
function send(frame) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n') }
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line)
  if (frame.method === 'initialize') send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  else if (frame.method === 'session/new') send({ id: frame.id, result: { sessionId: 'native-snapshot' } })
  else if (frame.method === 'session/close') send({ id: frame.id, result: {} })
  else if (frame.method === 'session/prompt') {
    promptId = frame.id
    permissionId++
    withdrawn = false
    const explicit = frame.params.prompt.some(block => block.text === 'explicit input')
    send({ ...request, id: permissionId, params: { ...request.params, sessionId: 'native-snapshot',
      toolCall: { ...request.params.toolCall, toolCallId: `snapshot-${permissionId}`, ...(explicit ? { rawInput: { marker: 'explicit' } } : {}) } } })
  } else if (frame.method === 'session/cancel') {
    withdrawn = true
    send({ id: promptId, result: { stopReason: 'cancelled' } })
  } else if (frame.id === permissionId && frame.result) {
    if (process.env.DSH_PERMISSION_RESPONSES) await appendFile(process.env.DSH_PERMISSION_RESPONSES, JSON.stringify(frame.result) + '\n')
    if (withdrawn) continue
    send({ method: 'session/update', params: { sessionId: 'native-snapshot', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(frame.result) },
    } } })
    send({ id: promptId, result: { stopReason: 'end_turn' } })
  }
}
