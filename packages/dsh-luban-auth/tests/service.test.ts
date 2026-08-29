import type { IncomingMessage } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { LubanAuthService } from '../src/service.js'
import { createManagerFixture, type ManagerFixture } from './helpers.js'

describe('LubanAuthService', () => {
  let fixture: ManagerFixture | undefined

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })

  it('implements the shared contract and request helper through ctx.lubanAuth', async () => {
    fixture = await createManagerFixture()
    await fixture.manager.createInitialAdmin('admin', 'correct horse')
    const context = new Context()
    new LubanAuthService(context, fixture.manager)
    const service = context.lubanAuth
    expect(await service.hasUsers()).toBe(true)
    expect(await service.verify('admin', 'correct horse', '127.0.0.1')).toEqual({ ok: true })

    const browserSession = await fixture.manager.issueBrowserSession('admin', '127.0.0.1')
    const cookie = `luban_session=${browserSession.cookieToken}`
    expect(await service.authenticateRequest(requestWithCookie(undefined))).toEqual({
      ok: false,
      reason: 'missing',
    })
    expect(await service.authenticateRequest(requestWithCookie('luban_session=bad'))).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(await service.authenticateRequest(requestWithCookie(cookie))).toMatchObject({
      ok: true,
      actor: { username: 'admin', role: 'admin' },
      session: { id: browserSession.session.id },
    })

    const middleware = service.middleware()
    await expect(
      middleware({
        path: '/luban-auth/login',
        method: 'POST',
        accept: undefined,
        cookie: undefined,
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toEqual({ allowed: true, status: 200 })
    await expect(
      middleware({
        path: '/assets/app.js',
        method: 'GET',
        accept: undefined,
        cookie: undefined,
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toEqual({ allowed: true, status: 200 })
    await expect(
      middleware({
        path: '/business',
        method: 'GET',
        accept: 'text/html',
        cookie: undefined,
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toMatchObject({ allowed: false, status: 302 })
    await expect(
      middleware({
        path: '/business',
        method: 'POST',
        accept: 'application/json',
        cookie: undefined,
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toEqual({ allowed: false, status: 401 })
    await expect(
      middleware({
        path: '/business',
        method: 'GET',
        accept: 'application/json',
        cookie,
        sourceIp: '127.0.0.1',
      }),
    ).resolves.toEqual({ allowed: true, status: 200, user: 'admin' })

    const events: string[] = []
    const unsubscribe = service.onChange((event): void => {
      events.push(event.type)
    })
    const issued = await service.issueSession('admin', '127.0.0.1')
    await service.revoke(issued.id)
    unsubscribe()
    expect(events).toEqual(['login', 'logout'])

    const operator = await service.provisionUser(
      browserSession.session.id,
      'operator',
      'operator pass',
      'operator',
    )
    expect(operator.role).toBe('operator')
    await service.revokeAllFor('admin')
  })
})

function requestWithCookie(cookie: string | undefined): IncomingMessage {
  return { headers: cookie === undefined ? {} : { cookie } } as IncomingMessage
}
