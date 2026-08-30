import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { asSessionId } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { DshImageSessionInjector, imagePrompt } from '../src/dsh-injection.js'
import type { ImageQueueReceipt, StoredImage } from '../src/types.js'

const IMAGE: StoredImage = {
  id: '11111111-1111-4111-8111-111111111111',
  relPath: '.luban/attachments/20260830-scope-1.png',
  absPath: 'D:\\work\\.luban\\attachments\\20260830-scope-1.png',
  sha256: 'a'.repeat(64),
  source: 'paste',
  referencedBy: [],
  createdAt: 1,
  mime: 'image/png',
  bytes: 12,
  originalName: 'scope',
  compression: { status: 'not-needed', originalBytes: 12, outputBytes: 12 },
}

describe('DSH rc2 image injection', () => {
  it('renders both accessible reference styles', () => {
    expect(imagePrompt(IMAGE, 'markdown')).toContain(
      '![scope](.luban/attachments/20260830-scope-1.png)',
    )
    expect(imagePrompt(IMAGE, 'markdown')).toContain('Workspace-relative path:')
    expect(imagePrompt(IMAGE, 'path')).toContain(`Absolute path: ${IMAGE.absPath}`)
    expect(imagePrompt(IMAGE, 'path')).toContain(IMAGE.relPath)
    expect(
      imagePrompt(
        {
          ...IMAGE,
          relPath: 'assets/#captures/scope? (1).png',
        },
        'markdown',
      ),
    ).toContain('assets/%23captures/scope%3F%20%281%29.png')
  })

  it('uses AgentRegistry.get and follows up a live agent', async () => {
    const workspace = await realpath(process.cwd())
    let delivered: unknown
    const followup = vi.fn((message: unknown): void => {
      delivered = message
    })
    const resume = vi.fn()
    const live = {
      id: 'session-live',
      session: { header: { cwd: workspace } },
      followup,
    }
    const registry = {
      get: () => live,
      roots: () => [live],
      resume,
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)
    await injector.inject(asSessionId('session-live'), IMAGE, 'markdown')
    expect(followup).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    const message = delivered as {
      readonly source: { readonly kind: string; readonly plugin: string }
      readonly content: readonly { readonly type: string; readonly text: string }[]
    }
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'dsh-luban-image-paste' })
    expect(message.content[0]?.text).toContain(IMAGE.relPath)
  })

  it('checks cancellation and inbox guards at the final queue boundary', async () => {
    const workspace = await realpath(process.cwd())
    const followup = vi.fn()
    const live = {
      id: 'session-guarded',
      inbox: { hasPending: false },
      session: { header: { cwd: workspace } },
      followup,
    }
    const registry = {
      get: () => live,
      roots: () => [live],
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)
    const controller = new AbortController()
    const abortedReceipt = { queued: false }

    await expect(
      injector.inject(asSessionId('session-guarded'), IMAGE, 'path', {
        signal: controller.signal,
        queueReceipt: abortedReceipt,
        onPreparedMessage: (): void => controller.abort(new Error('acceptance cancelled')),
      }),
    ).rejects.toThrow('acceptance cancelled')
    expect(followup).not.toHaveBeenCalled()
    expect(abortedReceipt).toEqual({ queued: false })

    live.inbox.hasPending = true
    const guardedReceipt = { queued: false }
    await expect(
      injector.inject(asSessionId('session-guarded'), IMAGE, 'path', {
        queueReceipt: guardedReceipt,
        onBeforeQueueMessage: (): void => {
          if (live.inbox.hasPending) throw new Error('inbox is not empty')
        },
      }),
    ).rejects.toThrow('inbox is not empty')
    expect(followup).not.toHaveBeenCalled()
    expect(guardedReceipt).toEqual({ queued: false })

    live.inbox.hasPending = false
    const committedReceipt: ImageQueueReceipt = { queued: false }
    await injector.inject(asSessionId('session-guarded'), IMAGE, 'path', {
      queueReceipt: committedReceipt,
      onBeforeQueueMessage: (): void => {
        if (live.inbox.hasPending) throw new Error('inbox is not empty')
      },
    })
    expect(followup).toHaveBeenCalledOnce()
    expect(committedReceipt.queued).toBe(true)
    expect(committedReceipt.messageId).toEqual(expect.any(String))
  })

  it('rejects a same-id live agent replacement when the caller binds an expected agent', async () => {
    const workspace = await realpath(process.cwd())
    const expected = {
      id: 'session-replaced',
      session: { header: { cwd: workspace } },
      followup: vi.fn(),
    }
    const replacement = {
      id: 'session-replaced',
      session: { header: { cwd: workspace } },
      followup: vi.fn(),
    }
    const registry = {
      get: () => replacement,
      roots: () => [replacement],
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace, expected as unknown as Agent)

    await expect(
      injector.inject(asSessionId('session-replaced'), IMAGE, 'path'),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })
    expect(expected.followup).not.toHaveBeenCalled()
    expect(replacement.followup).not.toHaveBeenCalled()
  })

  it('binds a single injection to the caller-selected live agent instance', async () => {
    const workspace = await realpath(process.cwd())
    const expected = {
      id: 'session-call-bound',
      session: { header: { cwd: workspace } },
      followup: vi.fn(),
    }
    const replacement = {
      id: 'session-call-bound',
      session: { header: { cwd: workspace } },
      followup: vi.fn(),
    }
    const registry = {
      get: () => replacement,
      roots: () => [replacement],
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)

    await expect(
      injector.inject(asSessionId('session-call-bound'), IMAGE, 'path', {
        expectedAgent: expected as unknown as Agent,
      }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })
    expect(expected.followup).not.toHaveBeenCalled()
    expect(replacement.followup).not.toHaveBeenCalled()
  })

  it('allows a runtime root with durable fork lineage', async () => {
    const workspace = await realpath(process.cwd())
    const followup = vi.fn()
    const live = {
      id: 'session-fork-root',
      session: { header: { cwd: workspace, parentSession: 'session-parent' } },
      followup,
    }
    const registry = {
      get: () => live,
      roots: () => [live],
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)

    await injector.inject(asSessionId('session-fork-root'), IMAGE, 'markdown')
    expect(followup).toHaveBeenCalledOnce()
  })

  it('rejects a dormant session instead of reconstructing an unsafe composition', async () => {
    const workspace = await realpath(process.cwd())
    const resume = vi.fn()
    const registry = {
      get: () => undefined,
      roots: () => [],
      resume,
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)
    await expect(
      injector.inject(asSessionId('session-durable'), IMAGE, 'path'),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })
    expect(resume).not.toHaveBeenCalled()
  })

  it('rejects an explicit subagent session', async () => {
    const workspace = await realpath(process.cwd())
    const followup = vi.fn()
    const child = {
      id: 'session-child',
      session: { header: { cwd: workspace, origin: 'subagent' } },
      followup,
    }
    const registry = {
      get: () => child,
      roots: () => [child],
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)
    await expect(
      injector.inject(asSessionId('session-child'), IMAGE, 'markdown'),
    ).rejects.toMatchObject({ code: 'E_INVALID_TRANSITION' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects a runtime-owned child even without durable parent metadata', async () => {
    const workspace = await realpath(process.cwd())
    const followup = vi.fn()
    const child = {
      id: 'session-child',
      session: { header: { cwd: workspace } },
      followup,
    }
    const parent = {
      id: 'session-parent',
      session: { header: { cwd: workspace } },
      followup: vi.fn(),
    }
    const registry = {
      get: () => child,
      roots: () => [parent],
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)
    await expect(
      injector.inject(asSessionId('session-child'), IMAGE, 'markdown'),
    ).rejects.toMatchObject({ code: 'E_INVALID_TRANSITION' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects durable subagent delegation metadata even if runtime ownership says root', async () => {
    const workspace = await realpath(process.cwd())
    const followup = vi.fn()
    const child = {
      id: 'session-child',
      session: { header: { cwd: workspace, delegationDepth: 1 } },
      followup,
    }
    const registry = {
      get: () => child,
      roots: () => [child],
    } as unknown as AgentRegistry
    const injector = new DshImageSessionInjector(registry, workspace)
    await expect(
      injector.inject(asSessionId('session-child'), IMAGE, 'markdown'),
    ).rejects.toMatchObject({ code: 'E_INVALID_TRANSITION' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('rejects a live session from a different canonical workspace', async () => {
    const workspace = await realpath(process.cwd())
    const otherWorkspace = await mkdtemp(join(tmpdir(), 'luban-injection-scope-'))
    const followup = vi.fn()
    try {
      const live = {
        id: 'session-other-workspace',
        session: { header: { cwd: otherWorkspace } },
        followup,
      }
      const registry = {
        get: () => live,
        roots: () => [live],
      } as unknown as AgentRegistry
      const injector = new DshImageSessionInjector(registry, workspace)
      await expect(
        injector.inject(asSessionId('session-other-workspace'), IMAGE, 'path'),
      ).rejects.toMatchObject({ code: 'E_INVALID_TRANSITION' })
      expect(followup).not.toHaveBeenCalled()
    } finally {
      await rm(otherWorkspace, { recursive: true, force: true })
    }
  })
})
