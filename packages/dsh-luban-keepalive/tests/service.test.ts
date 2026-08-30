import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Checkpoint,
  Clock,
  HealthReport,
  KeepaliveAdapter,
  KeepaliveEvent,
  ManagedSession,
  SessionSpec,
} from '@luban/core'
import { asHostId, asTaskId } from '@luban/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { KeepaliveAlertSink } from '../src/alerts.js'
import { KeepaliveLedgerStore } from '../src/ledger.js'
import { ManagedKeepaliveService } from '../src/service.js'

const directories = new Set<string>()

class StaticClock implements Clock {
  public now(): number {
    return 1_788_048_000_000
  }
}

class FakeAdapter implements KeepaliveAdapter {
  public readonly sessions = new Map<string, ManagedSession>()
  public creates = 0
  public destroys = 0
  public isAliveHook: ((id: string) => Promise<boolean>) | undefined

  public create(spec: SessionSpec): Promise<ManagedSession> {
    this.creates += 1
    const session: ManagedSession = {
      id: spec.id,
      host: asHostId('fake'),
      kind: 'tmux',
      purpose: spec.purpose,
      ...(spec.ownerTaskId === undefined ? {} : { ownerTaskId: spec.ownerTaskId }),
      createdAt: 1_788_048_000_000,
    }
    this.sessions.set(session.id, session)
    return Promise.resolve(session)
  }

  public attach(id: string): Promise<void> {
    if (!this.sessions.has(id)) return Promise.reject(new Error('missing'))
    return Promise.resolve()
  }

  public list(): Promise<readonly ManagedSession[]> {
    return Promise.resolve([...this.sessions.values()])
  }

  public isAlive(id: string): Promise<boolean> {
    if (this.isAliveHook !== undefined) return this.isAliveHook(id)
    return Promise.resolve(this.sessions.has(id))
  }

  public destroy(id: string): Promise<void> {
    this.destroys += 1
    this.sessions.delete(id)
    return Promise.resolve()
  }
}

class CapturingAlerts implements KeepaliveAlertSink {
  public readonly reports: HealthReport[] = []
  public reportHook: ((report: HealthReport) => Promise<void>) | undefined
  public report(report: HealthReport): Promise<void> {
    this.reports.push(report)
    return this.reportHook?.(report) ?? Promise.resolve()
  }
}

