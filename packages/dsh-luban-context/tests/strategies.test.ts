import { describe, expect, it, vi } from 'vitest'
import type { ContextSegment } from 'dsh-luban-core'
import {
  partitionRecent,
  SummarizeStrategy,
  SummarizeVirtualFileStrategy,
  VirtualFileStrategy,
} from '../src/strategies.js'
import type { ReadableCompactionContext } from '../src/strategies.js'

const segments: readonly ContextSegment[] = [
  { startSeq: 0, endSeq: 0, estTokens: 10, topic: 'one' },
  { startSeq: 1, endSeq: 1, estTokens: 10, topic: 'two' },
  { startSeq: 2, endSeq: 2, estTokens: 10, topic: 'three' },
]

describe('compaction strategies', () => {
  it('partitions complete recent segments without mutating input', () => {
    expect(partitionRecent(segments, 15)).toEqual({
      keep: [segments[2]],
      older: segments.slice(0, 2),
    })
    expect(segments).toHaveLength(3)
    expect(() =>
      partitionRecent(
        [
          { startSeq: 2, endSeq: 2, estTokens: 1 },
          { startSeq: 1, endSeq: 1, estTokens: 1 },
        ],
        10,
      ),
    ).toThrow(/ordered/u)
  })

  it('keeps summarize and virtual-file strategies independently pluggable', () => {
    const summarize = new SummarizeStrategy().plan({ segments, budgetTokens: 15 })
    expect(summarize.summarize).toEqual(segments.slice(0, 2))
    expect(summarize.archive).toEqual([])
    const virtual = new VirtualFileStrategy().plan({ segments, budgetTokens: 15 })
    expect(virtual.archive).toEqual(segments.slice(0, 2))
    expect(virtual.summarize).toEqual([])
  })

  it('archives originals, summarizes them, and injects both summary and indexes', async () => {
    const archive = vi
      .fn<(segment: ContextSegment, content: string) => Promise<string>>()
      .mockImplementation((segment) => Promise.resolve(`archive/${String(segment.startSeq)}.md`))
    const inject = vi
      .fn<(summary: string, files: readonly string[]) => Promise<void>>()
      .mockResolvedValue()
    const strategy = new SummarizeVirtualFileStrategy()
    const plan = strategy.plan({ segments, budgetTokens: 15 })
    const context: ReadableCompactionContext = {
      sessionId: 'session' as never,
      archiveDir: '/archive',
      read: (segment: ContextSegment): Promise<string> =>
        Promise.resolve(`content-${String(segment.startSeq)}`),
      archive,
      summarize: (): Promise<string> => Promise.resolve('summary with decisions'),
      inject,
    }
    const result = await strategy.execute(plan, context)
    expect(archive).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledWith('summary with decisions', ['archive/0.md', 'archive/1.md'])
    expect(result.beforeTokens).toBe(30)
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
  })
})
