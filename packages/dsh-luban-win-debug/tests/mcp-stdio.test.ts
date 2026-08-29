import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatDesktopMcpResult,
  NodeStdioMcpClient,
  type DesktopMcpConnectOptions,
  type DesktopMcpProcess,
} from '../src/mcp-stdio.js'

type ShutdownBehavior = 'term' | 'sync-term' | 'force' | 'never'

class FakeMcpProcess extends EventEmitter {
  public readonly pid = 4244
  public readonly stdin = new PassThrough()
  public readonly stdout = new PassThrough()
  public readonly stderr = new PassThrough()
  public exitCode: number | null = null
  public readonly requests: Readonly<Record<string, unknown>>[] = []
  public readonly kills: string[] = []
  public unrefCalled = false
  public callResult: Readonly<Record<string, unknown>> = {
    content: [{ type: 'text', text: 'captured desktop' }],
    isError: false,
  }
  public callError: Readonly<Record<string, unknown>> | undefined
  public deferCalls = false
  public splitNextResponseInsideMultibyte = false
  readonly #advertisedTools: readonly string[]
  readonly #shutdown: ShutdownBehavior
  #input = ''

  public constructor(
    advertisedTools: readonly string[],
    shutdown: ShutdownBehavior = 'term',
    emitSpawn = true,
  ) {
    super()
    this.#advertisedTools = advertisedTools
    this.#shutdown = shutdown
    this.stdin.on('data', (chunk: Buffer): void => this.#receive(chunk))
    if (emitSpawn) {
      queueMicrotask((): void => {
        this.emit('spawn')
      })
    }
  }

  public kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null) return false
    this.kills.push(String(signal ?? 'SIGTERM'))
    if (this.#shutdown === 'never') return true
    if (this.#shutdown === 'force' && signal !== 'SIGKILL') return true
    if (this.#shutdown === 'sync-term') this.#close(0)
    else queueMicrotask((): void => this.#close(0))
    return true
  }

  public unref(): void {
    this.unrefCalled = true
  }

  public unexpectedExit(exitCode: number): void {
    this.#close(exitCode)
  }

  public serverRequest(id: string | number, method: string): void {
    this.#writeResponse({ jsonrpc: '2.0', id, method, params: {} })
  }

  public respondToLatestCall(result = this.callResult): void {
    const request = [...this.requests]
      .reverse()
      .find((candidate): boolean => candidate.method === 'tools/call')
    if (typeof request?.id !== 'number') throw new Error('missing pending tools/call request')
    this.#respond(request.id, result)
  }

  #receive(chunk: Buffer): void {
    this.#input += chunk.toString('utf8')
    let newline = this.#input.indexOf('\n')
    while (newline >= 0) {
      const line = this.#input.slice(0, newline).trim()
      this.#input = this.#input.slice(newline + 1)
      if (line !== '') this.#handle(JSON.parse(line) as Readonly<Record<string, unknown>>)
      newline = this.#input.indexOf('\n')
    }
  }

  #handle(message: Readonly<Record<string, unknown>>): void {
    this.requests.push(message)
    if (typeof message.id !== 'number' || typeof message.method !== 'string') return
    if (message.method === 'initialize') {
      this.#respond(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-desktop', version: '1.0.0' },
      })
      return
    }
    if (message.method === 'tools/list') {
      this.#respond(message.id, {
        tools: this.#advertisedTools.map((name): Readonly<Record<string, unknown>> => ({
          name,
          description: `${name} test tool`,
          inputSchema: { type: 'object' },
        })),
      })
      return
    }
    if (message.method === 'tools/call') {
      if (this.deferCalls) return
      if (this.callError === undefined) this.#respond(message.id, this.callResult)
      else this.#respondError(message.id, this.callError)
    }
  }

  #respond(id: number, result: Readonly<Record<string, unknown>>): void {
    this.#writeResponse({ jsonrpc: '2.0', id, result })
  }

  #respondError(id: number, error: Readonly<Record<string, unknown>>): void {
    this.#writeResponse({ jsonrpc: '2.0', id, error })
  }

  #writeResponse(message: Readonly<Record<string, unknown>>): void {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
    if (this.splitNextResponseInsideMultibyte) {
      this.splitNextResponseInsideMultibyte = false
      const marker = bytes.indexOf(Buffer.from('桌', 'utf8'))
      if (marker < 0) throw new Error('missing multibyte split marker')
      this.stdout.write(bytes.subarray(0, marker + 1))
      this.stdout.write(bytes.subarray(marker + 1))
      return
    }
    this.stdout.write(bytes)
  }

  #close(exitCode: number): void {
    if (this.exitCode !== null) return
    this.exitCode = exitCode
    this.emit('close', exitCode, null)
  }
}

