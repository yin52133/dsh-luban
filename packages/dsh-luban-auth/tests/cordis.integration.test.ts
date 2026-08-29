import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import plugin, { resolveAuthConfig } from '../src/index.js'

describe('Cordis lifecycle', () => {
  let directory: string | undefined
  let upstream: Server | undefined

  afterEach(async () => {
    if (upstream !== undefined) {
      upstream.closeAllConnections()
      await new Promise<void>((resolve): void => {
        upstream?.close((): void => resolve())
      })
    }
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    upstream = undefined
    directory = undefined
  })

  it('provides ctx.lubanAuth and releases the listening effect on unload', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-luban-cordis-test-'))
    upstream = createServer((_request, response): void => {
      response.end('ok')
    })
    await new Promise<void>((resolve, reject): void => {
      upstream?.once('error', reject)
      upstream?.listen(0, '127.0.0.1', (): void => resolve())
    })
    const address = upstream.address()
    if (address === null || typeof address === 'string')
      throw new Error('test upstream has no port')
    const context = new Context()
    const fiber = context.plugin(
      plugin,
      resolveAuthConfig({
        host: '127.0.0.1',
        port: 0,
        upstream: `http://127.0.0.1:${String(address.port)}`,
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
    expect(fiber.getEffects()).toEqual([])
  }, 30_000)
})
