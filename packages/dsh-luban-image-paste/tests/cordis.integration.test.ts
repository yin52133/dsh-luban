import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { AuthService } from '@luban/core'
import { describe, expect, it } from 'vitest'
import plugin from '../src/index.js'

function authentication(): AuthService {
  return {
    middleware: () => () => Promise.resolve({ allowed: true, status: 200, user: 'tester' }),
  } as unknown as AuthService
}

describe('Cordis lifecycle', () => {
  it('provides the service and releases its route and timer on unload', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'luban-image-cordis-'))
    const context = new Context()
    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const agentsFiber = context.plugin(AgentRegistry)
    const authFiber = context.plugin({
      name: 'luban-image-test-auth',
      apply(ctx: Context): void {
        ctx.provide('lubanAuth', authentication())
      },
    })

    try {
      await Promise.all([webFiber, agentsFiber, authFiber])
      const fiber = context.plugin(plugin, {
        workspaceRoot: workspace,
        compression: false,
        cleanupIntervalMinutes: 60,
      })
      await fiber

      expect(context.get('lubanImageIngest')).toBeDefined()
      expect(fiber.getEffects().map((effect) => effect.label)).toContain(
        'luban-image-paste: route and cleanup lifecycle',
      )
      expect(() =>
        context.webServer.register({
          kind: 'prefix',
          path: '/luban-image-paste',
          handler: (_request, response): void => {
            response.end()
          },
        }),
      ).toThrow()

      await fiber.dispose()
      expect(context.get('lubanImageIngest')).toBeUndefined()
      expect(fiber.getEffects()).toEqual([])

      const unregister = context.webServer.register({
        kind: 'prefix',
        path: '/luban-image-paste',
        handler: (_request, response): void => {
          response.end()
        },
      })
      unregister()
    } finally {
      await authFiber.dispose()
      await agentsFiber.dispose()
      await webFiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  }, 30_000)
})
