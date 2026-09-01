import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { asAccountId, asSessionId } from '@yin52133/dsh-luban-core'
import { localHostnames, parseUpstream, resolveAuthConfig } from '../src/config.js'
import { AuthSidecar } from '../src/sidecar.js'
import type { LubanAuthConfig } from '../src/types.js'
import { createManagerFixture, type ManagerFixture } from './helpers.js'

interface IntegrationHarness {
  readonly fixture: ManagerFixture
  readonly upstream: Server
  readonly sidecar: AuthSidecar
  readonly upstreamState: UpstreamTestState
  readonly baseUrl: string
  readonly publicPort: number
  close(): Promise<void>
}

interface TestRpcResponse {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result: Readonly<Record<string, unknown>>
}

interface UpstreamTestState {
  readonly racedHostStreams: Set<ServerResponse>
  readonly racedHostWaiters: Set<() => void>
}

const upstreamUpgradeSockets = new WeakMap<Server, Set<Duplex>>()

describe('AuthSidecar integration', () => {
  let harness: IntegrationHarness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it('guards business routes, proxies static/HTTP/SSE, and enforces request security', async () => {
    harness = await createHarness()
    const { baseUrl } = harness

    const navigation = await fetch(`${baseUrl}/business?tab=one`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.get('location')).toContain('/luban-auth/login?returnTo=')

    const api = await fetch(`${baseUrl}/api/private`)
    expect(api.status).toBe(401)
    const loginPage = await fetch(
      `${baseUrl}/luban-auth/login?returnTo=${encodeURIComponent('/tasks?<unsafe>')}`,
    )
    expect(loginPage.status).toBe(200)
    expect(await loginPage.text()).toContain('/tasks?&lt;unsafe&gt;')
    expect((await fetch(`${baseUrl}/luban-auth/login`, { method: 'HEAD' })).status).toBe(200)
    expect((await fetch(`${baseUrl}/luban-auth/login`, { method: 'PUT' })).status).toBe(405)
    const asset = await fetch(`${baseUrl}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('static asset')

    const hostileHost = await rawHttpRequest(harness.publicPort, '/api/private', {
      host: 'attacker.invalid',
    })
    expect(hostileHost.status).toBe(403)

    const crossOriginLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.invalid' },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    expect(crossOriginLogin.status).toBe(403)

    const oversized = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'x'.repeat(2_000) }),
    })
    expect(oversized.status).toBe(413)

    const invalidJsonLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'admin', password: 'wrong pass' }),
    })
    expect(invalidJsonLogin.status).toBe(401)
    const invalidFormLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        origin: baseUrl,
      },
      body: new URLSearchParams({ user: 'admin', password: 'wrong pass', returnTo: '/' }),
    })
    expect(invalidFormLogin.status).toBe(401)
    expect(await invalidFormLogin.text()).toContain('Invalid credentials')

    const login = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    expect(login.status).toBe(200)
    const setCookies = splitSetCookie(login.headers.get('set-cookie'))
    expect(setCookies.find((value) => value.startsWith('luban_session='))).toMatch(
      /HttpOnly; SameSite=Lax/u,
    )
    expect(setCookies.find((value) => value.startsWith('luban_csrf='))).toMatch(/SameSite=Lax/u)
    const cookie = cookieHeader(setCookies)
    const csrf = cookieValue(cookie, 'luban_csrf')

    const proxied = await fetch(`${baseUrl}/business`, { headers: { cookie } })
    expect(proxied.status).toBe(200)
    const proxyBody = (await proxied.json()) as { path: string; cookie: string }
    expect(proxyBody.path).toBe('/business')
    expect(proxyBody.cookie).toContain('luban_session=')

    const missingCsrf = await fetch(`${baseUrl}/business`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'mutation',
    })
    expect(missingCsrf.status).toBe(403)
    const crossOriginMutation = await fetch(`${baseUrl}/business`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', origin: 'http://attacker.invalid' },
      body: 'mutation',
    })
    expect(crossOriginMutation.status).toBe(403)
    const csrfMutation = await fetch(`${baseUrl}/business`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', 'x-luban-csrf': csrf },
      body: 'mutation',
    })
    expect(csrfMutation.status).toBe(200)

    const session = await fetch(`${baseUrl}/luban-auth/session`, { headers: { cookie } })
    expect(await session.json()).toMatchObject({ user: 'admin', role: 'admin', csrfToken: csrf })
    expect(
      (
        await fetch(`${baseUrl}/luban-auth/session`, {
          method: 'POST',
          headers: { cookie, origin: baseUrl },
        })
      ).status,
    ).toBe(405)
    expect((await fetch(`${baseUrl}/luban-auth/logout`, { headers: { cookie } })).status).toBe(405)
    expect((await fetch(`${baseUrl}/luban-auth/unknown`, { headers: { cookie } })).status).toBe(404)

    const invalidUser = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass', role: 'owner' }),
    })
    expect(invalidUser.status).toBe(400)
    const provision = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass', role: 'operator' }),
    })
    expect(provision.status).toBe(201)
    const duplicateUser = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass', role: 'operator' }),
    })
    expect(duplicateUser.status).toBe(409)
    expect((await fetch(`${baseUrl}/luban-auth/users`, { headers: { cookie } })).status).toBe(405)

    const operatorLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass' }),
    })
    const operatorCookie = cookieHeader(splitSetCookie(operatorLogin.headers.get('set-cookie')))
    const operatorDenied = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie: operatorCookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'other', password: 'other password', role: 'observer' }),
    })
    expect(operatorDenied.status).toBe(403)
    const operatorRevokeDenied = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie: operatorCookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'admin' }),
    })
    expect(operatorRevokeDenied.status).toBe(403)
    const invalidRevoke = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 42 }),
    })
    expect(invalidRevoke.status).toBe(400)
    const malformedRevoke = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: '!!!' }),
    })
    expect(malformedRevoke.status).toBe(400)
    const revokeOperator = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator' }),
    })
    expect(revokeOperator.status).toBe(200)
    expect(
      (await fetch(`${baseUrl}/api/private`, { headers: { cookie: operatorCookie } })).status,
    ).toBe(401)

    const redirect = await fetch(`${baseUrl}/redirect`, {
      headers: { cookie },
      redirect: 'manual',
    })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(`${baseUrl}/target`)

    const startedAt = Date.now()
    const events = await fetch(`${baseUrl}/events`, { headers: { cookie } })
    const reader = events.body?.getReader()
    expect(reader).toBeDefined()
    const firstChunk = await reader?.read()
    expect(new TextDecoder().decode(firstChunk?.value)).toContain('data: first')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    await reader?.cancel()

    const logout = await fetch(`${baseUrl}/luban-auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: baseUrl },
    })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await fetch(`${baseUrl}/api/private`, { headers: { cookie } })).status).toBe(401)
  })

  it('scopes native DSH session HTTP and fallback events by authenticated account', async () => {
    harness = await createHarness()
    const aliceCookie = await loginUser(harness.baseUrl, 'admin', 'correct horse')
    const provision = await fetch(`${harness.baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: {
        cookie: aliceCookie,
        'content-type': 'application/json',
        origin: harness.baseUrl,
      },
      body: JSON.stringify({ user: 'bob', password: 'bob password', role: 'operator' }),
    })
    expect(provision.status).toBe(201)
    const bobCookie = await loginUser(harness.baseUrl, 'bob', 'bob password')
    await harness.fixture.manager.bindDshSession(asAccountId('admin'), asSessionId('alice-session'))
    await harness.fixture.manager.bindDshSession(asAccountId('bob'), asSessionId('bob-session'))

    const aliceList = await dshRpc(harness.baseUrl, aliceCookie, 'session.list', {})
    expect(sessionIdsFromRpc(aliceList)).toEqual(['alice-session'])
    const bobList = await dshRpc(harness.baseUrl, bobCookie, 'session.list', {})
    expect(sessionIdsFromRpc(bobList)).toEqual(['bob-session'])
    const aliceSearch = await dshRpc(harness.baseUrl, aliceCookie, 'session.search', {
      query: 'session',
    })
    expect(sessionIdsFromRpc(aliceSearch)).toEqual(['alice-session'])

    for (const method of [
      'session.history',
      'session.models',
      'session.selectModel',
      'session.rename',
      'session.fork',
      'session.prompt',
      'session.attachment',
      'session.updateQueue',
      'session.cancel',
    ]) {
      const denied = await dshRpc(harness.baseUrl, aliceCookie, method, {
        sessionId: 'bob-session',
      })
      expect(denied.result).toMatchObject({
        ok: false,
        error: {
          code: 'session-not-found',
          details: { sessionId: 'bob-session' },
        },
      })
      expect(asTestRecord(denied.result.error)?.message).toContain('E_ACCOUNT_SCOPE_MISMATCH')
    }
    const legacyDenied = await dshRpc(harness.baseUrl, aliceCookie, 'session.history', {
      sessionId: 'legacy-session',
    })
    expect(legacyDenied.result).toMatchObject({
      ok: false,
      error: { details: { sessionId: 'legacy-session' } },
    })
    const ownHistory = await dshRpc(harness.baseUrl, aliceCookie, 'session.history', {
      sessionId: 'alice-session',
    })
    expect(ownHistory.result).toMatchObject({ ok: true })

    const created = await dshRpc(harness.baseUrl, aliceCookie, 'session.create', {})
    expect(created.result).toMatchObject({
      ok: true,
      value: { sessionId: 'created-session' },
    })
    expect(await harness.fixture.manager.dshSessionOwner(asSessionId('created-session'))).toBe(
      asAccountId('admin'),
    )
    const explicitLegacy = await dshRpc(harness.baseUrl, aliceCookie, 'session.create', {
      sessionId: 'legacy-session',
    })
    expect(explicitLegacy.result).toMatchObject({
      ok: false,
      error: { details: { sessionId: 'legacy-session' } },
    })
    const explicitForeign = await dshRpc(harness.baseUrl, aliceCookie, 'session.create', {
      sessionId: 'bob-session',
    })
    expect(explicitForeign.result).toMatchObject({
      ok: false,
      error: { details: { sessionId: 'bob-session' } },
    })
    const explicitOwn = await dshRpc(harness.baseUrl, aliceCookie, 'session.create', {
      sessionId: 'alice-session',
    })
    expect(explicitOwn.result).toMatchObject({
      ok: true,
      value: { sessionId: 'alice-session' },
    })
    const forked = await dshRpc(harness.baseUrl, aliceCookie, 'session.fork', {
      sessionId: 'alice-session',
    })
    expect(forked.result).toMatchObject({ ok: true, value: { sessionId: 'forked-session' } })
    expect(await harness.fixture.manager.dshSessionOwner(asSessionId('forked-session'))).toBe(
      asAccountId('admin'),
    )
    const partiallyForked = await dshRpc(harness.baseUrl, aliceCookie, 'session.fork', {
      sessionId: 'alice-session',
      atSeq: 999,
    })
    expect(partiallyForked.result).toMatchObject({
      ok: false,
      error: {
        code: 'workspace-attach-failed',
        details: { sessionId: 'partial-fork-session' },
      },
    })
    expect(await harness.fixture.manager.dshSessionOwner(asSessionId('partial-fork-session'))).toBe(
      asAccountId('admin'),
    )

    const workspaceList = await dshRpc(harness.baseUrl, aliceCookie, 'workspace.list', {})
    expect(workspaceList.result).toMatchObject({
      ok: true,
      value: {
        workspaces: [{ sessionIds: ['alice-session'] }],
        archivedSessionIds: ['alice-session'],
      },
    })
    const genericDenied = await dshRpc(harness.baseUrl, aliceCookie, 'goal.create', {
      sessionId: 'bob-session',
    })
    expect(genericDenied.result).toMatchObject({ ok: false })

    const foreignExport = await fetch(
      `${harness.baseUrl}/api/session.export?sessionId=bob-session`,
      { headers: { cookie: aliceCookie } },
    )
    expect(foreignExport.status).toBe(404)
    expect(await foreignExport.json()).toMatchObject({ error: 'E_ACCOUNT_SCOPE_MISMATCH' })
    const foreignExportHead = await fetch(
      `${harness.baseUrl}/api/session.export?sessionId=bob-session`,
      { method: 'HEAD', headers: { cookie: aliceCookie } },
    )
    expect(foreignExportHead.status).toBe(404)
    const ownExport = await fetch(`${harness.baseUrl}/api/session.export?sessionId=alice-session`, {
      headers: { cookie: aliceCookie },
    })
    expect(await ownExport.text()).toBe('export:alice-session')

    const mux = await fetch(`${harness.baseUrl}/api/events.mux`, {
      headers: { cookie: aliceCookie },
    })
    const muxText = await mux.text()
    expect(muxText).toContain('alice-session')
    expect(muxText).not.toContain('bob-session')
    expect(muxText).not.toContain('legacy-session')
    const host = await fetch(`${harness.baseUrl}/api/events.host`, {
      headers: { cookie: aliceCookie },
    })
    const hostText = await host.text()
    expect(hostText).toContain('alice-session')
    expect(hostText).not.toContain('bob-session')
    expect(hostText).not.toContain('legacy-session')

    const foreignCancellation = await fetch(`${harness.baseUrl}/api/respond`, {
      method: 'POST',
      headers: {
        cookie: bobCookie,
        'content-type': 'application/json',
        origin: harness.baseUrl,
      },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: 'alice-question-cancel',
        result: {
          ok: false,
          error: { code: 'cancelled', message: 'Question cancelled' },
        },
      }),
    })
    expect(foreignCancellation.status).toBe(200)
    await expect(foreignCancellation.json()).resolves.toEqual({
      accepted: false,
      reason: 'not-pending',
    })

    const ownCancellation = await fetch(`${harness.baseUrl}/api/respond`, {
      method: 'POST',
      headers: {
        cookie: aliceCookie,
        'content-type': 'application/json',
        origin: harness.baseUrl,
      },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: 'alice-question-cancel',
        result: {
          ok: false,
          error: { code: 'cancelled', message: 'Question cancelled' },
        },
      }),
    })
    expect(ownCancellation.status).toBe(200)
    await expect(ownCancellation.json()).resolves.toEqual({ accepted: true })

    const foreignResponse = await fetch(`${harness.baseUrl}/api/respond`, {
      method: 'POST',
      headers: {
        cookie: aliceCookie,
        'content-type': 'application/json',
        origin: harness.baseUrl,
      },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: 'bob-question',
        result: {
          ok: true,
          value: { sessionId: 'bob-session', answer: { answers: [] } },
        },
      }),
    })
    expect(foreignResponse.status).toBe(200)
    await expect(foreignResponse.json()).resolves.toEqual({
      accepted: false,
      reason: 'not-pending',
    })

    const ownResponse = await fetch(`${harness.baseUrl}/api/respond`, {
      method: 'POST',
      headers: {
        cookie: aliceCookie,
        'content-type': 'application/json',
        origin: harness.baseUrl,
      },
      body: JSON.stringify({
        type: 'client-response',
        rpcId: 'alice-question',
        result: {
          ok: true,
          value: { sessionId: 'alice-session', answer: { answers: [] } },
        },
      }),
    })
    expect(ownResponse.status).toBe(200)
    await expect(ownResponse.json()).resolves.toEqual({ accepted: true })
  })

  it('scopes native DSH slash RPCs, references, Cordis relations, and subagents', async () => {
    harness = await createHarness()
    const aliceCookie = await loginUser(harness.baseUrl, 'admin', 'correct horse')
    const provision = await fetch(`${harness.baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: {
        cookie: aliceCookie,
        'content-type': 'application/json',
        origin: harness.baseUrl,
      },
      body: JSON.stringify({ user: 'bob', password: 'bob password', role: 'operator' }),
    })
    expect(provision.status).toBe(201)
    const bobCookie = await loginUser(harness.baseUrl, 'bob', 'bob password')
    await harness.fixture.manager.bindDshSession(asAccountId('admin'), asSessionId('alice-session'))
    await harness.fixture.manager.bindDshSession(
      asAccountId('admin'),
      asSessionId('alice-reference'),
    )
    await harness.fixture.manager.bindDshSession(asAccountId('bob'), asSessionId('bob-session'))

    const agentScopedMethods = [
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
    for (const method of agentScopedMethods) {
      const denied = await dshRpc(harness.baseUrl, aliceCookie, method, {
        args: { agentId: 'bob-session' },
      })
      expect(denied.result).toMatchObject({
        ok: false,
        error: { code: 'session-not-found', details: { sessionId: 'bob-session' } },
      })
    }

    const ownCommand = await dshRpc(harness.baseUrl, aliceCookie, 'commands/list', {
      args: { agentId: 'alice-session' },
    })
    expect(ownCommand.result).toMatchObject({ ok: true })
    const foreignFeedback = await dshRpc(harness.baseUrl, aliceCookie, 'messageFeedback/list', {
      args: { request: { sessionId: 'bob-session' } },
    })
    expect(foreignFeedback.result).toMatchObject({ ok: false })
    const sharedSettings = await dshRpc(harness.baseUrl, aliceCookie, 'settings.update', {
      patch: { sessionId: 'bob-session' },
    })
    expect(sharedSettings.result).toMatchObject({ ok: true })

    const candidates = await dshRpc(
      harness.baseUrl,
      aliceCookie,
      'sessionReferenceResolver/candidates',
      { args: { agentId: 'alice-session', query: '' } },
    )
    expect(candidates.result.value).toEqual([
      expect.objectContaining({ sessionId: 'alice-reference', label: 'Alice reference' }),
    ])

    const foreignReference = await dshRpc(harness.baseUrl, aliceCookie, 'session.prompt', {
      sessionId: 'alice-session',
      mode: 'queue',
      content: [{ type: 'text', text: `Read ${dshSessionUri('bob-session')}` }],
    })
    expect(foreignReference.result).toMatchObject({
      ok: false,
      error: { details: { sessionId: 'bob-session' } },
    })
    const ownReference = await dshRpc(harness.baseUrl, aliceCookie, 'session.prompt', {
      sessionId: 'alice-session',
      mode: 'queue',
      content: [{ type: 'text', text: `Read ${dshSessionUri('alice-reference')}` }],
    })
    expect(ownReference.result).toMatchObject({ ok: true })

    const inventory = await dshRpc(harness.baseUrl, aliceCookie, 'dynamicCordisRunner/inventory', {
      args: {},
    })
    expect(inventory.result.value).toEqual([
      expect.objectContaining({ pluginId: 'alice-plugin', agentId: 'alice-session' }),
    ])
    const foreignInvoke = await dshRpc(harness.baseUrl, aliceCookie, 'dynamicCordisRunner/invoke', {
      args: { pluginId: 'bob-plugin', pluginRunId: 'bob-run', method: 'read', args: {} },
    })
    expect(foreignInvoke.result).toMatchObject({
      ok: true,
      value: { ok: false, code: 'plugin-not-running' },
    })
    const ownInvoke = await dshRpc(harness.baseUrl, aliceCookie, 'dynamicCordisRunner/invoke', {
      args: {
        pluginId: 'alice-plugin',
        pluginRunId: 'alice-run',
        method: 'read',
        args: { sessionId: 'bob-session' },
      },
    })
    expect(ownInvoke.result).toMatchObject({ ok: true, value: { accepted: true } })

    const foreignResolution = await dshRpc(
      harness.baseUrl,
      aliceCookie,
      'dynamicCordisRunner/resolveRequestRun',
      { args: { requestId: 'bob-approval', resolution: { ok: false, reason: 'rejected' } } },
    )
    expect(foreignResolution.result).toMatchObject({
      ok: true,
      value: { accepted: false },
    })
    const ownResolution = await dshRpc(
      harness.baseUrl,
      aliceCookie,
      'dynamicCordisRunner/resolveRequestRun',
      { args: { requestId: 'alice-approval', resolution: { ok: false, reason: 'rejected' } } },
    )
    expect(ownResolution.result).toMatchObject({ ok: true, value: { accepted: true } })

    const subagents = await dshRpc(harness.baseUrl, aliceCookie, 'subagent.list', {
      parentSessionId: 'alice-session',
    })
    expect(subagents.result).toMatchObject({
      ok: true,
      value: { entries: [{ kind: 'child', id: 'alice-child' }] },
    })
    expect(await harness.fixture.manager.dshSessionOwner(asSessionId('alice-child'))).toBe(
      asAccountId('admin'),
    )
    const ownChildHistory = await dshRpc(harness.baseUrl, aliceCookie, 'subagent.history', {
      parentSessionId: 'alice-session',
      childSessionId: 'alice-child',
      mode: 'continuable',
    })
    expect(ownChildHistory.result).toMatchObject({ ok: true })
    const foreignChildHistory = await dshRpc(harness.baseUrl, bobCookie, 'subagent.history', {
      parentSessionId: 'bob-session',
      childSessionId: 'alice-child',
      mode: 'continuable',
    })
    expect(foreignChildHistory.result).toMatchObject({ ok: false })
  })

  it('holds create events until owner binding and releases them on success or failure', async () => {
    harness = await createHarness()
    const aliceCookie = await loginUser(harness.baseUrl, 'admin', 'correct horse')
    const provision = await fetch(`${harness.baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: {
        cookie: aliceCookie,
        'content-type': 'application/json',
        origin: harness.baseUrl,
      },
      body: JSON.stringify({ user: 'bob', password: 'bob password', role: 'operator' }),
    })
    expect(provision.status).toBe(201)
    const bobCookie = await loginUser(harness.baseUrl, 'bob', 'bob password')

    const aliceHostRequest = fetch(`${harness.baseUrl}/api/events.host?race=create`, {
      headers: { cookie: aliceCookie },
    })
    const bobHostRequest = fetch(`${harness.baseUrl}/api/events.host?race=create`, {
      headers: { cookie: bobCookie },
    })
    await waitForRacedHostStreams(harness.upstreamState, 2)
    const created = await dshRpc(harness.baseUrl, aliceCookie, 'session.create', {
      race: 'success',
    })
    expect(created.result).toMatchObject({
      ok: true,
      value: { sessionId: 'raced-session' },
    })
    const [aliceHost, bobHost] = await Promise.all([aliceHostRequest, bobHostRequest])
    const [aliceEvents, bobEvents] = await Promise.all([aliceHost.text(), bobHost.text()])
    expect(aliceEvents).toContain('raced-session')
    expect(aliceEvents.indexOf('host/session-added')).toBeGreaterThanOrEqual(0)
    expect(aliceEvents.indexOf('host/workspace-changed')).toBeGreaterThan(
      aliceEvents.indexOf('host/session-added'),
    )
    expect(bobEvents).not.toContain('raced-session')
    expect(await harness.fixture.manager.dshSessionOwner(asSessionId('raced-session'))).toBe(
      asAccountId('admin'),
    )

    const aliceForkHostRequest = fetch(`${harness.baseUrl}/api/events.host?race=create`, {
      headers: { cookie: aliceCookie },
    })
    const bobForkHostRequest = fetch(`${harness.baseUrl}/api/events.host?race=create`, {
      headers: { cookie: bobCookie },
    })
    await waitForRacedHostStreams(harness.upstreamState, 2)
    const forked = await dshRpc(harness.baseUrl, aliceCookie, 'session.fork', {
      sessionId: 'raced-session',
      race: 'success',
    })
    expect(forked.result).toMatchObject({
      ok: true,
      value: { sessionId: 'raced-fork-session' },
    })
    const [aliceForkHost, bobForkHost] = await Promise.all([
      aliceForkHostRequest,
      bobForkHostRequest,
    ])
    const [aliceForkEvents, bobForkEvents] = await Promise.all([
      aliceForkHost.text(),
      bobForkHost.text(),
    ])
    expect(aliceForkEvents).toContain('raced-fork-session')
    expect(aliceForkEvents).toContain('raced-session')
    expect(bobForkEvents).not.toContain('raced-fork-session')
    expect(await harness.fixture.manager.dshSessionOwner(asSessionId('raced-fork-session'))).toBe(
      asAccountId('admin'),
    )

    const failedHostRequest = fetch(`${harness.baseUrl}/api/events.host?race=create`, {
      headers: { cookie: aliceCookie },
    })
    await waitForRacedHostStreams(harness.upstreamState, 1)
    const failed = await dshRpc(harness.baseUrl, aliceCookie, 'session.create', {
      race: 'failure',
    })
    expect(failed.result).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    const failedHost = await failedHostRequest
    expect(await failedHost.text()).not.toContain('failed-race-session')
    expect(
      await harness.fixture.manager.dshSessionOwner(asSessionId('failed-race-session')),
    ).toBeNull()
  })

  it('protects and tunnels WebSocket upgrades and closes upgraded resources', async () => {
    harness = await createHarness()
    const unauthorized = await openUpgrade(harness.publicPort)
    expect(unauthorized.head).toContain('401 Unauthorized')
    unauthorized.socket.destroy()

    const login = await fetch(`${harness.baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.baseUrl },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    const cookie = cookieHeader(splitSetCookie(login.headers.get('set-cookie')))
    const hostile = await openUpgrade(harness.publicPort, cookie, 'http://attacker.invalid')
    expect(hostile.head).toContain('403 Forbidden')
    hostile.socket.destroy()

    const upgraded = await openUpgrade(harness.publicPort, cookie, harness.baseUrl)
    expect(upgraded.head).toContain('101 Switching Protocols')
    const echo = new Promise<string>((resolve) => {
      upgraded.socket.once('data', (chunk): void => resolve(chunk.toString('utf8')))
    })
    upgraded.socket.write('ping-through-sidecar')
    await expect(echo).resolves.toBe('ping-through-sidecar')

    const closed = new Promise<void>((resolve) => {
      upgraded.socket.once('close', (): void => resolve())
    })
    await harness.sidecar.stop()
    await expect(closed).resolves.toBeUndefined()
  })

  it('honors trusted proxy scheme/host and emits Secure cookies', async () => {
    harness = await createHarness({
      trustProxy: true,
      trustedHosts: ['proxy.example.test'],
    })
    const login = await fetch(`${harness.baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: '127.0.0.1',
        origin: 'https://proxy.example.test',
        'x-forwarded-host': 'proxy.example.test',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toMatch(/; Secure/u)
    const cookie = cookieHeader(splitSetCookie(login.headers.get('set-cookie')))
    const redirect = await fetch(`${harness.baseUrl}/redirect`, {
      headers: {
        cookie,
        host: '127.0.0.1',
        origin: 'https://proxy.example.test',
        'x-forwarded-host': 'proxy.example.test',
        'x-forwarded-proto': 'https',
      },
      redirect: 'manual',
    })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('https://proxy.example.test/target')
  })
})

async function createHarness(
  overrides: Partial<LubanAuthConfig> = {},
): Promise<IntegrationHarness> {
  const fixture = await createManagerFixture()
  await fixture.manager.createInitialAdmin('admin', 'correct horse')
  const { server: upstream, state: upstreamState } = createUpstreamServer()
  await listen(upstream)
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('test upstream has no port')
  const config = resolveAuthConfig({
    host: '127.0.0.1',
    port: 0,
    upstream: `http://127.0.0.1:${String(address.port)}`,
    usersFile: fixture.filePath,
    auditDirectory: fixture.directory,
    maxAuthBodyBytes: 1_024,
    ...overrides,
  })
  const sidecar = new AuthSidecar({
    config,
    upstream: parseUpstream(config.upstream),
    manager: fixture.manager,
    trustedHostnames: localHostnames(config.trustedHosts),
  })
  await sidecar.start()
  const publicPort = sidecar.port
  if (publicPort === undefined) throw new Error('test sidecar has no port')
  let closed = false
  return {
    fixture,
    upstream,
    upstreamState,
    sidecar,
    publicPort,
    baseUrl: `http://127.0.0.1:${String(publicPort)}`,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await sidecar.stop()
      await closeServer(upstream)
      await fixture.cleanup()
    },
  }
}

function createUpstreamServer(): { readonly server: Server; readonly state: UpstreamTestState } {
  const upgradeSockets = new Set<Duplex>()
  const state: UpstreamTestState = { racedHostStreams: new Set(), racedHostWaiters: new Set() }
  const server = createServer((request, response): void => {
    handleUpstreamRequest(request, response, state).catch((error: unknown): void => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  server.on('upgrade', (_request, socket): void => {
    upgradeSockets.add(socket)
    socket.once('close', (): void => {
      upgradeSockets.delete(socket)
    })
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    )
    socket.on('data', (chunk): void => {
      socket.write(chunk)
    })
  })
  upstreamUpgradeSockets.set(server, upgradeSockets)
  return { server, state }
}

async function handleUpstreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: UpstreamTestState,
): Promise<void> {
  const target = new URL(request.url ?? '/', 'http://upstream.test')
  if (target.pathname === '/assets/app.js') {
    response.writeHead(200, { 'content-type': 'application/javascript' })
    response.end('static asset')
    return
  }
  if (target.pathname === '/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.write('data: first\n\n')
    const timer = setTimeout((): void => {
      response.end('data: second\n\n')
    }, 50)
    timer.unref()
    request.once('close', (): void => {
      clearTimeout(timer)
    })
    return
  }
  if (target.pathname === '/api/events.host' && target.searchParams.get('race') === 'create') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    response.flushHeaders()
    state.racedHostStreams.add(response)
    const waiters = [...state.racedHostWaiters]
    state.racedHostWaiters.clear()
    for (const wake of waiters) wake()
    response.once('close', (): void => {
      state.racedHostStreams.delete(response)
    })
    return
  }
  if (target.pathname === '/api/events.mux' || target.pathname === '/api/events.host') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    const payloads =
      target.pathname === '/api/events.mux'
        ? [
            { type: 'session/subscribed', sessionId: 'alice-session', lastSeq: 1 },
            { type: 'session/subscribed', sessionId: 'bob-session', lastSeq: 2 },
            { type: 'session/subscribed', sessionId: 'legacy-session', lastSeq: 3 },
            {
              type: 'question/requested',
              sessionId: 'alice-session',
              questions: [{ id: 'q1', question: 'Continue?' }],
            },
          ]
        : [
            { type: 'host/session-status', sessionId: 'alice-session', running: false },
            { type: 'host/session-status', sessionId: 'bob-session', running: false },
            { type: 'host/session-status', sessionId: 'legacy-session', running: false },
            {
              type: 'host/workspace-changed',
              workspace: {
                workspaceId: 'workspace',
                sessionIds: ['alice-session', 'bob-session', 'legacy-session'],
              },
            },
          ]
    for (const [index, payload] of payloads.entries()) {
      response.write(
        `data: ${JSON.stringify({
          type: 'server-request',
          rpcId:
            payload.type === 'question/requested'
              ? 'alice-question-cancel'
              : `event-${String(index)}`,
          method: payload.type,
          payload,
        })}\n\n`,
      )
    }
    response.end()
    return
  }
  if (target.pathname === '/api/session.export') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(`export:${target.searchParams.get('sessionId') ?? ''}`)
    return
  }
  if (request.method === 'POST' && target.pathname === '/api/respond') {
    await readRequestJson(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ accepted: true }))
    return
  }
  if (request.method === 'POST' && target.pathname.startsWith('/api/')) {
    const body = await readRequestJson(request)
    const rpcId = typeof body.rpcId === 'string' ? body.rpcId : 'invalid-rpc'
    const payload = asTestRecord(body.payload) ?? {}
    let value: unknown = { accepted: true }
    if (target.pathname === '/api/session.list' || target.pathname === '/api/session.search') {
      value = {
        items: [
          { sessionId: 'alice-session' },
          { sessionId: 'bob-session' },
          { sessionId: 'legacy-session' },
        ],
        ...(target.pathname === '/api/session.search' ? { hasMore: false } : {}),
      }
    } else if (target.pathname === '/api/session.create') {
      if (payload.race === 'success' || payload.race === 'failure') {
        const sessionId = payload.race === 'success' ? 'raced-session' : 'failed-race-session'
        publishRacedHostEvents(state, sessionId)
        await delay(25)
        if (payload.race === 'failure') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              type: 'server-response',
              rpcId,
              result: {
                ok: false,
                error: { code: 'invalid-request', message: 'Create failed', details: {} },
              },
            }),
          )
          return
        }
        value = { sessionId }
      } else {
        value = {
          sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : 'created-session',
        }
      }
    } else if (target.pathname === '/api/session.fork') {
      if (payload.race === 'success') {
        publishRacedHostEvents(
          state,
          'raced-fork-session',
          typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
        )
        await delay(25)
        value = { sessionId: 'raced-fork-session' }
      } else {
        if (payload.atSeq === 999) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              type: 'server-response',
              rpcId,
              result: {
                ok: false,
                error: {
                  code: 'workspace-attach-failed',
                  message: 'forked session was published before workspace attachment failed',
                  details: {
                    sessionId: 'partial-fork-session',
                    workspaceId: 'workspace',
                  },
                },
              },
            }),
          )
          return
        }
        value = { sessionId: 'forked-session' }
      }
    } else if (target.pathname === '/api/workspace.list') {
      value = {
        workspaces: [
          {
            workspaceId: 'workspace',
            sessionIds: ['alice-session', 'bob-session', 'legacy-session'],
          },
        ],
        archivedSessionIds: ['alice-session', 'bob-session', 'legacy-session'],
      }
    } else if (target.pathname === '/api/sessionReferenceResolver/candidates') {
      value = [
        {
          sessionId: 'alice-reference',
          label: 'Alice reference',
          cwd: 'D:/alice',
          createdAt: 1,
          mention: `@[Alice reference](${dshSessionUri('alice-reference')})`,
        },
        {
          sessionId: 'bob-session',
          label: 'Bob secret',
          cwd: 'D:/bob',
          createdAt: 2,
          mention: `@[Bob secret](${dshSessionUri('bob-session')})`,
        },
        {
          sessionId: 'legacy-session',
          label: 'Legacy',
          cwd: 'D:/legacy',
          createdAt: 3,
          mention: `@[Legacy](${dshSessionUri('legacy-session')})`,
        },
      ]
    } else if (target.pathname === '/api/dynamicCordisRunner/inventory') {
      value = [
        {
          pluginId: 'alice-plugin',
          agentId: 'alice-session',
          packages: [],
          latestRun: {
            pluginRunId: 'alice-run',
            packageId: 'alice-package',
            mode: 'run',
            status: 'awaiting-approval',
            approvalRequestId: 'alice-approval',
            host: { status: 'waiting', waitingFor: [] },
            client: { status: 'waiting', waitingFor: [] },
          },
        },
        {
          pluginId: 'bob-plugin',
          agentId: 'bob-session',
          packages: [],
          latestRun: {
            pluginRunId: 'bob-run',
            packageId: 'bob-package',
            mode: 'run',
            status: 'awaiting-approval',
            approvalRequestId: 'bob-approval',
            host: { status: 'waiting', waitingFor: [] },
            client: { status: 'waiting', waitingFor: [] },
          },
        },
        { pluginId: 'legacy-plugin', agentId: 'legacy-session', packages: [] },
      ]
    } else if (target.pathname === '/api/subagent.list') {
      value = {
        entries: [
          {
            kind: 'child',
            id: 'alice-child',
            mode: 'continuable',
            activity: 'inactive',
            hasChildren: false,
            label: 'child',
          },
        ],
        parentAvailable: true,
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        type: 'server-response',
        rpcId,
        result: { ok: true, value },
      }),
    )
    return
  }
  if (target.pathname === '/redirect') {
    response.writeHead(302, { location: `http://${request.headers.host ?? '127.0.0.1'}/target` })
    response.end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      path: `${target.pathname}${target.search}`,
      method: request.method,
      body: Buffer.concat(chunks).toString('utf8'),
      cookie: request.headers.cookie ?? '',
    }),
  )
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  const record = asTestRecord(value)
  if (record === null) throw new Error('test upstream expected a JSON object')
  return record
}

function asTestRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', (): void => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  for (const socket of upstreamUpgradeSockets.get(server) ?? []) socket.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve): void => {
    server.close((): void => resolve())
  })
}

function splitSetCookie(header: string | null): string[] {
  if (header === null) return []
  return header.split(/,\s*(?=luban_(?:session|csrf)=)/u)
}

function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((value) => value.split(';', 1)[0]).join('; ')
}

function cookieValue(cookie: string, name: string): string {
  const found = cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
  if (found === undefined) throw new Error(`cookie ${name} is missing`)
  return found.slice(name.length + 1)
}

async function loginUser(baseUrl: string, user: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/luban-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ user, password }),
  })
  expect(response.status).toBe(200)
  return cookieHeader(splitSetCookie(response.headers.get('set-cookie')))
}

async function dshRpc(
  baseUrl: string,
  cookie: string,
  method: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<TestRpcResponse> {
  const rpcId = `rpc-${method}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  expect(response.status).toBe(200)
  const message = (await response.json()) as TestRpcResponse
  expect(message).toMatchObject({ type: 'server-response', rpcId })
  return message
}

function sessionIdsFromRpc(response: TestRpcResponse): string[] {
  const value = asTestRecord(response.result.value)
  const items = value?.items
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    const sessionId = asTestRecord(item)?.sessionId
    return typeof sessionId === 'string' ? [sessionId] : []
  })
}

function dshSessionUri(sessionId: string): string {
  return `dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`
}

function publishRacedHostEvents(
  state: UpstreamTestState,
  sessionId: string,
  parentSessionId?: string,
): void {
  const payloads = [
    {
      type: 'host/session-added',
      sessionId,
      running: false,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    },
    {
      type: 'host/workspace-changed',
      workspace: { workspaceId: 'race-workspace', sessionIds: [sessionId] },
    },
  ]
  for (const response of [...state.racedHostStreams]) {
    state.racedHostStreams.delete(response)
    for (const [index, payload] of payloads.entries()) {
      response.write(
        `data: ${JSON.stringify({
          type: 'server-request',
          rpcId: `race-event-${String(index)}`,
          method: payload.type,
          payload,
        })}\n\n`,
      )
    }
    response.end()
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })
}

async function waitForRacedHostStreams(state: UpstreamTestState, expected: number): Promise<void> {
  while (state.racedHostStreams.size < expected) {
    await new Promise<void>((resolve): void => {
      state.racedHostWaiters.add(resolve)
    })
  }
}

async function rawHttpRequest(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject): void => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response): void => {
      const chunks: Buffer[] = []
      response.on('data', (chunk): void => {
        chunks.push(Buffer.from(chunk as Uint8Array))
      })
      response.once('end', (): void => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.once('error', reject)
    request.end()
  })
}

async function openUpgrade(
  port: number,
  cookie?: string,
  origin?: string,
): Promise<{ readonly socket: Socket; readonly head: string }> {
  return new Promise((resolve, reject): void => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('error', reject)
    socket.once('connect', (): void => {
      const headers = [
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGVzdC1rZXk=',
        'Sec-WebSocket-Version: 13',
        ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
        ...(origin === undefined ? [] : [`Origin: ${origin}`]),
        '',
        '',
      ]
      socket.write(headers.join('\r\n'))
      let head = ''
      const onData = (chunk: Buffer): void => {
        head += chunk.toString('utf8')
        if (!head.includes('\r\n\r\n')) return
        socket.off('data', onData)
        socket.off('error', reject)
        resolve({ socket, head })
      }
      socket.on('data', onData)
    })
  })
}
