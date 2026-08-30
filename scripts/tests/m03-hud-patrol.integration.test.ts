import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  Clock,
  ManagedSession,
  SessionSpec,
  TaskStore,
} from '../../packages/core/src/index.js'
import { asAccountId, asHostId } from '../../packages/core/src/index.js'
import { HudKeepaliveHealthStore } from '../../packages/dsh-luban-hud/src/keepalive-health.js'
import { apply as applyKeepalive } from '../../packages/dsh-luban-keepalive/src/index.js'
import { TmuxKeepaliveAdapter } from '../../packages/dsh-luban-keepalive/src/tmux-adapter.js'
import { WindowsTaskKeepaliveAdapter } from '../../packages/dsh-luban-keepalive/src/windows-adapter.js'
import { createLedgerStore } from '../../packages/dsh-luban-taskboard/src/ledger.js'
import { JsonTaskStore } from '../../packages/dsh-luban-taskboard/src/task-store.js'
import { describe, expect, it, vi } from 'vitest'

const STARTED_AT = 1_800_000_000_000
const MAX_PATROL_INTERVAL_MS = 300_000
const ACCOUNT = asAccountId('patrol-user')

const clock: Clock = Object.freeze({ now: (): number => Date.now() })

function managedSession(spec: SessionSpec, kind: ManagedSession['kind']): ManagedSession {
  return {
    ...(spec.accountId === undefined ? {} : { accountId: spec.accountId }),
    id: spec.id,
    host: asHostId('integration-host'),
    kind,
    purpose: spec.purpose,
    ...(spec.ownerTaskId === undefined ? {} : { ownerTaskId: spec.ownerTaskId }),
    createdAt: Date.now(),
  }
}

describe('M03 patrol alert deadline integration', (): void => {
  it('projects a dead managed session into HUD and TaskStore within five minutes', async (): Promise<void> => {
    vi.useFakeTimers()
    vi.setSystemTime(STARTED_AT)
    const directory = await mkdtemp(join(tmpdir(), 'luban-m03-patrol-integration-'))
    const context = new Context()
    const hud = new HudKeepaliveHealthStore()
    const taskStore = new JsonTaskStore(
      createLedgerStore(join(directory, 'tasks.json'), clock),
      clock,
    )
    let observedAt: number | undefined

    vi.spyOn(TmuxKeepaliveAdapter.prototype, 'create').mockImplementation((spec) =>
      Promise.resolve(managedSession(spec, 'tmux')),
    )
    vi.spyOn(TmuxKeepaliveAdapter.prototype, 'isAlive').mockResolvedValue(false)
    vi.spyOn(WindowsTaskKeepaliveAdapter.prototype, 'create').mockImplementation((spec) =>
      Promise.resolve(managedSession(spec, 'service')),
    )
    vi.spyOn(WindowsTaskKeepaliveAdapter.prototype, 'isAlive').mockResolvedValue(false)

    const unregisterHealth = context.on('luban.keepalive.health', (payload): void => {
      if (payload.accountId === undefined) hud.record(payload)
      else hud.recordForAccount(payload.accountId, payload)
      if (!payload.alive) observedAt = Date.now()
    })
    const taskStoreFiber = context.plugin({
      name: 'm03-patrol-integration-task-store',
      apply(ctx: Context): void {
        ctx.provide('lubanTaskStore', taskStore as TaskStore)
      },
    })
    let keepaliveFiber: ReturnType<typeof context.plugin> | undefined

    try {
      await taskStoreFiber
      keepaliveFiber = context.plugin({
        name: 'm03-patrol-integration-keepalive',
        apply(ctx: Context): void {
          applyKeepalive(ctx, {
            strategy: process.platform === 'win32' ? 'service' : 'tmux',
            patrolIntervalSec: 300,
            ledgerFile: join(directory, 'keepalive.json'),
            bootRestore: false,
            alertToTaskboard: true,
          })
        },
      })
      await keepaliveFiber

      await context.lubanKeepalive.ensureAlive({
        accountId: ACCOUNT,
        id: 'deadline',
        purpose: 'build',
        command: 'node',
      })

      await vi.advanceTimersByTimeAsync(MAX_PATROL_INTERVAL_MS - 1)
      expect(hud.snapshot(ACCOUNT)).toEqual({ healthy: true, alerts: [] })
      await expect(
        taskStore.query({ accountId: ACCOUNT, tags: ['keepalive:luban-deadline'] }),
      ).resolves.toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1)
      await keepaliveFiber.dispose()
      keepaliveFiber = undefined

      expect(observedAt).toBe(STARTED_AT + MAX_PATROL_INTERVAL_MS)
      expect(hud.snapshot(ACCOUNT)).toEqual({
        healthy: false,
        alerts: [
          {
            sessionId: 'luban-deadline',
            detail: 'managed process is not alive',
          },
        ],
      })
      await expect(
        taskStore.query({ accountId: ACCOUNT, tags: ['keepalive:luban-deadline'] }),
      ).resolves.toEqual([
        expect.objectContaining({
          accountId: ACCOUNT,
          title: 'Keepalive alert: luban-deadline',
          status: 'todo',
          priority: 'P1',
          updatedAt: STARTED_AT + MAX_PATROL_INTERVAL_MS,
        }),
      ])
    } finally {
      if (keepaliveFiber !== undefined) await keepaliveFiber.dispose()
      unregisterHealth()
      hud.dispose()
      await taskStoreFiber.dispose()
      await rm(directory, { recursive: true, force: true })
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})
