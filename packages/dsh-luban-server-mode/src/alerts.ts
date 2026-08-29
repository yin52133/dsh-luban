import type { BuildJob, ResourceReport, TaskStore } from '@luban/core'

export interface BuildAlertSink {
  guardExceeded(report: ResourceReport): Promise<void>
  jobFailed(job: BuildJob): Promise<void>
}

export class TaskboardBuildAlertSink implements BuildAlertSink {
  readonly #store: TaskStore

  public constructor(store: TaskStore) {
    this.#store = store
  }

  public async guardExceeded(report: ResourceReport): Promise<void> {
    const tag = 'server-resource-guard'
    const existing = await this.#store.query({
      statuses: ['backlog', 'todo', 'doing', 'review'],
      tags: [tag],
    })
    if (existing.length > 0) return
    await this.#store.create({
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
      statuses: ['backlog', 'todo', 'doing', 'review'],
      tags: [tag],
    })
    if (existing.length > 0) return
    await this.#store.create({
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
