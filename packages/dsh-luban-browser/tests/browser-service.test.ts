import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrowserEvent,
  BrowserProfile,
  BrowserResult,
  BrowserSession,
  BrowserTaskSpec,
} from '@yin52133/dsh-luban-core'
import { asAccountId } from '@yin52133/dsh-luban-core'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserService } from '../src/browser-service.js'
import { resolveConfig } from '../src/config.js'
import { TemplateRepository } from '../src/templates.js'
import type { BrowserBridge, ResolvedBrowserTask } from '../src/types.js'

const temporaryDirectories: string[] = []
const ALICE = asAccountId('alice')
const BOB = asAccountId('bob')

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

class FakeBridge implements BrowserBridge {
  readonly starts: BrowserProfile[] = []
  readonly runs: string[] = []
  readonly outputDirectories: string[] = []
  active = 0
  maxActive = 0
  closed = false

  public start(profile: BrowserProfile): Promise<BrowserSession> {
    this.starts.push(profile)
    return Promise.resolve({
      id: `S-${String(this.starts.length)}`,
      profile,
      startedAt: Date.now(),
    })
  }

  public async *run(
    task: ResolvedBrowserTask,
    outputDir: string,
    signal: AbortSignal,
  ): AsyncIterable<BrowserEvent> {
    this.runs.push(task.runId)
    this.outputDirectories.push(outputDir)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      yield { type: 'progress', runId: task.runId, step: 1, detail: 'mock step' }
      if (task.goal.includes('hang')) await untilAborted(signal)
      else {
        await new Promise((resolve): void => {
          setTimeout(resolve, 5)
        })
      }
      const result: BrowserResult = {
        runId: task.runId,
        status: 'ok',
        screenshots: [`/mock/${task.runId}.png`],
        text: 'mock result',
        steps: 1,
        durationMs: 5,
      }
      yield { type: 'result', result }
    } finally {
      this.active -= 1
    }
  }

  public stop(): Promise<void> {
    return Promise.resolve()
  }

  public close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

