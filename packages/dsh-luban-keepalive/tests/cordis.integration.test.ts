import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { HealthReport } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyKeepalive, ManagedKeepaliveService } from '../src/index.js'

const directories = new Set<string>()
const EMPTY_HEALTH: HealthReport = Object.freeze({
  healthy: true,
  checkedAt: 1,
  sessions: [],
})

async function mountKeepalive(bootRestore: boolean): Promise<ReturnType<Context['plugin']>> {
  const directory = await mkdtemp(join(tmpdir(), 'luban-keepalive-cordis-'))
  directories.add(directory)
  const context = new Context()
  const fiber = context.plugin({
    name: 'luban-keepalive-boot-restore-test',
    apply(ctx: Context): void {
      applyKeepalive(ctx, {
        strategy: process.platform === 'win32' ? 'service' : 'tmux',
        patrolIntervalSec: 300,
        commandTimeoutSec: 1,
        ledgerFile: join(directory, 'ledger.json'),
        bootRestore,
        alertToTaskboard: false,
      })
    },
  })
  await fiber
  return fiber
}

afterEach(async (): Promise<void> => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('Cordis boot recovery lifecycle', (): void => {
  it('forces restore from the exact systemd sentinel when config disables it', async (): Promise<void> => {
    vi.stubEnv('LUBAN_BOOT_RESTORE', '1')
    const restore = vi
      .spyOn(ManagedKeepaliveService.prototype, 'restore')
      .mockResolvedValue(EMPTY_HEALTH)
    const fiber = await mountKeepalive(false)
    try {
      expect(restore).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('does not enable restore from other environment values', async (): Promise<void> => {
    vi.stubEnv('LUBAN_BOOT_RESTORE', 'true')
    const restore = vi
      .spyOn(ManagedKeepaliveService.prototype, 'restore')
      .mockResolvedValue(EMPTY_HEALTH)
    const fiber = await mountKeepalive(false)
    try {
      expect(restore).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })
})
