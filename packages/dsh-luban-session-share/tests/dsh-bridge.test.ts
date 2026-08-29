import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { asTaskId } from '@luban/core'
import { describe, expect, it, vi } from 'vitest'
import { DshSessionBridge, DshSessionInputSink } from '../src/dsh-bridge.js'
import { SharedSessionRegistry } from '../src/registry.js'
import { host, session, user } from './helpers.js'

describe('rc2 DSH bridge', (): void => {
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
