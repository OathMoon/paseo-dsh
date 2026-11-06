import { createRequire } from 'node:module'
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [originalFixture, marker] = process.argv.slice(2)
const require = createRequire(pathToFileURL(originalFixture))
const { McpServer } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/server')))
const { serveStdio } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')))
const { z } = await import(pathToFileURL(require.resolve('zod')))

serveStdio(() => {
  const server = new McpServer({ name: 'controlled-add', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('add', {
    title: 'Controlled Add',
    description: 'Adds two numbers.',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
  }, async args => {
    if (process.env.DSH_SLOW_TOOL === '1') {
      await appendFile(marker, JSON.stringify({ pid: process.pid, state: 'running' }) + '\n')
      await delay(60_000)
    }
    return { content: [{ type: 'text', text: String(args.a + args.b) }] }
  })
  return server
})
