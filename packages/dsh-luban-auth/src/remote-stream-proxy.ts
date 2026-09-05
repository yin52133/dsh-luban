import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { RemoteStreamScope } from './remote-stream-scope.js'

interface RemoteProxyOptions {
  readonly request: IncomingMessage
  readonly socket: Duplex
  readonly head: Buffer
  readonly upstream: URL
  readonly cookie: string | undefined
  readonly maxBytes: number
  readonly scope: RemoteStreamScope
  readonly authenticated: () => Promise<boolean>
  readonly onClose: () => void
}

/** Terminate both WebSocket ends and apply an ordered, bounded account policy to every frame. */
export function proxyRemoteStreams(options: RemoteProxyOptions): () => void {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxBytes,
    perMessageDeflate: false,
  })
  let browser: WebSocket | undefined
  let upstream: WebSocket | undefined
  let stopped = false
  const close = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    options.scope.dispose()
    browser?.terminate()
    upstream?.terminate()
    options.socket.destroy()
    server.close()
    options.onClose()
  }
  const timer = setInterval((): void => {
    void options
      .authenticated()
      .then((valid): void => {
        if (!valid) close()
      })
      .catch(close)
  }, 15_000)
  timer.unref()
  server.on('error', close)
  options.socket.once('close', close)
  options.socket.once('error', close)

  // A separate ordered queue per direction avoids head-of-line deadlocks between streams.
  const ordered = (
    operation: (data: RawData) => Promise<void>,
  ): ((data: RawData, binary: boolean) => void) => {
    let pending = Promise.resolve()
    let bytes = 0
    return (data, binary): void => {
      const size = Array.isArray(data)
        ? data.reduce((sum, part) => sum + part.length, 0)
        : data.byteLength
      if (binary || size > options.maxBytes || bytes + size > options.maxBytes * 2) {
        close()
        return
      }
      bytes += size
      pending = pending
        .then(async (): Promise<void> => {
          if (stopped || !(await options.authenticated())) {
            close()
            return
          }
          await operation(data)
        })
        .catch(close)
        .finally((): void => {
          bytes -= size
        })
    }
  }

  try {
    server.handleUpgrade(options.request, options.socket, options.head, (client): void => {
      browser = client
      const target = new URL('/api/remote.mux', options.upstream)
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = new WebSocket(target, {
        headers: {
          origin: options.upstream.origin,
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        },
        maxPayload: options.maxBytes,
        perMessageDeflate: false,
        handshakeTimeout: 10_000,
        followRedirects: false,
      })
      upstream = host
      const ready = new Promise<void>((resolve, reject): void => {
        host.once('open', resolve)
        host.once('error', reject)
        host.once('close', (): void => reject(new Error('Upstream stream closed')))
      })
      void ready.catch(close)
      host.once('error', close)
      host.once('close', close)
      client.once('error', close)
      client.once('close', close)
      client.on(
        'message',
        ordered(async (data): Promise<void> => {
          const message = parse(data)
          const id = message.streamId
          if (typeof id !== 'string' || id === '' || id.length > 256)
            throw new Error('Invalid stream id')
          if (message.type === 'cancel') {
            if (!options.scope.has(id)) return
            options.scope.cancel(id)
          } else if (message.type === 'open' && typeof message.endpoint === 'string') {
            if (!(await options.scope.open(id, message.endpoint, message.payload))) {
              await send(client, {
                type: 'error',
                streamId: id,
                error: {
                  code: 'session/not-found',
                  message: 'Session is unavailable for this account',
                  details: {},
                },
              })
              return
            }
          } else throw new Error('Invalid stream request')
          await ready
          if (!stopped) await send(host, message)
        }),
      )
      host.on(
        'message',
        ordered(async (data): Promise<void> => {
          const message = parse(data)
          const id = message.streamId
          if (typeof id !== 'string' || !options.scope.has(id)) return
          if (message.type === 'item') {
            const value = await options.scope.filter(id, message.value)
            if (value !== null && !stopped) await send(client, { ...message, value })
          } else if (message.type === 'end' || message.type === 'error') {
            options.scope.cancel(id)
            await send(client, message)
          } else throw new Error('Invalid upstream frame')
        }),
      )
    })
  } catch {
    close()
  }
  return close
}

function parse(data: RawData): Record<string, unknown> {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Uint8Array)
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid stream frame')
  return value as Record<string, unknown>
}

function send(socket: WebSocket, message: unknown): Promise<void> {
  return new Promise((resolve, reject): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('Stream is closed'))
      return
    }
    socket.send(JSON.stringify(message), (error): void => {
      if (error) reject(error)
      else resolve()
    })
  })
}
