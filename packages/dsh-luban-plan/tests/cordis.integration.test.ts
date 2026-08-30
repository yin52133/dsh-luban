import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { AuthService } from 'dsh-luban-core'
import { asAccountId, asActorId, asSessionId } from 'dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin from '../src/index.js'

describe('plan Cordis lifecycle', (): void => {
  let directory: string | undefined

  afterEach(async (): Promise<void> => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('mounts the real service and monotonic guard, then unregisters both effects', async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'luban-plan-cordis-'))
    const workspace = join(directory, 'workspace')
    await mkdir(workspace)
    const context = new Context()
    const unregisterRoute = vi.fn<() => void>()
    const unregisterGuard = vi.fn<() => void>()
    let registeredGuard: ToolGuard | undefined
    context.provide('webServer', {
      register: vi.fn((): (() => void) => unregisterRoute),
    } as unknown as Context['webServer'])
    context.provide('tools', {
      guard(guard: ToolGuard): () => void {
        registeredGuard = guard
        return unregisterGuard
      },
    } as unknown as Context['tools'])
    context.provide('agents', { get: vi.fn() } as unknown as Context['agents'])
    const accountId = asAccountId('reviewer')
    context.provide('lubanAuth', {
      middleware: (): ReturnType<AuthService['middleware']> => () =>
        Promise.resolve({
          allowed: true,
          status: 200,
          user: 'reviewer',
          account: { accountId, username: 'reviewer', role: 'operator' },
        }),
      accountSessions: {
        bind: (): Promise<void> => Promise.resolve(),
        ownerOf: (): Promise<typeof accountId> => Promise.resolve(accountId),
      },
    } as unknown as AuthService)

    const fiber = context.plugin(plugin, {
      stateFile: join(directory, 'plans.json'),
      plansDir: 'docs/plans',
    })
    await fiber
    expect(context.lubanPlan).toBeDefined()
    expect(registeredGuard).toBeTypeOf('function')
    const sessionId = asSessionId('session-guard')
    const plan = await context.lubanPlan.submit({
      accountId,
      workspace,
      slug: 'guarded-change',
      sessionId,
      sections: {
        background: 'Need a guarded change',
        impact: 'One package',
        changes: 'src/index.ts',
        verification: 'Run tests',
      },
    })
    const execution = {
      name: 'apply_patch',
      agent: { id: sessionId },
    } as unknown as ToolExecution
    expect(registeredGuard?.(execution)).toContain('is in-review')

    const approved = await context.lubanPlan.decide(
      plan.id,
      { decision: 'approve', expectedVersion: plan.version },
      { kind: 'user', id: asActorId('reviewer'), accountId },
    )
    expect(approved.status).toBe('approved')
    expect(registeredGuard?.(execution)).toBeUndefined()

    await fiber.dispose()
    expect(unregisterGuard).toHaveBeenCalledOnce()
    expect(unregisterRoute).toHaveBeenCalledOnce()
    expect(fiber.getEffects()).toEqual([])
  })
})