async function fixture(patrolIntervalMs = 60_000): Promise<{
  readonly directory: string
  readonly ledgerPath: string
  readonly adapter: FakeAdapter
  readonly alerts: CapturingAlerts
  readonly events: KeepaliveEvent[]
  readonly service: ManagedKeepaliveService
}> {
  const directory = join(tmpdir(), `luban-keepalive-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  directories.add(directory)
  const ledgerPath = join(directory, 'ledger.json')
  const adapter = new FakeAdapter()
  const alerts = new CapturingAlerts()
  const events: KeepaliveEvent[] = []
  const service = new ManagedKeepaliveService({
    adapter,
    ledger: new KeepaliveLedgerStore(ledgerPath, new StaticClock()),
    patrolIntervalMs,
    clock: new StaticClock(),
    alerts,
    publish: (event): void => {
      events.push(event)
    },
  })
  return { directory, ledgerPath, adapter, alerts, events, service }
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('ManagedKeepaliveService', (): void => {
  it('creates once, persists a checkpoint, and restores from that milestone', async (): Promise<void> => {
    const { adapter, events, service } = await fixture()
    const spec: SessionSpec = {
      id: 'task-42',
      purpose: 'task',
      command: 'dsh',
      args: ['headless'],
      ownerTaskId: asTaskId('TASK-42'),
    }
    const first = await service.ensureAlive(spec)
    const second = await service.ensureAlive(spec)
    expect(first).toEqual(second)
    expect(adapter.creates).toBe(1)

    const checkpoint: Checkpoint = {
      taskId: asTaskId('TASK-42'),
      stepList: ['configure', 'compile', 'test'],
      currentStep: 2,
      artifacts: ['/workspace/build.log'],
      savedAt: 1_788_048_000_000,
    }
    await service.saveCheckpoint('task-42', checkpoint)
    await expect(service.loadCheckpoint('luban-task-42')).resolves.toEqual(checkpoint)

    adapter.sessions.delete('luban-task-42')
    const restored = await service.restore()
    expect(restored.healthy).toBe(true)
    expect(adapter.creates).toBe(2)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'restored',
        checkpoint,
      }),
    )
    await service.release('task-42')
    expect((await service.patrol()).sessions).toEqual([])
    await service.dispose()
  })

  it('rejects spec drift and never adopts an untracked same-name session', async (): Promise<void> => {
    const { adapter, service } = await fixture()
    await service.ensureAlive({ id: 'bound', purpose: 'task', command: 'dsh', args: ['one'] })
    await expect(
      service.ensureAlive({ id: 'bound', purpose: 'task', command: 'dsh', args: ['two'] }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(adapter.creates).toBe(1)
    await service.dispose()

    const orphanFixture = await fixture()
    orphanFixture.adapter.sessions.set('luban-orphan', {
      id: 'luban-orphan',
      host: asHostId('fake'),
      kind: 'tmux',
      purpose: 'task',
      createdAt: 1,
    })
    await expect(
      orphanFixture.service.ensureAlive({ id: 'orphan', purpose: 'task', command: 'dsh' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(orphanFixture.adapter.creates).toBe(0)
    expect(orphanFixture.adapter.sessions.has('luban-orphan')).toBe(true)
    await orphanFixture.service.dispose()
  })

  it('reports dead sessions to event and alert consumers within one patrol', async (): Promise<void> => {
    const { adapter, alerts, events, service } = await fixture()
    await service.ensureAlive({ id: 'job', purpose: 'build', command: 'node' })
    adapter.sessions.clear()
    const report = await service.patrol()

    expect(report).toMatchObject({
      healthy: false,
      sessions: [{ id: 'luban-job', alive: false, detail: 'managed process is not alive' }],
    })
    expect(events.at(-1)).toEqual({ type: 'health', report })
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    expect(alerts.reports.at(-1)).toEqual(report)
    await service.dispose()
  })

  it('lists but never deletes or recreates orphans when the ledger is corrupt', async (): Promise<void> => {
    const { adapter, ledgerPath, service } = await fixture()
    adapter.sessions.set('luban-orphan', {
      id: 'luban-orphan',
      host: asHostId('fake'),
      kind: 'tmux',
      purpose: 'task',
      createdAt: 1,
    })
    await writeFile(ledgerPath, '{not-json', 'utf8')
    const report = await service.restore()

    expect(report).toMatchObject({
      healthy: false,
      sessions: [
        { id: 'luban-orphan', alive: false, detail: 'ledger unreadable; orphan retained' },
      ],
    })
    expect(adapter.creates).toBe(0)
    expect(adapter.destroys).toBe(0)
    expect(adapter.sessions.has('luban-orphan')).toBe(true)
    await service.dispose()
  })

  it('treats a semantically inconsistent ledger as wholly unreadable', async (): Promise<void> => {
    const { adapter, ledgerPath, service } = await fixture()
    adapter.sessions.set('luban-owned', {
      id: 'luban-owned',
      host: asHostId('fake'),
      kind: 'tmux',
      purpose: 'task',
      createdAt: 1,
    })
    await writeFile(
      ledgerPath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: 1,
        sessions: {
          'luban-owned': {
            spec: { id: 'luban-other', purpose: 'task', command: 'dsh' },
            session: {
              id: 'luban-owned',
              host: 'fake',
              kind: 'tmux',
              purpose: 'task',
              createdAt: 1,
            },
          },
        },
      }),
      'utf8',
    )

    await expect(service.restore()).resolves.toMatchObject({
      healthy: false,
      sessions: [{ id: 'luban-owned', alive: false, detail: 'ledger unreadable; orphan retained' }],
    })
    expect(adapter.creates).toBe(0)
    await service.dispose()
  })

  it('validates checkpoint ownership and bounds', async (): Promise<void> => {
    const { service } = await fixture()
    await service.ensureAlive({
      id: 'owned',
      purpose: 'task',
      command: 'dsh',
      ownerTaskId: asTaskId('A'),
    })
    await expect(
      service.saveCheckpoint('owned', {
        taskId: asTaskId('B'),
        stepList: ['one'],
        currentStep: 1,
        artifacts: [],
        savedAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(
      service.saveCheckpoint('owned', {
        taskId: asTaskId('A'),
        stepList: ['one'],
        currentStep: 2,
        artifacts: [],
        savedAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await service.ensureAlive({ id: 'unowned', purpose: 'task', command: 'dsh' })
    await expect(
      service.saveCheckpoint('unowned', {
        taskId: asTaskId('A'),
        stepList: ['one'],
        currentStep: 1,
        artifacts: [],
        savedAt: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await service.dispose()
  })

  it('restores a checkpoint through a fresh service and ledger instance', async (): Promise<void> => {
    const { ledgerPath, service } = await fixture()
    const checkpoint: Checkpoint = {
      taskId: asTaskId('TASK-RESTART'),
      stepList: ['configure', 'compile', 'test'],
      currentStep: 1,
      artifacts: ['configure.log'],
      savedAt: 1_788_048_000_000,
    }
    await service.ensureAlive({
      id: 'restart',
      purpose: 'build',
      command: 'dsh',
      ownerTaskId: checkpoint.taskId,
    })
    await service.saveCheckpoint('restart', checkpoint)
    await service.dispose()

    const adapter = new FakeAdapter()
    const events: KeepaliveEvent[] = []
    const restarted = new ManagedKeepaliveService({
      adapter,
      ledger: new KeepaliveLedgerStore(ledgerPath, new StaticClock()),
      patrolIntervalMs: 60_000,
      clock: new StaticClock(),
      publish: (event): void => {
        events.push(event)
      },
    })
    const report = await restarted.restore()

    expect(report.healthy).toBe(true)
    expect(adapter.creates).toBe(1)
    await expect(restarted.loadCheckpoint('restart')).resolves.toEqual(checkpoint)
    expect(events).toContainEqual(expect.objectContaining({ type: 'restored', checkpoint }))
    await restarted.dispose()
  })

  it('waits for an in-flight patrol before disposal and rejects later patrols', async (): Promise<void> => {
    const { adapter, events, service } = await fixture()
    await service.ensureAlive({ id: 'slow', purpose: 'build', command: 'node' })
    let announceProbe: (() => void) | undefined
    const probeStarted = new Promise<void>((resolve): void => {
      announceProbe = resolve
    })
    let finishProbe: (() => void) | undefined
    const probeGate = new Promise<void>((resolve): void => {
      finishProbe = resolve
    })
    adapter.isAliveHook = async (): Promise<boolean> => {
      announceProbe?.()
      await probeGate
      return false
    }

    const patrol = service.patrol()
    await probeStarted
    let disposed = false
    const disposal = service.dispose().then((): void => {
      disposed = true
    })
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    expect(disposed).toBe(false)
    finishProbe?.()
    await expect(patrol).resolves.toMatchObject({ healthy: false })
    await disposal
    expect(disposed).toBe(true)
    const eventCount = events.length
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    expect(events).toHaveLength(eventCount)
    await expect(service.patrol()).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
  })

  it('waits for an alert sink that remains active after patrol completion', async (): Promise<void> => {
    const { adapter, alerts, service } = await fixture()
    await service.ensureAlive({ id: 'alerting', purpose: 'build', command: 'node' })
    adapter.sessions.delete('luban-alerting')
    let finishAlert: (() => void) | undefined
    const alertGate = new Promise<void>((resolve): void => {
      finishAlert = resolve
    })
    alerts.reportHook = (): Promise<void> => alertGate

    await expect(service.patrol()).resolves.toMatchObject({ healthy: false })
    let disposed = false
    const disposal = service.dispose().then((): void => {
      disposed = true
    })
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    expect(disposed).toBe(false)

    finishAlert?.()
    await disposal
    expect(disposed).toBe(true)
  })

  it('patrols on schedule without overlapping a slow health probe', async (): Promise<void> => {
    const { adapter, service } = await fixture(5)
    await service.ensureAlive({ id: 'scheduled', purpose: 'build', command: 'node' })
    let announceFirstProbe: (() => void) | undefined
    const firstProbeStarted = new Promise<void>((resolve): void => {
      announceFirstProbe = resolve
    })
    let announceSecondProbe: (() => void) | undefined
    const secondProbeStarted = new Promise<void>((resolve): void => {
      announceSecondProbe = resolve
    })
    let finishFirstProbe: (() => void) | undefined
    const firstProbeGate = new Promise<void>((resolve): void => {
      finishFirstProbe = resolve
    })
    let probes = 0
    adapter.isAliveHook = async (): Promise<boolean> => {
      probes += 1
      if (probes === 1) {
        announceFirstProbe?.()
        await firstProbeGate
      } else if (probes === 2) {
        announceSecondProbe?.()
      }
      return true
    }
    try {
      service.start()
      await firstProbeStarted
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 25)
      })
      expect(probes).toBe(1)
      finishFirstProbe?.()
      await secondProbeStarted
      expect(probes).toBe(2)
      await service.dispose()
    } finally {
      finishFirstProbe?.()
    }
  })
})
