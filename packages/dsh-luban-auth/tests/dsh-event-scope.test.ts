import { LubanError, asAccountId, type AccountId } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { DshEventScope, type DshEventChannel } from '../src/dsh-event-scope.js'

const alice = asAccountId('alice')
const bob = asAccountId('bob')

describe('DshEventScope', () => {
  it('scopes mux frames and tracks only question response rpc ownership', async () => {
    const { scope } = fixture()

    const own = wire('mux', {
      type: 'session/subscribed',
      sessionId: 'alice-session',
      lastSeq: 3,
    })
    await expect(scope.filter(alice, 'mux', own)).resolves.toBe(own)
    await expect(scope.filter(bob, 'mux', own)).resolves.toBeNull()
    await expect(
      scope.filter(
        alice,
        'mux',
        wire('mux', { type: 'session/subscribed', sessionId: 'legacy-session', lastSeq: 0 }),
      ),
    ).resolves.toBeNull()

    const streamError = wire('mux', {
      type: 'stream/error',
      error: { code: 'internal', message: 'boom', details: {} },
    })
    await expect(scope.filter(alice, 'mux', streamError)).resolves.toBe(streamError)
    await expect(scope.filter(bob, 'mux', streamError)).resolves.toBe(streamError)

    const question = wire(
      'mux',
      {
        type: 'question/requested',
        sessionId: 'alice-session',
        questions: [{ id: 'q1', question: 'Continue?' }],
      },
      'question-rpc',
    )
    await expect(scope.filter(bob, 'mux', question)).resolves.toBeNull()
    expect(scope.ownerOfQuestionRpc('question-rpc')).toBe(alice)

    const approval = wire(
      'mux',
      {
        type: 'approval/requested',
        sessionId: 'alice-session',
        approvalId: 'approval-1',
        toolName: 'bash',
      },
      'approval-rpc',
    )
    await expect(scope.filter(alice, 'mux', approval)).resolves.toBe(approval)
    expect(scope.ownerOfQuestionRpc('approval-rpc')).toBeNull()

    scope.completeQuestionRpc('question-rpc')
    expect(scope.ownerOfQuestionRpc('question-rpc')).toBeNull()
    await scope.filter(alice, 'mux', question)
    const resolved = wire('mux', {
      type: 'question/resolved',
      sessionId: 'alice-session',
      questionRpcId: 'question-rpc',
      outcome: 'cancelled',
    })
    await expect(scope.filter(bob, 'mux', resolved)).resolves.toBeNull()
    expect(scope.ownerOfQuestionRpc('question-rpc')).toBeNull()
  })

  it('scopes direct host frames and projects workspace and archive snapshots', async () => {
    const { scope } = fixture()
    const ownStatus = wire('host', {
      type: 'host/session-status',
      sessionId: 'alice-session',
      running: true,
    })
    await expect(scope.filter(alice, 'host', ownStatus)).resolves.toBe(ownStatus)
    await expect(scope.filter(bob, 'host', ownStatus)).resolves.toBeNull()

    const addedWithOwnParent = wire('host', {
      type: 'host/session-added',
      sessionId: 'alice-session',
      parentSessionId: 'alice-parent',
      blank: true,
    })
    await expect(scope.filter(alice, 'host', addedWithOwnParent)).resolves.toBe(addedWithOwnParent)

    const addedWithForeignParent = wire('host', {
      type: 'host/session-added',
      sessionId: 'alice-session',
      parentSessionId: 'bob-session',
      blank: true,
    })
    expect(decode(await scope.filter(alice, 'host', addedWithForeignParent))).toMatchObject({
      payload: { type: 'host/session-added', sessionId: 'alice-session', blank: true },
    })
    expect(
      (
        decode(await scope.filter(alice, 'host', addedWithForeignParent))?.payload as Record<
          string,
          unknown
        >
      ).parentSessionId,
    ).toBeUndefined()

    const addedWithUnknownParent = wire('host', {
      type: 'host/session-added',
      sessionId: 'alice-session',
      parentSessionId: 'legacy-session',
      blank: true,
    })
    expect(
      (
        decode(await scope.filter(alice, 'host', addedWithUnknownParent))?.payload as Record<
          string,
          unknown
        >
      ).parentSessionId,
    ).toBeUndefined()
    await expect(
      scope.filter(
        alice,
        'host',
        wire('host', {
          type: 'host/session-added',
          sessionId: 'bob-session',
          parentSessionId: 'alice-parent',
          blank: true,
        }),
      ),
    ).resolves.toBeNull()

    const workspace = wire('host', {
      type: 'host/workspace-changed',
      workspace: {
        workspaceId: 'work-1',
        path: 'D:/work',
        title: 'work',
        sessionIds: ['alice-session', 'bob-session', 'legacy-session'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    expect(decode(await scope.filter(alice, 'host', workspace))).toMatchObject({
      payload: { workspace: { sessionIds: ['alice-session'] } },
    })
    expect(decode(await scope.filter(bob, 'host', workspace))).toMatchObject({
      payload: { workspace: { sessionIds: ['bob-session'] } },
    })

    const archived = wire('host', {
      type: 'host/archived-sessions-changed',
      archivedSessionIds: ['bob-session', 'alice-session', 'legacy-session'],
    })
    expect(decode(await scope.filter(alice, 'host', archived))).toMatchObject({
      payload: { archivedSessionIds: ['alice-session'] },
    })

    const workspaceOrder = wire('host', {
      type: 'host/workspace-order-changed',
      workspaceIds: ['work-1'],
    })
    await expect(scope.filter(alice, 'host', workspaceOrder)).resolves.toBe(workspaceOrder)
    const streamError = wire('host', {
      type: 'stream/error',
      error: { code: 'internal', message: 'boom', details: {} },
    })
    await expect(scope.filter(bob, 'host', streamError)).resolves.toBe(streamError)
  })

  it('uses rc.2 remote-event ownership and correlation fields', async () => {
    const { scope } = fixture()
    const preset = remote('agent-preset/selected', ['alice-session', 'coding'])
    await expect(scope.filter(alice, 'host', preset)).resolves.toBe(preset)
    await expect(scope.filter(bob, 'host', preset)).resolves.toBeNull()

    const requestRun = remote('cordis/request-run', [
      {
        requestId: 'run-request-1',
        agentId: 'alice-session',
        pluginId: 'plugin-1',
        packageId: 'package-1',
        mode: 'run',
        name: 'demo',
        purpose: 'demo purpose',
        requiresApproval: true,
      },
    ])
    await expect(scope.filter(bob, 'host', requestRun)).resolves.toBeNull()
    await expect(scope.filter(alice, 'host', requestRun)).resolves.toBe(requestRun)

    const runResolved = remote('cordis/request-run-resolved', [
      { requestId: 'run-request-1', outcome: 'completed' },
    ])
    await expect(scope.filter(alice, 'host', runResolved)).resolves.toBe(runResolved)
    await expect(scope.filter(bob, 'host', runResolved)).resolves.toBeNull()

    const dynamicPackage = remote('cordis/dynamic-package', [
      {
        pluginId: 'plugin-1',
        packageId: 'package-1',
        pluginRunId: 'plugin-run-1',
        name: 'demo',
      },
    ])
    await expect(scope.filter(alice, 'host', dynamicPackage)).resolves.toBe(dynamicPackage)
    await expect(scope.filter(bob, 'host', dynamicPackage)).resolves.toBeNull()

    const retract = remote('cordis/dynamic-retract', [
      { pluginId: 'plugin-1', packageId: 'package-1', pluginRunId: 'plugin-run-1' },
    ])
    await expect(scope.filter(alice, 'host', retract)).resolves.toBe(retract)

    const inspect = remote('cordis/inspect-query', [
      {
        requestId: 'inspect-1',
        agentId: 'alice-session',
        provider: 'browser',
        method: 'read',
        input: {},
      },
    ])
    await expect(scope.filter(alice, 'host', inspect)).resolves.toBe(inspect)
    const inspectResolved = remote('cordis/inspect-query-resolved', [{ requestId: 'inspect-1' }])
    await expect(scope.filter(alice, 'host', inspectResolved)).resolves.toBe(inspectResolved)
    await expect(scope.filter(bob, 'host', inspectResolved)).resolves.toBeNull()

    for (const global of [
      remote('commands/change', []),
      remote('credentials/reference-updated', ['DEEPSEEK_API_KEY']),
      remote('llm/adapters-updated', []),
      remote('settings/document-updated', ['llm', 2]),
    ]) {
      await expect(scope.filter(alice, 'host', global)).resolves.toBe(global)
      await expect(scope.filter(bob, 'host', global)).resolves.toBe(global)
    }

    await expect(
      scope.filter(
        alice,
        'host',
        remote('cordis/request-run-resolved', [
          { requestId: 'not-observed', outcome: 'cancelled' },
        ]),
      ),
    ).resolves.toBeNull()
  })

  it('fails clearly for malformed protocols and preserves owner lookup failures', async () => {
    const { scope, ownerOf } = fixture()
    const invalidUtf8 = scope.filter(alice, 'mux', Buffer.from([0xff]))
    await expect(invalidUtf8).rejects.toMatchObject({
      name: 'LubanError',
      code: 'E_INVALID_INPUT',
    })
    await expect(invalidUtf8).rejects.toThrow('valid UTF-8')
    await expect(scope.filter(alice, 'mux', '{')).rejects.toBeInstanceOf(LubanError)
    await expect(
      scope.filter(
        alice,
        'mux',
        wire('mux', { type: 'stream/error', error: { code: 'internal' } }, ''),
      ),
    ).rejects.toThrow('rpcId must be a non-empty string')
    await expect(
      scope.filter(
        alice,
        'mux',
        wire('mux', {
          type: 'question/resolved',
          sessionId: 'alice-session',
          questionRpcId: '',
          outcome: 'cancelled',
        }),
      ),
    ).rejects.toThrow('questionRpcId must be a non-empty string')
    await expect(
      scope.filter(alice, 'mux', Buffer.from(JSON.stringify({ type: 'server-response' }))),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(
      scope.filter(
        alice,
        'mux',
        Buffer.from(
          JSON.stringify({
            type: 'server-request',
            rpcId: 'rpc',
            method: 'host/remote-event',
            payload: { type: 'stream/error', error: {} },
          }),
        ),
      ),
    ).rejects.toThrow('does not match payload type stream/error')
    await expect(
      scope.filter(alice, 'mux', wire('mux', { type: 'future/frame', sessionId: 'alice-session' })),
    ).rejects.toThrow('unknown mux frame type')
    await expect(scope.filter(alice, 'host', remote('future/event', []))).rejects.toThrow(
      'not in the DSH rc.2 allowlist',
    )
    await expect(
      scope.filter(alice, 'host', remote('cordis/request-run', [{ requestId: 'missing-fields' }])),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })

    const storageFailure = new Error('owner store offline')
    ownerOf.mockRejectedValueOnce(storageFailure)
    await expect(
      scope.filter(
        alice,
        'host',
        wire('host', {
          type: 'host/session-removed',
          sessionId: 'alice-session',
        }),
      ),
    ).rejects.toBe(storageFailure)
  })

  it('rejects contradictory correlation owners instead of overwriting them', async () => {
    const owners = new Map<string, AccountId>([
      ['alice-session', alice],
      ['bob-session', bob],
    ])
    const scope = new DshEventScope((sessionId): Promise<AccountId | null> => {
      return Promise.resolve(owners.get(sessionId) ?? null)
    })
    const request = (agentId: string): Buffer =>
      remote('cordis/request-run', [
        {
          requestId: 'same-request',
          agentId,
          pluginId: 'same-plugin',
          packageId: 'package-1',
          mode: 'run',
          name: 'demo',
          purpose: 'demo',
          requiresApproval: false,
        },
      ])

    await scope.filter(alice, 'host', request('alice-session'))
    const conflicting = scope.filter(bob, 'host', request('bob-session'))
    await expect(conflicting).rejects.toMatchObject({ code: 'E_ACCOUNT_SCOPE_MISMATCH' })
    await expect(conflicting).rejects.toThrow('Conflicting DSH')
  })
})

function fixture(): {
  readonly scope: DshEventScope
  readonly ownerOf: ReturnType<typeof vi.fn<(sessionId: string) => Promise<AccountId | null>>>
} {
  const owners = new Map<string, AccountId>([
    ['alice-session', alice],
    ['alice-parent', alice],
    ['bob-session', bob],
  ])
  const ownerOf = vi.fn((sessionId: string): Promise<AccountId | null> => {
    return Promise.resolve(owners.get(sessionId) ?? null)
  })
  return { scope: new DshEventScope(ownerOf), ownerOf }
}

function wire(
  _channel: DshEventChannel,
  payload: Readonly<Record<string, unknown>>,
  rpcId = 'push-rpc',
): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'server-request',
      rpcId,
      method: payload.type,
      payload,
    }),
    'utf8',
  )
}

function remote(event: string, args: readonly unknown[]): Buffer {
  return wire('host', { type: 'host/remote-event', event, args })
}

function decode(value: Buffer | null): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(value.toString('utf8')) as Record<string, unknown>)
}
