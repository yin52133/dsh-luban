import type { TaskStore } from '@yin52133/dsh-luban-core'
import { asAccountId } from '@yin52133/dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { TaskboardKeepaliveAlertSink } from '../src/alerts.js'

const ALICE = asAccountId('alice')

describe('TaskboardKeepaliveAlertSink', (): void => {
  it('creates alerts in the owning account and ignores unowned legacy health rows', async () => {
    const query = vi.fn<TaskStore['query']>().mockResolvedValue([])
    const create = vi.fn<TaskStore['create']>()
    const sink = new TaskboardKeepaliveAlertSink({ query, create } as unknown as TaskStore)

    await sink.report({
      healthy: false,
      checkedAt: 10,
      sessions: [
        { accountId: ALICE, id: 'luban-alice', alive: false, detail: 'not running' },
        { id: 'luban-legacy', alive: false, detail: 'not running' },
        { accountId: ALICE, id: 'luban-healthy', alive: true },
      ],
    })

    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith({
      accountId: ALICE,
      statuses: ['backlog', 'todo', 'doing', 'review'],
      tags: ['keepalive:luban-alice'],
    })
    expect(create).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ALICE,
        title: 'Keepalive alert: luban-alice',
        tags: ['keepalive', 'health', 'keepalive:luban-alice'],
      }),
    )
  })
})