const clients: NodeStdioMcpClient[] = []

afterEach(async (): Promise<void> => {
  vi.useRealTimers()
  await Promise.all(clients.splice(0).map(async (client): Promise<void> => client.stop()))
})

function options(
  tools: readonly string[],
  overrides: Partial<DesktopMcpConnectOptions> = {},
): DesktopMcpConnectOptions {
  return {
    command: 'C:\\Tools\\desktop-mcp.exe',
    args: ['--stdio'],
    allowedTools: tools,
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    processLifetimeMs: 60_000,
    maxMessageBytes: 64 * 1024,
    ...overrides,
  }
}

function hasUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (
      code !== undefined &&
      (code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        (code >= 0x7f && code <= 0x9f))
    ) {
      return true
    }
  }
  return false
}

describe('bounded stdio MCP transport', (): void => {
  it('negotiates, verifies the allowlist and forwards a tools/call request', async (): Promise<void> => {
    const process = new FakeMcpProcess(['desktop.capture', 'desktop.click'])
    const client = new NodeStdioMcpClient(
      (): DesktopMcpProcess => process as unknown as DesktopMcpProcess,
    )
    clients.push(client)

    await client.connect(options(['desktop.capture']))
    await expect(client.call('desktop.capture', { display: 1 })).resolves.toBe('captured desktop')

    expect(client.advertisedTools).toEqual(['desktop.capture', 'desktop.click'])
    expect(process.requests.map((request): unknown => request.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ])
    expect(process.requests.at(-1)?.params).toEqual({
      name: 'desktop.capture',
      arguments: { display: 1 },
    })
  })

  it('decodes split UTF-8 JSON and answers string-id server requests', async (): Promise<void> => {
    const process = new FakeMcpProcess(['desktop.capture'])
    const client = new NodeStdioMcpClient(
      (): DesktopMcpProcess => process as unknown as DesktopMcpProcess,
    )
    clients.push(client)
    await client.connect(options(['desktop.capture']))
    process.callResult = {
      content: [{ type: 'text', text: '桌面 captured' }],
      isError: false,
    }
    process.splitNextResponseInsideMultibyte = true

    await expect(client.call('desktop.capture', {})).resolves.toBe('桌面 captured')
    process.serverRequest('server-ping', 'ping')
    expect(process.requests.at(-1)).toEqual({ jsonrpc: '2.0', id: 'server-ping', result: {} })
    process.serverRequest('server-unknown', 'desktop/unsupported')
    expect(process.requests.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 'server-unknown',
      error: { code: -32_601, message: 'Method not supported by this client' },
    })
  })

  it('tears down cleanly when stdin ends or emits EPIPE', async (): Promise<void> => {
    const ended = new FakeMcpProcess(['desktop.capture'])
    const endedClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => ended as unknown as DesktopMcpProcess,
    )
    clients.push(endedClient)
    await endedClient.connect(options(['desktop.capture']))
    ended.stdin.end()
    await expect(endedClient.call('desktop.capture', {})).rejects.toThrow(
      'Desktop MCP transport failed: Desktop MCP stdin is unavailable',
    )
    await endedClient.stop()

    const broken = new FakeMcpProcess(['desktop.capture'])
    const brokenClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => broken as unknown as DesktopMcpProcess,
    )
    clients.push(brokenClient)
    await brokenClient.connect(options(['desktop.capture']))
    broken.stdin.emit(
      'error',
      Object.assign(new Error('write EPIPE token=raw-secret'), { code: 'EPIPE' }),
    )
    await brokenClient.stop()
    expect(brokenClient.connected).toBe(false)
  })

  it('settles transport-failed calls only after the owned process is torn down', async (): Promise<void> => {
    const malformed = new FakeMcpProcess(['desktop.capture'])
    malformed.deferCalls = true
    const malformedClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => malformed as unknown as DesktopMcpProcess,
    )
    clients.push(malformedClient)
    await malformedClient.connect(options(['desktop.capture']))
    let malformedSettled = false
    const malformedCall = malformedClient.call('desktop.capture', {}).finally((): void => {
      malformedSettled = true
    })

    malformed.stdout.write('{not JSON}\n')
    malformed.respondToLatestCall({
      content: [{ type: 'text', text: 'late success must be ignored' }],
      isError: false,
    })
    expect(malformedSettled).toBe(false)
    expect(malformed.stdout.destroyed).toBe(false)
    await expect(malformedCall).rejects.toThrow(
      'Desktop MCP transport failed: Desktop MCP emitted invalid JSON',
    )
    expect(malformed.stdout.destroyed).toBe(true)
    expect(malformed.unrefCalled).toBe(true)

    const epipe = new FakeMcpProcess(['desktop.capture'])
    epipe.deferCalls = true
    const epipeClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => epipe as unknown as DesktopMcpProcess,
    )
    clients.push(epipeClient)
    await epipeClient.connect(options(['desktop.capture']))
    let epipeSettled = false
    const epipeCall = epipeClient.call('desktop.capture', {}).finally((): void => {
      epipeSettled = true
    })

    epipe.stdin.emit('error', new Error('write EPIPE token=raw-secret'))
    expect(epipeSettled).toBe(false)
    expect(epipe.stdin.destroyed).toBe(false)
    await expect(epipeCall).rejects.toThrow(
      'Desktop MCP transport failed: write EPIPE token=[REDACTED]',
    )
    expect(epipe.stdin.destroyed).toBe(true)
    expect(epipe.unrefCalled).toBe(true)

    const synchronous = new FakeMcpProcess(['desktop.capture'])
    const synchronousClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => synchronous as unknown as DesktopMcpProcess,
    )
    clients.push(synchronousClient)
    await synchronousClient.connect(options(['desktop.capture']))
    vi.spyOn(synchronous.stdin, 'write').mockImplementationOnce((): never => {
      throw new Error('sync EPIPE password=write-secret')
    })
    let synchronousSettled = false
    const synchronousCall = synchronousClient.call('desktop.capture', {}).finally((): void => {
      synchronousSettled = true
    })

    expect(synchronousSettled).toBe(false)
    expect(synchronous.stdin.destroyed).toBe(false)
    await expect(synchronousCall).rejects.toThrow(
      'Desktop MCP transport failed: sync EPIPE password=[REDACTED]',
    )
    expect(synchronous.stdin.destroyed).toBe(true)
    expect(synchronous.unrefCalled).toBe(true)
  })

  it('counts whitespace when enforcing the raw JSON-RPC line limit', async (): Promise<void> => {
    const process = new FakeMcpProcess(['desktop.capture'])
    process.deferCalls = true
    const client = new NodeStdioMcpClient(
      (): DesktopMcpProcess => process as unknown as DesktopMcpProcess,
    )
    clients.push(client)
    await client.connect(options(['desktop.capture'], { maxMessageBytes: 1024 }))
    const call = client.call('desktop.capture', {})

    process.stdout.write(`${' '.repeat(1025)}{}\n`)

    await expect(call).rejects.toThrow(
      'Desktop MCP transport failed: Desktop MCP response is too large',
    )
    expect(process.stdout.destroyed).toBe(true)
  })

  it('waits for teardown before settling cancelled or explicitly stopped calls', async (): Promise<void> => {
    const preAbortedProcess = new FakeMcpProcess(['desktop.capture'], 'never')
    const preAbortedClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => preAbortedProcess as unknown as DesktopMcpProcess,
      5,
    )
    clients.push(preAbortedClient)
    await preAbortedClient.connect(options(['desktop.capture']))
    const preAbortedController = new AbortController()
    preAbortedController.abort()
    let preAbortedSettled = false
    const preAbortedCall = preAbortedClient
      .call('desktop.capture', {}, preAbortedController.signal)
      .finally((): void => {
        preAbortedSettled = true
      })
    expect(preAbortedSettled).toBe(false)
    expect(preAbortedProcess.kills).toEqual(['SIGTERM'])
    expect(preAbortedProcess.stdin.destroyed).toBe(false)
    preAbortedProcess.unexpectedExit(0)
    await expect(preAbortedCall).rejects.toThrow('Desktop MCP tools/call was cancelled')
    expect(preAbortedProcess.stdin.destroyed).toBe(true)

    const abortedProcess = new FakeMcpProcess(['desktop.capture'], 'never')
    abortedProcess.deferCalls = true
    const abortedClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => abortedProcess as unknown as DesktopMcpProcess,
      5,
    )
    clients.push(abortedClient)
    await abortedClient.connect(options(['desktop.capture']))
    const controller = new AbortController()
    let abortedSettled = false
    const abortedCall = abortedClient
      .call('desktop.capture', {}, controller.signal)
      .finally((): void => {
        abortedSettled = true
      })
    controller.abort()
    abortedProcess.respondToLatestCall({
      content: [{ type: 'text', text: 'late cancellation success' }],
      isError: false,
    })
    expect(abortedSettled).toBe(false)
    expect(abortedProcess.stdin.destroyed).toBe(false)
    abortedProcess.unexpectedExit(0)
    await expect(abortedCall).rejects.toThrow('Desktop MCP tools/call was cancelled')
    expect(abortedProcess.stdin.destroyed).toBe(true)
    expect(abortedProcess.kills).toEqual(['SIGTERM'])

    const stoppedProcess = new FakeMcpProcess(['desktop.capture'], 'never')
    stoppedProcess.deferCalls = true
    const stoppedClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => stoppedProcess as unknown as DesktopMcpProcess,
      5,
    )
    clients.push(stoppedClient)
    await stoppedClient.connect(options(['desktop.capture']))
    let stoppedCallSettled = false
    const stoppedCall = stoppedClient.call('desktop.capture', {}).finally((): void => {
      stoppedCallSettled = true
    })
    const stopping = stoppedClient.stop()
    stoppedProcess.respondToLatestCall({
      content: [{ type: 'text', text: 'late stop success' }],
      isError: false,
    })
    expect(stoppedCallSettled).toBe(false)
    stoppedProcess.unexpectedExit(0)
    await expect(stopping).resolves.toBeUndefined()
    await expect(stoppedCall).rejects.toThrow('Desktop MCP process exited')
    expect(stoppedProcess.stdin.destroyed).toBe(true)
  })

  it('bounds request-timeout teardown before rejecting the call', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const process = new FakeMcpProcess(['desktop.capture'], 'never')
      process.deferCalls = true
      const client = new NodeStdioMcpClient(
        (): DesktopMcpProcess => process as unknown as DesktopMcpProcess,
        5,
      )
      clients.push(client)
      await client.connect(options(['desktop.capture'], { requestTimeoutMs: 5 }))
      let settled = false
      const call = client.call('desktop.capture', {}).finally((): void => {
        settled = true
      })
      const rejected = expect(call).rejects.toThrow('Desktop MCP tools/call timed out')

      await vi.advanceTimersByTimeAsync(5)
      expect(settled).toBe(false)
      expect(process.kills).toEqual(['SIGTERM'])
      expect(process.stdin.destroyed).toBe(false)
      await vi.advanceTimersByTimeAsync(5)
      expect(settled).toBe(false)
      expect(process.kills).toEqual(['SIGTERM', 'SIGKILL'])
      expect(process.stdin.destroyed).toBe(false)
      await vi.advanceTimersByTimeAsync(5)
      await rejected
      expect(process.stdin.destroyed).toBe(true)
      expect(process.unrefCalled).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('contains factory, abort-race, and already-closed startup failures', async (): Promise<void> => {
    let factoryCalls = 0
    const factoryClient = new NodeStdioMcpClient((): DesktopMcpProcess => {
      factoryCalls += 1
      if (factoryCalls === 1) throw new Error('factory failed token=factory-secret\u0001')
      return new FakeMcpProcess(['desktop.capture']) as unknown as DesktopMcpProcess
    })
    clients.push(factoryClient)
    await expect(factoryClient.connect(options(['desktop.capture']))).rejects.toThrow(
      'Desktop MCP transport failed: factory failed token=[REDACTED]',
    )
    await expect(factoryClient.connect(options(['desktop.capture']))).resolves.toBeUndefined()

    const controller = new AbortController()
    const aborted = new FakeMcpProcess(['desktop.capture'], 'sync-term')
    const abortClient = new NodeStdioMcpClient((): DesktopMcpProcess => {
      controller.abort()
      return aborted as unknown as DesktopMcpProcess
    })
    clients.push(abortClient)
    await expect(
      abortClient.connect(options(['desktop.capture'], { signal: controller.signal })),
    ).rejects.toThrow('start was cancelled')
    expect(aborted.kills).toEqual(['SIGTERM'])

    const neverSpawned = new FakeMcpProcess(['desktop.capture'], 'sync-term', false)
    const timeoutClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => neverSpawned as unknown as DesktopMcpProcess,
      50,
    )
    clients.push(timeoutClient)
    const startedAt = Date.now()
    await expect(
      timeoutClient.connect(options(['desktop.capture'], { startupTimeoutMs: 5 })),
    ).rejects.toThrow('startup timed out')
    expect(Date.now() - startedAt).toBeLessThan(100)
    expect(neverSpawned.kills).toEqual(['SIGKILL'])

    const alreadyClosed = new FakeMcpProcess(['desktop.capture'], 'never', false)
    alreadyClosed.unexpectedExit(23)
    const alreadyClosedClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => alreadyClosed as unknown as DesktopMcpProcess,
      50,
    )
    clients.push(alreadyClosedClient)
    const closedAt = Date.now()
    await expect(alreadyClosedClient.connect(options(['desktop.capture']))).rejects.toThrow(
      'exited before startup completed',
    )
    expect(Date.now() - closedAt).toBeLessThan(100)
    expect(alreadyClosed.kills).toEqual([])
    expect(alreadyClosed.stdin.destroyed).toBe(true)
    expect(alreadyClosed.unrefCalled).toBe(true)
  })

  it('fails closed when the server omits a profile-allowlisted tool', async (): Promise<void> => {
    const process = new FakeMcpProcess(['desktop.capture'])
    const client = new NodeStdioMcpClient(
      (): DesktopMcpProcess => process as unknown as DesktopMcpProcess,
    )
    clients.push(client)

    await expect(client.connect(options(['desktop.capture', 'desktop.click']))).rejects.toThrow(
      'did not advertise allowlisted tool(s): desktop.click',
    )
    expect(client.connected).toBe(false)
    expect(process.exitCode).toBe(0)
  })

  it('clears connection state after an unexpected exit and reconnects cleanly', async (): Promise<void> => {
    const processes: FakeMcpProcess[] = []
    const client = new NodeStdioMcpClient((): DesktopMcpProcess => {
      const process = new FakeMcpProcess(['desktop.capture'])
      processes.push(process)
      return process as unknown as DesktopMcpProcess
    })
    clients.push(client)

    await client.connect(options(['desktop.capture']))
    const first = processes[0]
    if (first === undefined) throw new Error('missing first fake MCP process')
    first.stdout.write('{"jsonrpc":"2.0"')
    first.unexpectedExit(17)
    expect(client.connected).toBe(false)
    expect(client.advertisedTools).toEqual([])
    expect(client.recentOutput.at(-1)).toMatchObject({ type: 'exit', exitCode: 17 })

    await client.connect(options(['desktop.capture']))
    const second = processes[1]
    if (second === undefined) throw new Error('missing replacement fake MCP process')
    await expect(client.call('desktop.capture', {})).resolves.toBe('captured desktop')
    first.stdout.write('stale output\n')
    expect(client.connected).toBe(true)
    expect(client.pid).toBe(second.pid)
  })

  it('observes close synchronously and waits for forced termination to finish', async (): Promise<void> => {
    const synchronous = new FakeMcpProcess(['desktop.capture'], 'sync-term')
    const synchronousClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => synchronous as unknown as DesktopMcpProcess,
      5,
    )
    clients.push(synchronousClient)
    await synchronousClient.connect(options(['desktop.capture']))
    await expect(synchronousClient.stop()).resolves.toBeUndefined()
    expect(synchronous.kills).toEqual(['SIGTERM'])

    const forced = new FakeMcpProcess(['desktop.capture'], 'force')
    const forcedClient = new NodeStdioMcpClient(
      (): DesktopMcpProcess => forced as unknown as DesktopMcpProcess,
      5,
    )
    clients.push(forcedClient)
    await forcedClient.connect(options(['desktop.capture']))
    await expect(forcedClient.stop()).resolves.toBeUndefined()
    expect(forced.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('enforces process lifetime and reconnects without stale state', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const processes: FakeMcpProcess[] = []
      const client = new NodeStdioMcpClient((): DesktopMcpProcess => {
        const process = new FakeMcpProcess(['desktop.capture'])
        processes.push(process)
        return process as unknown as DesktopMcpProcess
      }, 5)
      clients.push(client)
      await client.connect(options(['desktop.capture'], { processLifetimeMs: 5 }))
      const expired = processes[0]
      if (expired === undefined) throw new Error('missing expiring MCP process')

      await vi.advanceTimersByTimeAsync(5)
      expect(client.connected).toBe(false)
      expect(client.advertisedTools).toEqual([])
      expect(expired.kills).toEqual(['SIGTERM'])
      expect(expired.stdin.destroyed).toBe(true)
      expect(expired.unrefCalled).toBe(true)
      expect(vi.getTimerCount()).toBe(0)

      await client.connect(options(['desktop.capture']))
      await expect(client.call('desktop.capture', {})).resolves.toBe('captured desktop')
      await client.stop()
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('bounds a missing close event and ignores its stale late close after reconnect', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const processes: FakeMcpProcess[] = []
      const client = new NodeStdioMcpClient((): DesktopMcpProcess => {
        const process = new FakeMcpProcess(
          ['desktop.capture'],
          processes.length === 0 ? 'never' : 'term',
        )
        processes.push(process)
        return process as unknown as DesktopMcpProcess
      }, 5)
      clients.push(client)
      await client.connect(options(['desktop.capture']))
      const stuck = processes[0]
      if (stuck === undefined) throw new Error('missing stuck fake MCP process')

      const stopping = client.stop()
      await vi.advanceTimersByTimeAsync(10)
      await expect(stopping).rejects.toThrow('did not close after forced termination')
      expect(vi.getTimerCount()).toBe(0)
      expect(stuck.kills).toEqual(['SIGTERM', 'SIGKILL'])
      expect(stuck.listenerCount('close')).toBe(0)
      expect(stuck.listenerCount('error')).toBe(0)
      expect(stuck.stdout.listenerCount('data')).toBe(0)
      expect(stuck.stderr.listenerCount('data')).toBe(0)
      expect(stuck.stdin.listenerCount('error')).toBe(0)
      expect(stuck.stdin.destroyed).toBe(true)
      expect(stuck.stdout.destroyed).toBe(true)
      expect(stuck.stderr.destroyed).toBe(true)
      expect(stuck.unrefCalled).toBe(true)
      await client.connect(options(['desktop.capture']))
      const replacement = processes[1]
      if (replacement === undefined) throw new Error('missing replacement fake MCP process')
      stuck.unexpectedExit(99)
      await expect(client.call('desktop.capture', {})).resolves.toBe('captured desktop')
      expect(client.pid).toBe(replacement.pid)
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })

  it('redacts and bounds stderr, RPC failures, and model-facing output by UTF-8 bytes', async (): Promise<void> => {
    const formatted = formatDesktopMcpResult(
      {
        content: [{ type: 'text', text: 'token=super-secret\u0001🙂🙂🙂' }],
        structuredContent: { password: 'also-secret' },
        isError: false,
      },
      32,
    )
    expect(formatted).not.toContain('super-secret')
    expect(formatted).not.toContain('also-secret')
    expect(Buffer.byteLength(formatted, 'utf8')).toBeLessThanOrEqual(32)
    expect(formatDesktopMcpResult({ content: [{ type: 'text', text: '🙂🙂' }] }, 7)).toBe('🙂')
    const adversarial = formatDesktopMcpResult(
      {
        content: [
          { type: 'text', text: 'tok\u0001en=split-key-secret' },
          { type: 'text', text: 'Bearer\u0007split-auth-secret' },
          { type: 'text', text: 'password=' },
          { type: 'text', text: 'cross-block-secret' },
        ],
      },
      1024,
    )
    expect(adversarial).not.toContain('split-key-secret')
    expect(adversarial).not.toContain('split-auth-secret')
    expect(adversarial).not.toContain('cross-block-secret')

    const process = new FakeMcpProcess(['desktop.capture'])
    process.callError = {
      code: -32_603,
      message: 'Bearer raw-credential\u0007 remote failure',
    }
    const client = new NodeStdioMcpClient(
      (): DesktopMcpProcess => process as unknown as DesktopMcpProcess,
    )
    clients.push(client)
    await client.connect(options(['desktop.capture'], { maxMessageBytes: 1024 }))
    const diagnostic = Buffer.from('password=stderr-secret\u0002 桌面 diagnostic', 'utf8')
    const marker = diagnostic.indexOf(Buffer.from('桌', 'utf8'))
    process.stderr.write(diagnostic.subarray(0, marker + 1))
    process.stderr.write(diagnostic.subarray(marker + 1))

    let stderr = client.recentOutput.find((event): boolean => event.type === 'stderr')?.text ?? ''
    expect(stderr).not.toContain('stderr-secret')
    expect(stderr).toContain('桌面 diagnostic')
    expect(hasUnsafeControlCharacters(stderr)).toBe(false)
    expect(Buffer.byteLength(stderr, 'utf8')).toBeLessThanOrEqual(1024)

    process.stderr.write(Buffer.alloc(2048, 0x78))
    const stderrEvents = client.recentOutput.filter((event): boolean => event.type === 'stderr')
    stderr = stderrEvents[0]?.text ?? ''
    expect(stderrEvents).toHaveLength(1)
    expect(stderr).toBe('[Desktop MCP stderr exceeded the safe display limit and was redacted]')
    expect(
      client.recentOutput.reduce(
        (total, event): number => total + Buffer.byteLength(event.text ?? '', 'utf8'),
        0,
      ),
    ).toBeLessThanOrEqual(1024)
    await expect(client.call('desktop.capture', {})).rejects.toThrow(
      'Desktop MCP tools/call failed: [REDACTED] remote failure',
    )
  })
})
