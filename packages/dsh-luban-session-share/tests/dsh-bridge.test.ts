import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { asAccountId, asActorId, asTaskId, type AccountId, type Task } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { DshSessionBridge, DshSessionInputSink } from '../src/dsh-bridge.js'
import { SharedSessionRegistry } from '../src/registry.js'
import { host, session, user } from './helpers.js'

describe('rc2 DSH bridge', (): void => {
  it('registers only sessions with a persisted account owner', async (): Promise<void> => {
    const bound = {
      id: 'S-bound',
      session: { id: 'S-bound', header: {} },
      status: 'idle',
    } as unknown as Agent
    const legacy = {
      id: 'S-legacy',
      session: { id: 'S-legacy', header: {} },
      status: 'idle',
    } as unknown as Agent
    const agents = {
      roots: (): Agent[] => [bound, legacy],
      get: (): Agent | undefined => undefined,
    } as unknown as AgentRegistry
    const ownerOf = vi.fn((id: ReturnType<typeof session>) =>
      Promise.resolve(id === session('S-bound') ? asAccountId('alice') : null),
    )
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      accountSessions: {
        bind: (): Promise<void> => Promise.resolve(),
        ownerOf,
      },
    })

    bridge.initialize([])

    await vi.waitFor((): void => {
      expect(registry.getView(session('S-bound'))).toMatchObject({
        accountId: 'alice',
        owner: { accountId: 'alice', id: 'alice' },
      })
      expect(ownerOf).toHaveBeenCalledTimes(2)
    })
    expect(registry.getView(session('S-legacy'))).toBeUndefined()
  })

  it('does not register a session after the bridge is disposed', async (): Promise<void> => {
    const agent = {
      id: 'S-disposed-owner-lookup',
      session: { id: 'S-disposed-owner-lookup', header: {} },
      status: 'idle',
    } as unknown as Agent
    const agents = {
      roots: (): Agent[] => [agent],
      get: (): Agent => agent,
    } as unknown as AgentRegistry
    let resolveOwner: ((accountId: AccountId) => void) | undefined
    let ownerLookupStarted: (() => void) | undefined
    const started = new Promise<void>((resolve): void => {
      ownerLookupStarted = resolve
    })
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      accountSessions: {
        bind: (): Promise<void> => Promise.resolve(),
        ownerOf: () =>
          new Promise<AccountId>((resolveAccount): void => {
            resolveOwner = resolveAccount
            ownerLookupStarted?.()
          }),
      },
    })
    bridge.initialize([])
    await started
    bridge.dispose()
    if (resolveOwner === undefined) throw new Error('owner lookup did not start')
    resolveOwner(asAccountId('alice'))
    await Promise.resolve()
    await Promise.resolve()

    expect(registry.getView(session('S-disposed-owner-lookup'))).toBeUndefined()
  })

  it('rechecks a late account binding before applying task links', async (): Promise<void> => {
    const agent = {
      id: 'S-late-bind',
      session: { id: 'S-late-bind', header: {} },
      status: 'idle',
    } as unknown as Agent
    const agents = {
      roots: (): Agent[] => [agent],
      get: (): Agent => agent,
    } as unknown as AgentRegistry
    let owner: AccountId | null = null
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      accountSessions: {
        bind: (): Promise<void> => Promise.resolve(),
        ownerOf: (): Promise<AccountId | null> => Promise.resolve(owner),
      },
    })
    bridge.initialize([])
    await vi.waitFor((): void => {
      expect(registry.getView(session('S-late-bind'))).toBeUndefined()
    })

    owner = asAccountId('alice')
    const task: Task = {
      accountId: owner,
      id: asTaskId('T-late-bind'),
      title: 'Late-bound session',
      description: '',
      status: 'doing',
      hostScope: 'any',
      priority: 'P2',
      tags: [],
      version: 1,
      claim: {
        actor: {
          kind: 'agent',
          id: asActorId('agent-late-bind'),
          accountId: owner,
        },
        sessionId: session('S-late-bind'),
        claimedAt: 1,
      },
      outputs: [],
      createdAt: 1,
      updatedAt: 1,
    }

    await bridge.syncTasks([task])

    expect(registry.getView(session('S-late-bind'))).toMatchObject({
      accountId: 'alice',
      ownerTaskId: 'T-late-bind',
    })
  })

  it('ignores managed task links from another or unknown account', (): void => {
    const agent = {
      id: 'S-managed-account',
      session: { id: 'S-managed-account', header: {} },
      status: 'idle',
    } as unknown as Agent
    const agents = {
      roots: (): Agent[] => [agent],
      get: (): Agent => agent,
    } as unknown as AgentRegistry
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      owner: user('alice'),
    })
    bridge.initialize([
      {
        accountId: asAccountId('bob'),
        id: 'S-managed-account',
        host: host('ubuntu'),
        kind: 'tmux',
        purpose: 'task',
        ownerTaskId: asTaskId('T-initial-wrong-account'),
        createdAt: 1,
      },
    ])
    expect(registry.getView(session('S-managed-account'))?.ownerTaskId).toBeUndefined()

    for (const accountId of [undefined, asAccountId('bob')]) {
      bridge.keepaliveEvent({
        type: 'started',
        session: {
          ...(accountId === undefined ? {} : { accountId }),
          id: 'luban-S-managed-account',
          host: host('ubuntu'),
          kind: 'tmux',
          purpose: 'task',
          ownerTaskId: asTaskId('T-wrong-account'),
          createdAt: 1,
        },
      })
      expect(registry.getView(session('S-managed-account'))?.ownerTaskId).toBeUndefined()
    }

    bridge.keepaliveEvent({
      type: 'started',
      session: {
        accountId: asAccountId('alice'),
        id: 'luban-S-managed-account',
        host: host('ubuntu'),
        kind: 'tmux',
        purpose: 'task',
        ownerTaskId: asTaskId('T-alice'),
        createdAt: 1,
      },
    })
    expect(registry.getView(session('S-managed-account'))).toMatchObject({
      ownerTaskId: 'T-alice',
    })
  })

  it('registers live agents, forwards status/output, and injects identified follow-ups', async (): Promise<void> => {
    const followup = vi.fn<Agent['followup']>()
    let agentStatus: 'idle' | 'running' = 'idle'
    const dshSession = { id: 'S-agent', header: {} } as unknown as Session
    const agent = {
      id: 'S-agent',
      session: dshSession,
      get status(): 'idle' | 'running' {
        return agentStatus
      },
      followup,
    } as unknown as Agent
    const agents = {
      list: (): Agent[] => [agent],
      roots: (): Agent[] => [agent],
      get: (): Agent => agent,
    } as unknown as AgentRegistry
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
      input: new DshSessionInputSink(agents),
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      owner: user('owner'),
    })
    bridge.initialize([])
    expect(registry.getView(session('S-agent'))).toMatchObject({
      id: 'S-agent',
      host: 'ubuntu',
      status: 'idle',
      lockHolder: { id: 'owner' },
    })

    agentStatus = 'running'
    bridge.agentStatus(agent, agentStatus)
    bridge.keepaliveEvent({
      type: 'started',
      session: {
        accountId: asAccountId('owner'),
        id: 'luban-S-agent',
        host: host('ubuntu'),
        kind: 'tmux',
        purpose: 'task',
        ownerTaskId: asTaskId('T-1'),
        createdAt: 123,
      },
    })
    expect(registry.getView(session('S-agent'))).toMatchObject({
      status: 'running',
      ownerTaskId: 'T-1',
    })
    bridge.keepaliveEvent({
      type: 'health',
      report: {
        healthy: true,
        checkedAt: 124,
        sessions: [{ id: 'luban-S-agent', alive: true }],
      },
    })
    expect(registry.getView(session('S-agent'))).toMatchObject({
      healthy: true,
      status: 'running',
    })
    bridge.keepaliveEvent({
      type: 'health',
      report: {
        healthy: false,
        checkedAt: 125,
        sessions: [{ id: 'luban-S-agent', alive: false }],
      },
    })
    expect(registry.getView(session('S-agent'))).toMatchObject({
      healthy: false,
      status: 'unhealthy',
    })

    bridge.sessionEvent(dshSession, {
      type: 'assistant/chunk',
      seq: 9,
      time: 456,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'hello token=' },
      },
    })
    bridge.sessionEvent(dshSession, {
      type: 'assistant/chunk',
      seq: 10,
      time: 457,
      data: {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'secret-value' },
      },
    })
    bridge.sessionEvent(dshSession, {
      type: 'turn/end',
      seq: 11,
      time: 458,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    const controller = new AbortController()
    const stream = registry.stream(session('S-agent'), 2, controller.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        event: 'session',
        data: { type: 'output', text: 'hello token=[REDACTED]', at: 458 },
      },
    })

    bridge.sessionEvent(dshSession, {
      type: 'assistant/chunk',
      seq: 12,
      time: 459,
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(70_000) },
      },
    })
    bridge.sessionEvent(dshSession, {
      type: 'turn/end',
      seq: 13,
      time: 460,
      data: { turn: 2, reason: { kind: 'completed' } },
    })
    const truncated = await stream.next()
    expect(truncated.done).toBe(false)
    if (truncated.done === false && truncated.value.event === 'session') {
      expect(truncated.value.data).toMatchObject({ type: 'output', at: 460 })
      if (truncated.value.data.type === 'output') {
        expect(Buffer.byteLength(truncated.value.data.text, 'utf8')).toBe(64 * 1024)
        expect(truncated.value.data.text).toMatch(/\[output truncated\]\n$/u)
      }
    }

    bridge.sessionEvent(dshSession, {
      type: 'assistant/chunk',
      seq: 14,
      time: 461,
      data: {
        turn: 3,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '\uD83D' },
      },
    })
    bridge.sessionEvent(dshSession, {
      type: 'assistant/chunk',
      seq: 15,
      time: 462,
      data: {
        turn: 3,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: '\uDE42' },
      },
    })
    bridge.sessionEvent(dshSession, {
      type: 'turn/end',
      seq: 16,
      time: 463,
      data: { turn: 3, reason: { kind: 'completed' } },
    })
    await expect(stream.next()).resolves.toMatchObject({
      value: { event: 'session', data: { type: 'output', text: '🙂', at: 463 } },
    })

    bridge.sessionEvent(dshSession, {
      type: 'assistant/chunk',
      seq: 17,
      time: 464,
      data: {
        turn: 4,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: `${'🙂'.repeat(16_000)}\uD83D` },
      },
    })
    bridge.sessionEvent(dshSession, {
      type: 'assistant/chunk',
      seq: 18,
      time: 465,
      data: {
        turn: 4,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: `\uDE42${'🙂'.repeat(1_000)}` },
      },
    })
    bridge.sessionEvent(dshSession, {
      type: 'turn/end',
      seq: 19,
      time: 466,
      data: { turn: 4, reason: { kind: 'completed' } },
    })
    const multibyte = await stream.next()
    expect(multibyte.done).toBe(false)
    if (multibyte.done === false && multibyte.value.event === 'session') {
      expect(multibyte.value.data).toMatchObject({ type: 'output', at: 466 })
      if (multibyte.value.data.type === 'output') {
        expect(Buffer.byteLength(multibyte.value.data.text, 'utf8')).toBe(64 * 1024)
        expect(multibyte.value.data.text).not.toContain('\uFFFD')
        expect(multibyte.value.data.text).toMatch(/\[output truncated\]\n$/u)
      }
    }
    controller.abort()
    await stream.return?.()

    await registry.injectInput(
      session('S-agent'),
      { actor: user('owner'), accountRole: 'admin' },
      'continue',
    )
    expect(followup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).toContain('dsh-luban-session-share')
    expect(JSON.stringify(followup.mock.calls[0]?.[0])).toContain('continue')

    bridge.agentDisposed(agent)
    expect(registry.getView(session('S-agent'))).toBeUndefined()
  })

  it('uses rc2 runtime roots and rejects a non-root agent without relying on durable origin', (): void => {
    const followup = vi.fn<Agent['followup']>()
    const subagent = {
      id: 'S-subagent',
      session: { header: {} },
      status: 'running',
      followup,
    } as unknown as Agent
    const agents = {
      list: (): Agent[] => [subagent],
      roots: (): Agent[] => [],
      get: (): Agent => subagent,
    } as unknown as AgentRegistry
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      owner: user('owner'),
    })

    bridge.initialize([])

    expect(registry.getView(session('S-subagent'))).toBeUndefined()
    expect((): Promise<void> =>
      new DshSessionInputSink(agents).inject(session('S-subagent'), 'do not inject'),
    ).toThrow('not a shareable live session')
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects a durable subagent even when rc2 restores it as a runtime root', (): void => {
    const followup = vi.fn<Agent['followup']>()
    const subagent = {
      id: 'S-restored-subagent',
      session: { header: { origin: 'subagent' } },
      status: 'idle',
      followup,
    } as unknown as Agent
    const agents = {
      roots: (): Agent[] => [subagent],
      get: (): Agent => subagent,
    } as unknown as AgentRegistry
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      owner: user('owner'),
    })

    bridge.initialize([])

    expect(registry.getView(session('S-restored-subagent'))).toBeUndefined()
    expect((): Promise<void> =>
      new DshSessionInputSink(agents).inject(session('S-restored-subagent'), 'reject'),
    ).toThrow('not a shareable live session')
    expect(followup).not.toHaveBeenCalled()
  })

  it('ignores keepalive updates for registry entries outside the accepted root set', (): void => {
    const agents = { roots: (): Agent[] => [] } as unknown as AgentRegistry
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-unrelated'),
      host: host('ubuntu'),
      owner: user('owner'),
      healthy: true,
      status: 'idle',
    })
    const bridge = new DshSessionBridge({
      agents,
      registry,
      host: host('ubuntu'),
      owner: user('owner'),
    })

    bridge.keepaliveEvent({
      type: 'health',
      report: {
        healthy: false,
        checkedAt: 1,
        sessions: [{ id: 'S-unrelated', alive: false }],
      },
    })

    expect(registry.getView(session('S-unrelated'))).toMatchObject({
      healthy: true,
      status: 'idle',
    })
  })
})