describe('BrowserService', () => {
  it('executes its queue serially and publishes terminal snapshots', async () => {
    const directory = await temporaryDirectory()
    const bridge = new FakeBridge()
    const service = createService(directory, bridge)
    const first = service.enqueue({ accountId: ALICE, task: { goal: 'first' } })
    const second = service.enqueue({ accountId: ALICE, task: { goal: 'second' } })

    const [firstDone, secondDone] = await Promise.all([
      service.wait(first.id, ALICE),
      service.wait(second.id, ALICE),
    ])

    expect(firstDone.status).toBe('succeeded')
    expect(secondDone.status).toBe('succeeded')
    expect(bridge.runs).toEqual([first.id, second.id])
    expect(bridge.maxActive).toBe(1)
    await service.close()
    expect(bridge.closed).toBe(true)
  })

  it('isolates job lookup, events, results, and artifact directories by account', async () => {
    const directory = await temporaryDirectory()
    const bridge = new FakeBridge()
    const service = createService(directory, bridge)
    const aliceEvents: string[] = []
    const bobEvents: string[] = []
    const unsubscribeAlice = service.subscribe(ALICE, (event): void => {
      aliceEvents.push(event.job.id)
    })
    const unsubscribeBob = service.subscribe(BOB, (event): void => {
      bobEvents.push(event.job.id)
    })

    const alice = service.enqueue({ accountId: ALICE, task: { goal: 'alice job' } })
    const bob = service.enqueue({ accountId: BOB, task: { goal: 'bob job' } })
    const [aliceDone, bobDone] = await Promise.all([
      service.wait(alice.id, ALICE),
      service.wait(bob.id, BOB),
    ])

    expect(service.list(ALICE).map((job) => job.id)).toEqual([alice.id])
    expect(service.list(BOB).map((job) => job.id)).toEqual([bob.id])
    expect(service.get(alice.id, BOB)).toBeNull()
    await expect(service.wait(alice.id, BOB)).rejects.toMatchObject({
      code: 'E_BROWSER_NOT_FOUND',
    })
    expect(await service.cancel(alice.id, BOB)).toBe(false)
    expect(aliceDone.result?.accountId).toBe(ALICE)
    expect(bobDone.result?.accountId).toBe(BOB)
    expect(new Set(aliceEvents)).toEqual(new Set([alice.id]))
    expect(new Set(bobEvents)).toEqual(new Set([bob.id]))
    expect(bridge.outputDirectories[0]).toContain(accountStorageSegment(ALICE))
    expect(bridge.outputDirectories[1]).toContain(accountStorageSegment(BOB))

    unsubscribeAlice()
    unsubscribeBob()
    await service.close()
  })

  it('cancels a running task and drains the bridge', async () => {
    const directory = await temporaryDirectory()
    const bridge = new FakeBridge()
    const service = createService(directory, bridge)
    const job = service.enqueue({ accountId: ALICE, task: { goal: 'hang until cancelled' } })
    await waitFor(() => service.get(job.id, ALICE)?.status === 'running')

    expect(await service.cancel(job.id, ALICE)).toBe(true)
    const completed = await service.wait(job.id, ALICE)

    expect(completed.status).toBe('cancelled')
    expect(completed.error?.code).toBe('E_BROWSER_CANCELLED')
    await service.close()
  })

  it('enforces a template allowlist for automatic tasks', async () => {
    const directory = await temporaryDirectory()
    const templateDirectory = join(directory, 'templates')
    await writeFile(
      join(await ensureDirectory(templateDirectory), 'safe.yaml'),
      [
        'id: safe',
        'title: Safe research',
        'goal: Inspect ${subject}',
        'startUrl: https://docs.example.com',
        'allowDomains:',
        '  - "*.example.com"',
        'timeoutSec: 30',
        'maxSteps: 5',
        'profile:',
        '  mode: persistent',
        '  name: docs',
      ].join('\n'),
      'utf8',
    )
    const bridge = new FakeBridge()
    const service = createService(directory, bridge, new TemplateRepository([templateDirectory]))
    const accepted = service.enqueue({
      accountId: ALICE,
      task: { templateId: 'safe', goal: '' },
      params: { subject: 'release notes' },
      automatic: true,
    })
    expect((await service.wait(accepted.id, ALICE)).status).toBe('succeeded')
    expect(bridge.starts[0]?.userDataDir).toContain(
      join('profiles', accountStorageSegment(ALICE), 'docs'),
    )
    const bobAccepted = service.enqueue({
      accountId: BOB,
      task: { templateId: 'safe', goal: '' },
      params: { subject: 'release notes' },
      automatic: true,
    })
    expect((await service.wait(bobAccepted.id, BOB)).status).toBe('succeeded')
    expect(bridge.starts[1]?.userDataDir).toContain(
      join('profiles', accountStorageSegment(BOB), 'docs'),
    )
    expect(bridge.starts[0]?.userDataDir).not.toBe(bridge.starts[1]?.userDataDir)

    const rejected = service.enqueue({
      accountId: ALICE,
      task: {
        templateId: 'safe',
        goal: '',
        constraints: { allowDomains: ['evil.test'] },
      },
      params: { subject: 'release notes' },
      automatic: true,
    })
    const rejectedDone = await service.wait(rejected.id, ALICE)
    expect(rejectedDone.status).toBe('failed')
    expect(rejectedDone.error?.code).toBe('E_BROWSER_POLICY')
    await service.close()
  })

  it('rejects unrestricted wildcards while preserving the manual empty-list mode', async () => {
    expect(() => resolveConfig({ defaults: { allowDomains: ['*'] } })).toThrow(/wildcard \*/u)
    expect(
      resolveConfig({ defaults: { allowDomains: ['*.example.com'] } }).defaults.allowDomains,
    ).toEqual(['*.example.com'])

    const directory = await temporaryDirectory()
    const bridge = new FakeBridge()
    const service = createService(directory, bridge)
    expect(() =>
      service.enqueue({
        accountId: ALICE,
        task: { goal: 'blocked', constraints: { allowDomains: ['https://*'] } },
      }),
    ).toThrow(/wildcard \*/u)

    const manual = service.enqueue({
      accountId: ALICE,
      task: {
        goal: 'manual navigation remains unconstrained',
        startUrl: 'https://unlisted.example.test',
        constraints: { allowDomains: [] },
      },
    })
    expect((await service.wait(manual.id, ALICE)).status).toBe('succeeded')
    await service.close()
  })

  it('fails automatic jobs whose template attempts an unrestricted wildcard', async () => {
    const directory = await temporaryDirectory()
    const templateDirectory = join(directory, 'templates')
    await writeFile(
      join(await ensureDirectory(templateDirectory), 'unsafe.yaml'),
      [
        'id: unsafe',
        'title: Unsafe research',
        'goal: Inspect the page',
        'allowDomains:',
        '  - "*"',
        'timeoutSec: 30',
        'maxSteps: 5',
        'profile:',
        '  mode: isolated',
      ].join('\n'),
      'utf8',
    )
    const service = createService(
      directory,
      new FakeBridge(),
      new TemplateRepository([templateDirectory]),
    )

    const job = service.enqueue({
      accountId: ALICE,
      task: { templateId: 'unsafe', goal: '' },
      automatic: true,
    })
    const completed = await service.wait(job.id, ALICE)

    expect(completed.status).toBe('failed')
    expect(completed.error?.code).toBe('E_BROWSER_INVALID_TASK')
    await service.close()
  })

  it('fails queued work cleanly when its data directories cannot be prepared', async () => {
    const directory = await temporaryDirectory()
    const blockedPath = join(directory, 'not-a-directory')
    await writeFile(blockedPath, 'file', 'utf8')
    const bridge = new FakeBridge()
    const service = createService(blockedPath, bridge)

    const job = service.enqueue({ accountId: ALICE, task: { goal: 'cannot start' } })
    const completed = await service.wait(job.id, ALICE)

    expect(completed.status).toBe('failed')
    expect(completed.error?.code).toBe('E_BROWSER_UNAVAILABLE')
    expect(bridge.runs).toEqual([])
    await service.close()
  })
})

function createService(
  directory: string,
  bridge: BrowserBridge,
  templates?: TemplateRepository,
): BrowserService {
  return new BrowserService({
    config: resolveConfig({
      dataDir: directory,
      templatesDir: join(directory, 'user-templates'),
      bridge: { projectDir: join(directory, 'bridge') },
    }),
    bridge,
    ...(templates === undefined ? {} : { templates }),
  })
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'luban-browser-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function ensureDirectory(directory: string): Promise<string> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })
  return directory
}

async function untilAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Promise<never>((_resolve, reject): void => {
    signal.addEventListener(
      'abort',
      (): void => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve): void => {
      setTimeout(resolve, 1)
    })
  }
  throw new Error('Timed out waiting for condition')
}

const _taskTypeCheck: BrowserTaskSpec = { goal: 'typed' }
void _taskTypeCheck

function accountStorageSegment(accountId: ReturnType<typeof asAccountId>): string {
  return `account-${Buffer.from(String(accountId), 'utf8').toString('base64url')}`
}
