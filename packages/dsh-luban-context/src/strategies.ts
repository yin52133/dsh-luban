import type {
  CompactionContext,
  CompactionPlan,
  CompactionResult,
  CompactionStrategy,
  ContextSegment,
} from '@luban/core'
import { LubanError } from '@luban/core'

export interface ReadableCompactionContext extends CompactionContext {
  read(segment: ContextSegment): Promise<string>
}

function segmentKey(segment: ContextSegment): string {
  return `${String(segment.startSeq)}:${String(segment.endSeq)}`
}

function validateSegments(segments: readonly ContextSegment[]): void {
  let previousEnd = -1
  for (const segment of segments) {
    if (
      !Number.isSafeInteger(segment.startSeq) ||
      !Number.isSafeInteger(segment.endSeq) ||
      !Number.isSafeInteger(segment.estTokens) ||
      segment.startSeq < 0 ||
      segment.endSeq < segment.startSeq ||
      segment.estTokens < 0 ||
      segment.startSeq <= previousEnd
    ) {
      throw new LubanError(
        'E_INVALID_INPUT',
        'Context segments must be ordered, disjoint, and non-negative',
      )
    }
    previousEnd = segment.endSeq
  }
}

/** Keep the newest complete segments that fit the budget; never split a segment. */
export function partitionRecent(
  segments: readonly ContextSegment[],
  budgetTokens: number,
): { readonly keep: readonly ContextSegment[]; readonly older: readonly ContextSegment[] } {
  validateSegments(segments)
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1) {
    throw new LubanError('E_INVALID_INPUT', 'budgetTokens must be a positive integer')
  }
  let used = 0
  let firstKept = segments.length
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment === undefined) continue
    if (used > 0 && used + segment.estTokens > budgetTokens) break
    used += segment.estTokens
    firstKept = index
  }
  return { keep: segments.slice(firstKept), older: segments.slice(0, firstKept) }
}

function beforeTokens(plan: CompactionPlan): number {
  const unique = new Map<string, ContextSegment>()
  for (const segment of [...plan.keep, ...plan.summarize, ...plan.archive]) {
    unique.set(segmentKey(segment), segment)
  }
  return [...unique.values()].reduce((total, segment): number => total + segment.estTokens, 0)
}

function keptTokens(plan: CompactionPlan): number {
  return plan.keep.reduce((total, segment): number => total + segment.estTokens, 0)
}

function readable(context: CompactionContext): ReadableCompactionContext {
  if (!('read' in context) || typeof context.read !== 'function') {
    throw new LubanError(
      'E_UNAVAILABLE',
      'This compaction strategy requires a readable context adapter',
    )
  }
  return context as ReadableCompactionContext
}

async function archiveSegments(
  segments: readonly ContextSegment[],
  context: CompactionContext,
): Promise<readonly string[]> {
  const source = readable(context)
  const files: string[] = []
  for (const segment of segments) {
    files.push(await context.archive(segment, await source.read(segment)))
  }
  return files
}

function injectedTokens(summary: string, files: readonly string[]): number {
  return Math.ceil((summary.length + files.join('\n').length) / 4)
}

export class SummarizeStrategy implements CompactionStrategy {
  public readonly id = 'summarize'

  public plan(input: {
    readonly segments: readonly ContextSegment[]
    readonly budgetTokens: number
  }): CompactionPlan {
    const { keep, older } = partitionRecent(input.segments, input.budgetTokens)
    return {
      keep,
      summarize: older,
      archive: [],
      budgetTokens: input.budgetTokens,
      strategyId: this.id,
    }
  }

  public async execute(
    plan: CompactionPlan,
    context: CompactionContext,
  ): Promise<CompactionResult> {
    const summary = plan.summarize.length === 0 ? '' : await context.summarize(plan.summarize)
    if (summary !== '') await context.inject(summary, [])
    return {
      beforeTokens: beforeTokens(plan),
      afterTokens: keptTokens(plan) + injectedTokens(summary, []),
      archiveFiles: [],
    }
  }
}

export class VirtualFileStrategy implements CompactionStrategy {
  public readonly id = 'virtualfile'

  public plan(input: {
    readonly segments: readonly ContextSegment[]
    readonly budgetTokens: number
  }): CompactionPlan {
    const { keep, older } = partitionRecent(input.segments, input.budgetTokens)
    return {
      keep,
      summarize: [],
      archive: older,
      budgetTokens: input.budgetTokens,
      strategyId: this.id,
    }
  }

  public async execute(
    plan: CompactionPlan,
    context: CompactionContext,
  ): Promise<CompactionResult> {
    const files = await archiveSegments(plan.archive, context)
    const index =
      files.length === 0
        ? ''
        : `Older context was archived. Retrieve exact details from:\n${files.map((file): string => `- ${file}`).join('\n')}`
    if (index !== '') await context.inject(index, files)
    return {
      beforeTokens: beforeTokens(plan),
      afterTokens: keptTokens(plan) + injectedTokens(index, files),
      archiveFiles: files,
    }
  }
}

export class SummarizeVirtualFileStrategy implements CompactionStrategy {
  public readonly id = 'summarize+virtualfile'

  public plan(input: {
    readonly segments: readonly ContextSegment[]
    readonly budgetTokens: number
  }): CompactionPlan {
    const { keep, older } = partitionRecent(input.segments, input.budgetTokens)
    return {
      keep,
      summarize: older,
      archive: older,
      budgetTokens: input.budgetTokens,
      strategyId: this.id,
    }
  }

  public async execute(
    plan: CompactionPlan,
    context: CompactionContext,
  ): Promise<CompactionResult> {
    const files = await archiveSegments(plan.archive, context)
    const summary = plan.summarize.length === 0 ? '' : await context.summarize(plan.summarize)
    if (summary !== '' || files.length > 0) await context.inject(summary, files)
    return {
      beforeTokens: beforeTokens(plan),
      afterTokens: keptTokens(plan) + injectedTokens(summary, files),
      archiveFiles: files,
    }
  }
}
