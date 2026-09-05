import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { assertProtectedDshUpstream, resolveAuthConfig } from '../src/index.js'

describe('Cordis lifecycle', () => {
  let directory: string | undefined

  afterEach(async () => {
    vi.unstubAllEnvs()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('provides ctx.lubanAuth and releases the listening effect on unload', async () => {
    vi.stubEnv('LUBAN_ADMIN_PASSWORD', 'legacy-env-must-not-create-an-account')
    directory = await mkdtemp(join(tmpdir(), 'dsh-luban-cordis-test-'))
    const context = new Context()
    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await webFiber
    const fiber = context.plugin(
      plugin,
      resolveAuthConfig({
        host: '127.0.0.1',
        port: 0,
        upstream: `http://127.0.0.1:${String(context.webServer.port)}`,
        usersFile: join(directory, 'users.json'),
        auditDirectory: join(directory, 'audit'),
      }),
    )
    await fiber
    expect(context.lubanAuth).toBeDefined()
    expect(await context.lubanAuth.hasUsers()).toBe(false)
    const effects = fiber.getEffects().map((effect) => effect.label)
    expect(effects).toContain('lubanAuth.sidecar')
    expect(effects).toContain('lubanAuth.state')
    await fiber.dispose()
    await webFiber.dispose()
    expect(fiber.getEffects()).toEqual([])
  }, 30_000)

  it('rejects an externally bound or mismatched DSH WebServer', (): void => {
    expect((): void =>
      assertProtectedDshUpstream({ host: '0.0.0.0', port: 3080 }, new URL('http://127.0.0.1:3080')),
    ).toThrow('must bind to 127.0.0.1')
    expect((): void =>
      assertProtectedDshUpstream(
        { host: '127.0.0.1', port: 3080 },
        new URL('http://127.0.0.1:3081'),
      ),
    ).toThrow('must match the DSH WebServer')
  })
})
