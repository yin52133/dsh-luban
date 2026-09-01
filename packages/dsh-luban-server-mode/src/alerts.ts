import type { AccountId, BuildJob, ResourceReport, TaskStore } from '@yin52133/dsh-luban-core'

export interface BuildAlertSink {
  guardExceeded(report: ResourceReport, accountId: AccountId): Promise<void>
  jobFailed(job: BuildJob): Promise<void>
}

export class TaskboardBuildAlertSink implements BuildAlertSink {
  readonly #store: TaskStore

  public constructor(store: TaskStore) {
    this.#store = store
  }

  public async guardExceeded(report: ResourceReport, accountId: AccountId): Promise<void> {
    const tag = 'server-resource-guard'
    const existing = await this.#store.query({
      accountId,
      statuses: ['backlog', 'todo', 'doing', 'review'],
      tags: [tag],
    })
    if (existing.length > 0) return
    await this.#store.create({
      accountId,
      title: 'Server build queue paused by resource guard',
      description: `diskFreeGb=${report.diskFreeGb.toFixed(2)}, load1=${report.load1.toFixed(2)}`,
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'Restore disk/load headroom and confirm the build queue resumes',
      tags: ['server-mode', 'resource', tag],
    })
  }

  public async jobFailed(job: BuildJob): Promise<void> {
    const tag = `build:${job.id}`
    const existing = await this.#store.query({
      ...(job.accountId === undefined ? {} : { accountId: job.accountId }),
      statuses: ['backlog', 'todo', 'doing', 'review'],
      tags: [tag],
    })
    if (existing.length > 0) return
    await this.#store.create({
      ...(job.accountId === undefined ? {} : { accountId: job.accountId }),
      title: `Build failed: ${job.templateId}`,
      description: job.errorLogExcerpt?.slice(-4_000) ?? 'Build worker failed without an excerpt',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: `Resolve build job ${job.id} and rerun the template`,
      tags: ['server-mode', 'build-failed', tag],
    })
  }
}
