import { describe, expect, it, vi } from 'vitest'
import { asAccountId } from '@yin52133/dsh-luban-core'
import { DshEventScope, type DshSessionOwnerLookup } from '../src/dsh-event-scope.js'
import { RemoteReplyRegistry, RemoteStreamScope } from '../src/remote-stream-scope.js'

const alice = asAccountId('alice')
const bob = asAccountId('bob')
const lookup: DshSessionOwnerLookup = (_account, id) =>
  Promise.resolve(id.startsWith('alice') ? alice : id.startsWith('bob') ? bob : null)

function fixture(): {
  scope: RemoteStreamScope
  replies: RemoteReplyRegistry
  decline: ReturnType<typeof vi.fn<(client: string, event: string) => Promise<void>>>
} {
  const replies = new RemoteReplyRegistry()
  const decline = vi
    .fn<(client: string, event: string) => Promise<void>>()
    .mockResolvedValue(undefined)
  return {
    scope: new RemoteStreamScope(alice, lookup, replies, new DshEventScope(lookup), decline),
    replies,
    decline,
  }
}

describe('Remote stream account policy', () => {
  it('authorizes durable addresses and fails closed for unknown endpoints', async () => {
    const { scope } = fixture()
    const payload = (id: string): unknown => ({
      args: { request: { address: { kind: 'session', sessionId: id } } },
    })
    expect(await scope.open('foreign', 'session/follow', payload('bob-session'))).toBe(false)
    expect(await scope.open('missing', 'session/follow', payload('unbound'))).toBe(false)
    expect(await scope.open('unknown', 'new/stream', {})).toBe(false)
    expect(await scope.open('own', 'session/follow', payload('alice-session'))).toBe(true)
    expect(await scope.filter('own', { type: 'event', event: { seq: 1 } })).toMatchObject({
      type: 'event',
    })
    await expect(scope.open('own', 'session/control', {})).rejects.toThrow('duplicate')
    scope.cancel('own')
    expect(await scope.filter('own', { type: 'event' })).toBeNull()
  })

  it('filters control baselines and live deltas by the same ownership policy', async () => {
    const { scope } = fixture()
    await scope.open('control', 'session/control', { args: {} })
    const rows = { 'alice-session': [], 'bob-session': ['secret'], unbound: ['secret'] }
    expect(
      await scope.filter('control', {
        type: 'baseline',
        value: { queues: rows, jobs: rows, projections: rows },
      }),
    ).toEqual({
      type: 'baseline',
      value: {
        queues: { 'alice-session': [] },
        jobs: { 'alice-session': [] },
        projections: { 'alice-session': [] },
      },
    })
    for (const type of ['queue', 'jobs', 'projection']) {
      expect(await scope.filter('control', { type, sessionId: 'bob-session' })).toBeNull()
      expect(await scope.filter('control', { type, sessionId: 'alice-session' })).not.toBeNull()
    }
    await expect(scope.filter('control', { type: 'unknown' })).rejects.toThrow('Unknown')
  })

  it('keeps workspace structure but removes foreign and unbound memberships', async () => {
    const { scope } = fixture()
    await scope.open('workspaces', 'workspace/follow', { args: {} })
    expect(
      await scope.filter('workspaces', {
        type: 'baseline',
        value: {
          items: [
            { id: 'shared-directory', sessionIds: ['alice-session', 'bob-session', 'unbound'] },
          ],
          archivedSessionIds: ['bob-session', 'alice-session'],
        },
      }),
    ).toEqual({
      type: 'baseline',
      value: {
        items: [{ id: 'shared-directory', sessionIds: ['alice-session'] }],
        archivedSessionIds: ['alice-session'],
      },
    })
  })

  it('correlates replies, declines foreign waterfalls, and clears correlation on cancellation/disconnect', async () => {
    const { scope, replies, decline } = fixture()
    await scope.open('events', '$events', { args: {} })
    await scope.filter('events', {
      type: 'ready',
      clientId: 'connection-1',
      host: { home: '/test' },
    })
    const request = {
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'prompt',
      agentId: 'alice-session',
      request: {},
    }
    expect(await scope.filter('events', request)).toEqual(request)
    const reply = {
      args: {
        clientId: 'connection-1',
        eventId: 'prompt',
        outcome: { kind: 'result', value: true },
      },
    }
    expect(replies.accepts(alice, reply)).toBe(true)
    expect(replies.accepts(bob, reply)).toBe(false)
    expect(replies.accepts(alice, { args: { clientId: 'forged', eventId: 'prompt' } })).toBe(false)
    expect(
      await scope.filter('events', { ...request, agentId: 'bob-session', eventId: 'foreign' }),
    ).toBeNull()
    expect(decline).toHaveBeenCalledWith('connection-1', 'foreign')
    expect(await scope.filter('events', { type: 'cancel', eventId: 'foreign' })).toBeNull()
    expect(await scope.filter('events', { type: 'cancel', eventId: 'prompt' })).not.toBeNull()
    expect(replies.accepts(alice, reply)).toBe(false)
    await scope.filter('events', request)
    scope.dispose()
    expect(replies.accepts(alice, reply)).toBe(false)
  })

  it('filters session notifications without losing global model/settings notifications', async () => {
    const { scope } = fixture()
    await scope.open('events', '$events', { args: {} })
    await scope.filter('events', { type: 'ready', clientId: 'client' })
    expect(
      await scope.filter('events', {
        type: 'emit',
        event: 'api-session/status',
        args: ['bob-session', true],
      }),
    ).toBeNull()
    expect(
      await scope.filter('events', {
        type: 'emit',
        event: 'api-session/added',
        args: [{ sessionId: 'alice-session', parentSessionId: 'bob-session' }],
      }),
    ).toEqual({
      type: 'emit',
      event: 'api-session/added',
      args: [{ sessionId: 'alice-session' }],
    })
    expect(
      await scope.filter('events', { type: 'emit', event: 'llm/adapters-updated', args: [] }),
    ).not.toBeNull()
  })
})
