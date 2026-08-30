import { createServer, type Server, type Socket } from 'node:net'
import type { ChannelDataEvent, ChannelHandle } from '@luban/core'
import { describe, expect, it } from 'vitest'
import { NodeSocketConnector, TcpChannelAdapter } from '../src/channels.js'

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject): void => {
    const failed = (error: Error): void => reject(error)
    server.once('error', failed)
    server.listen({ host: '127.0.0.1', port: 0 }, (): void => {
      server.off('error', failed)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('loopback server did not expose a TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject): void => {
    server.close((error?: Error): void => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

async function nextEvent(
  source: AsyncIterable<ChannelDataEvent>,
): Promise<ChannelDataEvent | undefined> {
  const result = await source[Symbol.asyncIterator]().next()
  return result.done === true ? undefined : result.value
}

describe('real loopback TCP channel integration', (): void => {
  it('opens, writes, reads, and closes through the production adapter', async (): Promise<void> => {
    const sockets = new Set<Socket>()
    const received: string[] = []
    const server = createServer((socket): void => {
      sockets.add(socket)
      socket.on('close', (): void => {
        sockets.delete(socket)
      })
      socket.on('data', (data): void => {
        received.push(data.toString('utf8'))
        socket.write(Buffer.concat([Buffer.from('echo:', 'utf8'), data]))
      })
    })
    let handle: ChannelHandle | undefined
    try {
      const port = await listen(server)
      const adapter = new TcpChannelAdapter(
        'tcp-serial',
        [
          {
            id: 'loopback',
            label: 'Loopback TCP serial',
            kind: 'tcp-serial',
            host: '127.0.0.1',
            port,
            allowedCommands: [],
          },
        ],
        new NodeSocketConnector(),
      )
      const [endpoint] = await adapter.list()
      if (endpoint === undefined) throw new Error('loopback endpoint is missing')
      handle = await adapter.open(endpoint, { timeoutMs: 2000 })
      const events = handle.readEvents()
      await expect(nextEvent(events)).resolves.toMatchObject({ type: 'status', status: 'open' })

      await handle.write('ping')
      const response = await nextEvent(events)
      expect(response).toMatchObject({ type: 'data' })
      if (response?.type !== 'data') throw new Error('loopback response is not data')
      expect(new TextDecoder().decode(response.data)).toBe('echo:ping')
      expect(received).toEqual(['ping'])

      const closed = nextEvent(events)
      await handle.close()
      await expect(closed).resolves.toMatchObject({ type: 'status', status: 'closed' })
      await expect(nextEvent(events)).resolves.toBeUndefined()
      handle = undefined
    } finally {
      await handle?.close().catch((): void => undefined)
      for (const socket of sockets) socket.destroy()
      await closeServer(server)
    }
  })
})
