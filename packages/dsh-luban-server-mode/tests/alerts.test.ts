import type { Task, TaskStore } from '@yin52133/dsh-luban-core'
import { asAccountId } from '@yin52133/dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { TaskboardBuildAlertSink } from '../src/alerts.js'

describe('TaskboardBuildAlertSink', (): void => {
  it('queries and creates resource guard alerts in the affected account', async (): Promise<void> => {
    const query = vi.fn<TaskStore['query']>().mockResolvedValue([])
    const create = vi.fn<TaskStore['create']>().mockResolvedValue({} as Task)
    const sink = new TaskboardBuildAlertSink({ query, create } as unknown as TaskStore)
    const alice = asAccountId('alice')
    const bob = asAccountId('bob')
    const report = { diskFreeGb: 2, load1: 1, queueDepth: 2, paused: true }

    await sink.guardExceeded(report, alice)
    await sink.guardExceeded(report, bob)

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ accountId: alice, tags: ['server-resource-guard'] }),
    )
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accountId: bob, tags: ['server-resource-guard'] }),
    )
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ accountId: alice }))
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ accountId: bob }))
  })
})
