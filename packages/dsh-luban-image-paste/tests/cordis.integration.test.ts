import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { AuthService } from '@yin52133/dsh-luban-core'
import { asAccountId } from '@yin52133/dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import plugin from '../src/index.js'
import type { FileImageIngestService } from '../src/service.js'
import { PNG_BYTES } from './helpers.js'

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

  it('runs the real TTL sweep on fake time and cancels it on unload', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'luban-image-timer-'))
    const context = new Context()
    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const agentsFiber = context.plugin(AgentRegistry)
    const authFiber = context.plugin({
      name: 'luban-image-timer-auth',
      apply(ctx: Context): void {
        ctx.provide('lubanAuth', authentication())
      },
    })
    let imageFiber: ReturnType<Context['plugin']> | undefined
    let fakeTimersActive = false

    try {
      await Promise.all([webFiber, agentsFiber, authFiber])
      vi.useFakeTimers({
        now: Date.UTC(2026, 7, 30, 1, 2, 3),
        toFake: ['Date', 'setInterval', 'clearInterval'],
      })
      fakeTimersActive = true
      imageFiber = context.plugin(plugin, {
        workspaceRoot: workspace,
        compression: false,
        retainDays: 1,
        cleanupIntervalMinutes: 1,
      })
      await imageFiber
      const mounted = context.get('lubanImageIngest') as FileImageIngestService
      const accountId = asAccountId('account-timer')
      await mounted.fromBlob(new Blob([PNG_BYTES], { type: 'image/png' }), {
        accountId,
        nameHint: 'scheduled-cleanup.png',
      })
      const cleanup = vi.spyOn(mounted, 'cleanup')

      vi.setSystemTime(Date.UTC(2026, 8, 1, 1, 2, 3))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(cleanup).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith(false)
      const result = cleanup.mock.results[0]
      if (result?.type !== 'return') throw new Error('scheduled cleanup did not return a promise')
      await result.value
      await expect(mounted.listRecords(accountId)).resolves.toEqual([])

      await imageFiber.dispose()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      try {
        await imageFiber?.dispose()
      } finally {
        if (fakeTimersActive) {
          vi.clearAllTimers()
          vi.useRealTimers()
        }
        await authFiber.dispose()
        await agentsFiber.dispose()
        await webFiber.dispose()
        await rm(workspace, { recursive: true, force: true })
      }
    }
  }, 30_000)
})
