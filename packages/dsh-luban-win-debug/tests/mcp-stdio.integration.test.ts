import { describe, expect, it } from 'vitest'
import { NodeStdioMcpClient } from '../src/mcp-stdio.js'

const MCP_SERVER_SOURCE = `
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let initialized = false
let ready = false
let listed = false
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const success = (id, result) => send({ jsonrpc: '2.0', id, result })
const failure = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })

lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method === 'initialize') {
    initialized = true
    success(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'm10-real-stdio-fixture', version: '1.0.0' },
    })
    return
  }
  if (message.method === 'notifications/initialized') {
    ready = initialized
    return
  }
  if (message.method === 'tools/list') {
    if (!ready) {
      failure(message.id, 'client did not initialize')
      return
    }
    listed = true
    success(message.id, {
      tools: [
        {
          name: 'desktop.echo',
          description: 'Echo one text value',
          inputSchema: { type: 'object' },
        },
      ],
    })
    return
  }
  if (message.method === 'tools/call') {
    if (!ready || !listed) {
      failure(message.id, 'tool discovery did not complete')
      return
    }
    const text = message.params?.arguments?.text
    success(message.id, {
      content: [
        {
          type: 'text',
          text: 'initialized=' + String(ready) + ';listed=' + String(listed) + ';echo=' + String(text),
        },
      ],
      isError: false,
    })
    return
  }
  if (message.id !== undefined) failure(message.id, 'unsupported method')
})
`.trim()

describe('real Node stdio MCP integration', (): void => {
  it('initializes, discovers, calls, and stops a child process', async (): Promise<void> => {
    const client = new NodeStdioMcpClient()
    try {
      await client.connect({
        command: process.execPath,
        args: ['--input-type=module', '--eval', MCP_SERVER_SOURCE],
        allowedTools: ['desktop.echo'],
        startupTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        processLifetimeMs: 30_000,
        maxMessageBytes: 64 * 1024,
      })

      expect(client.connected).toBe(true)
      expect(client.pid).toEqual(expect.any(Number))
      expect(client.advertisedTools).toEqual(['desktop.echo'])
      await expect(client.call('desktop.echo', { text: 'hello' })).resolves.toBe(
        'initialized=true;listed=true;echo=hello',
      )

      await client.stop()
      expect(client.connected).toBe(false)
      expect(client.pid).toBeUndefined()
      expect(client.advertisedTools).toEqual([])
    } finally {
      await client.stop().catch((): void => undefined)
    }
  })
})
