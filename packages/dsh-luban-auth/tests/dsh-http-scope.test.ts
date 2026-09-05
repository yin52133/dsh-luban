import { describe, expect, it } from 'vitest'
import { dshMethodFromPath, dshRequestSessionIds } from '../src/dsh-http-scope.js'

const LEGACY_SESSION_ID_METHODS = [
  'session.create',
  'session.history',
  'session.models',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.attachment',
  'session.updateQueue',
  'session.cancel',
  'skill.list',
  'agentPreset.select',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
] as const

const TYPERT_AGENT_ID_METHODS = [
  'commands/execute',
  'commands/list',
  'fileReferences/list',
  'goals/clear',
  'goals/complete',
  'goals/create',
  'goals/edit',
  'goals/pause',
  'goals/resume',
  'sessionReferenceResolver/candidates',
  'dynamicCordisRunner/getClientCode',
  'dynamicCordisRunner/reportClientGuardFailure',
  'dynamicCordisRunner/reportRenderFailure',
  'dynamicCordisRunner/resolveInspectQuery',
  'dynamicCordisRunner/runHostHalf',
  'dynamicCordisRunner/settleUserRun',
  'dynamicCordisRunner/stopFromPanel',
  'dynamicCordisRunner/undefineFromPanel',
] as const

describe('dshMethodFromPath', () => {
  it.each([
    ['/api/session.prompt', 'session.prompt'],
    ['/api/session/create', 'session.create'],
    ['/api/session/follow', 'session.follow'],
    ['/api/workspace/follow', 'workspace.follow'],
    ['/api/commands/list', 'commands/list'],
    ['/api/dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/runHostHalf'],
    ['/api/commands/list/extra', 'commands/list/extra'],
    ['/api/respond', 'respond'],
    ['/api/', undefined],
    ['/api', undefined],
    ['/private/session.prompt', undefined],
  ] as const)('maps %s to %s', (pathname, expected) => {
    expect(dshMethodFromPath(pathname)).toBe(expected)
  })
})

