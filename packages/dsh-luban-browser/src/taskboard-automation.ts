import type { AgentClaimService, Task, TaskEvent, TaskStore } from '@luban/core'
import { BrowserError } from './errors.js'
import type { BrowserQueue } from './types.js'

const TEMPLATE_TAG = 'browser-template:'
const PARAMETER_TAG = 'browser-param:'

export class BrowserTaskboardAutomation {
  readonly #queue: BrowserQueue
  readonly #claims: AgentClaimService
  readonly #running = new Set<string>()

  public constructor(queue: BrowserQueue, claims: AgentClaimService) {
    this.#queue = queue
    this.#claims = claims
  }

  public bind(store: TaskStore): () => void {
    return store.subscribe((event): void => {
      if (event.type !== 'transitioned' || event.to !== 'doing') return
      void this.executeClaimedTask(event.task).catch((): undefined => undefined)
    })
  }

  public async executeClaimedTask(task: Task): Promise<void> {
    if (this.#running.has(task.id)) return
    if (!task.tags.includes('browser')) return
    if (task.claim?.actor.kind !== 'agent') {
      throw new BrowserError('E_BROWSER_POLICY', 'Automatic browser tasks require an agent claim')
    }
    this.#running.add(task.id)
    try {
      if (!task.tags.includes('auto-ok')) {
        throw new BrowserError(
          'E_BROWSER_POLICY',
          'Automatic browser tasks require the auto-ok tag',
        )
      }
      const templateTags = task.tags.filter((tag) => tag.startsWith(TEMPLATE_TAG))
      if (templateTags.length !== 1) {
        throw new BrowserError(
          'E_BROWSER_POLICY',
          'Automatic browser tasks require exactly one template tag',
        )
      }
      const templateId = templateTags[0]?.slice(TEMPLATE_TAG.length) ?? ''
      const params = parseParameters(task.tags)
      await this.#claims.reportProgress(task.id, {
        summary: 'Browser automation queued',
        percent: 0,
      })
      const queued = this.#queue.enqueue({
        task: {
          templateId,
          goal: task.description.trim() === '' ? task.title : task.description,
        },
        params,
        automatic: true,
      })
      const completed = await this.#queue.wait(queued.id)
      if (completed.status !== 'succeeded' || completed.result === undefined) {
        await this.#claims.fail(task.id, completed.error?.message ?? 'Browser automation failed')
        return
      }
      await this.#claims.reportProgress(task.id, {
        summary: 'Browser automation completed',
        percent: 100,
      })
      await this.#claims.complete(
        task.id,
        {
          kind: 'artifact',
          ref: completed.result.screenshots[0] ?? `browser-run:${completed.id}`,
          summary: summarize(completed.result.text),
          at: Date.now(),
          by: task.claim.actor,
        },
        { autoDone: true },
      )
    } catch (error: unknown) {
      await this.#claims.fail(
        task.id,
        error instanceof Error ? error.message : 'Browser automation failed',
      )
      throw error
    } finally {
      this.#running.delete(task.id)
    }
  }
}

export function isBrowserTaskEvent(event: TaskEvent): boolean {
  return (
    event.type === 'transitioned' && event.to === 'doing' && event.task.tags.includes('browser')
  )
}

function parseParameters(tags: readonly string[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  for (const tag of tags) {
    if (!tag.startsWith(PARAMETER_TAG)) continue
    const assignment = tag.slice(PARAMETER_TAG.length)
    const separator = assignment.indexOf('=')
    const name = separator < 0 ? '' : assignment.slice(0, separator)
    const value = separator < 0 ? '' : assignment.slice(separator + 1)
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || value === '') {
      throw new BrowserError('E_BROWSER_POLICY', 'Invalid browser-param tag')
    }
    output[name] = value
  }
  return Object.freeze(output)
}

function summarize(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return 'Browser automation completed'
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`
}
