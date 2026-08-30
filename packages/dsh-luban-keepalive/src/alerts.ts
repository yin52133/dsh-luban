import type { HealthReport, TaskStore } from 'dsh-luban-core'

export interface KeepaliveAlertSink {
  report(report: HealthReport): Promise<void>
}

export class TaskboardKeepaliveAlertSink implements KeepaliveAlertSink {
  readonly #store: TaskStore

  public constructor(store: TaskStore) {
    this.#store = store
  }

  public async report(report: HealthReport): Promise<void> {
    for (const session of report.sessions) {
      if (session.alive) continue
      const tag = `keepalive:${session.id}`
      const existing = await this.#store.query({
        statuses: ['backlog', 'todo', 'doing', 'review'],
        tags: [tag],
      })
      if (existing.length > 0) continue
      await this.#store.create({
        title: `Keepalive alert: ${session.id}`,
        description: session.detail ?? 'Managed session is not alive',
        status: 'todo',
        hostScope: 'any',
        priority: 'P1',
        acceptance: `Restore ${session.id} and verify the next health report is healthy`,
        tags: ['keepalive', 'health', tag],
      })
    }
  }
}