describe('dshRequestSessionIds', () => {
  it('reads Typert requests and durable session addresses without changing the forwarded body', () => {
    expect(
      dshRequestSessionIds(
        'session.prompt',
        request('session/prompt', {
          args: { request: { sessionId: 'owned', content: [] } },
        }),
      ),
    ).toEqual(['owned'])
    expect(
      dshRequestSessionIds(
        'session.follow',
        request('session/follow', {
          args: { request: { address: { kind: 'session', sessionId: 'owned' } } },
        }),
      ),
    ).toEqual(['owned'])
    expect(
      dshRequestSessionIds(
        'session.page',
        request('session/page', {
          args: {
            request: {
              address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child' },
            },
          },
        }),
      ),
    ).toEqual(['parent', 'child'])
  })

  it.each(LEGACY_SESSION_ID_METHODS)('extracts %s payload.sessionId', (method) => {
    expect(dshRequestSessionIds(method, request(method, { sessionId: 'owned-session' }))).toEqual([
      'owned-session',
    ])
  })

  it.each([
    [
      'workspace.insertSessionBefore',
      { sessionId: 'moving', beforeSessionId: 'anchor' },
      ['moving', 'anchor'],
    ],
    ['workspace.archiveSession', { sessionId: 'archived' }, ['archived']],
    ['subagent.list', { parentSessionId: 'parent' }, ['parent']],
    [
      'subagent.history',
      { parentSessionId: 'parent', childSessionId: 'child' },
      ['parent', 'child'],
    ],
    [
      'subagent.prompt',
      { parentSessionId: 'parent', childSessionId: 'child' },
      ['parent', 'child'],
    ],
    [
      'subagent.interrupt',
      { parentSessionId: 'parent', childSessionId: 'child' },
      ['parent', 'child'],
    ],
  ] as const)('extracts the exact %s resource fields', (method, payload, expected) => {
    expect(dshRequestSessionIds(method, request(method, payload))).toEqual(expected)
  })

  it.each(TYPERT_AGENT_ID_METHODS)('extracts %s payload.args.agentId', (method) => {
    expect(
      dshRequestSessionIds(method, request(method, { args: { agentId: 'agent-session' } })),
    ).toEqual(['agent-session'])
  })

  it.each(['messageFeedback/delete', 'messageFeedback/list', 'messageFeedback/put'] as const)(
    'extracts %s payload.args.request.sessionId',
    (method) => {
      expect(
        dshRequestSessionIds(
          method,
          request(method, { args: { request: { sessionId: 'feedback-session' } } }),
        ),
      ).toEqual(['feedback-session'])
    },
  )

  it('extracts the session id from a successful respond value', () => {
    expect(
      dshRequestSessionIds('respond', {
        type: 'client-response',
        rpcId: 'rpc-respond',
        result: { ok: true, value: { sessionId: 'response-session' } },
      }),
    ).toEqual(['response-session'])
  })

  it('extracts canonical session references from text prompt parts in appearance order', () => {
    const alpha = encodeSessionReferenceUri('alpha/session')
    const unicode = encodeSessionReferenceUri('会话“二”')
    const escaped = encodeSessionReferenceUri('quote"slash\\session')

    expect(
      dshRequestSessionIds(
        'session.prompt',
        request('session.prompt', {
          sessionId: 'target-session',
          content: [
            { type: 'text', text: `Compare @[Alpha](${alpha}) with ${unicode}.` },
            { type: 'image', text: escaped },
            { type: 'text', text: `Then inspect ${escaped}` },
          ],
        }),
      ),
    ).toEqual(['target-session', 'alpha/session', '会话“二”', 'quote"slash\\session'])
  })

  it('leaves malformed and noncanonical prompt references for DSH to reject', () => {
    const padded = `dsh-session:${Buffer.from(JSON.stringify('padded'), 'utf8').toString('base64')}`
    const nonString = `dsh-session:${Buffer.from('42', 'utf8').toString('base64url')}`
    const invalidJson = `dsh-session:${Buffer.from('{', 'utf8').toString('base64url')}`
    const message = request('session.prompt', {
      sessionId: 'target-session',
      content: [
        {
          type: 'text',
          text: `@[empty](dsh-session:) @[bad](dsh-session:!) @[padded](${padded}) ${nonString} ${invalidJson}`,
        },
      ],
    })

    expect(() => dshRequestSessionIds('session.prompt', message)).not.toThrow()
    expect(dshRequestSessionIds('session.prompt', message)).toEqual(['target-session'])
  })

  it.each([
    [
      'dynamicCordisRunner/invoke',
      { args: { sessionId: 'plugin-business-value', nested: { sessionId: 'nested-value' } } },
    ],
    ['settings.update', { patch: { sessionId: 'setting-value' } }],
    ['settings.replace', { section: { sessionId: 'setting-value' } }],
    ['settings.mutate', { ops: [{ value: { sessionId: 'setting-value' } }] }],
    ['pluginInventory/list', { args: { agentId: 'ordinary-value' } }],
    ['session.list', { sessionId: 'unknown-field' }],
    ['unknown/method', { sessionId: 'unknown', args: { agentId: 'unknown' } }],
  ] as const)('does not recursively scan business JSON for %s', (method, payload) => {
    expect(dshRequestSessionIds(method, request(method, payload))).toEqual([])
  })

  it('ignores missing, empty, and wrongly typed contract fields', () => {
    expect(
      dshRequestSessionIds(undefined, request('session.prompt', { sessionId: 'ignored' })),
    ).toEqual([])
    expect(dshRequestSessionIds('session.history', null)).toEqual([])
    expect(dshRequestSessionIds('session.history', request('session.history', {}))).toEqual([])
    expect(
      dshRequestSessionIds('session.history', request('session.history', { sessionId: '' })),
    ).toEqual([])
    expect(
      dshRequestSessionIds('commands/list', request('commands/list', { args: { agentId: 7 } })),
    ).toEqual([])
  })
})

function request(method: string, payload: unknown): Record<string, unknown> {
  return { type: 'client-request', rpcId: `rpc-${method}`, method, payload }
}

function encodeSessionReferenceUri(sessionId: string): string {
  return `dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`
}
