import { appendFile, chmod, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clock } from 'dsh-luban-core'
import type { AuditRecord, AuditSink } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const AUDIT_FILE_PATTERN = /^auth-(\d{4})-(\d{2})-(\d{2})\.jsonl$/u

/** Serialized JSONL audit writer with daily files and bounded retention. */
export class JsonlAuditLogger implements AuditSink {
  readonly #directory: string
  readonly #clock: Clock
  readonly #retentionDays: number
  #tail: Promise<void> = Promise.resolve()
  #lastCleanupDay = ''

  public constructor(directory: string, clock: Clock, retentionDays = 30) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
      throw new RangeError('luban-auth: audit retention must be a positive number of days')
    }
    this.#directory = directory
    this.#clock = clock
    this.#retentionDays = retentionDays
  }

  public record(entry: AuditRecord): Promise<void> {
    const task = this.#tail.then(() => this.#write(entry))
    this.#tail = task.catch((): undefined => undefined)
    return task
  }

  public async close(): Promise<void> {
    await this.#tail
  }

  async #write(entry: AuditRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const day = formatUtcDay(entry.time)
    if (day !== this.#lastCleanupDay) {
      await this.#removeExpiredFiles(this.#clock.now())
      this.#lastCleanupDay = day
    }
    const filePath = join(this.#directory, `auth-${day}.jsonl`)
    await appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(filePath, 0o600)
  }

  async #removeExpiredFiles(now: number): Promise<void> {
    const cutoff = now - this.#retentionDays * DAY_MS
    const entries = await readdir(this.#directory, { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry): Promise<void> => {
        if (!entry.isFile()) return
        const match = AUDIT_FILE_PATTERN.exec(entry.name)
        if (match === null) return
        const year = Number(match[1])
        const month = Number(match[2])
        const day = Number(match[3])
        if (Date.UTC(year, month - 1, day + 1) >= cutoff) return
        await unlink(join(this.#directory, entry.name)).catch((error: unknown): void => {
          if (errorCode(error) !== 'ENOENT') throw error
        })
      }),
    )
  }
}

export class NullAuditSink implements AuditSink {
  public record(_entry: AuditRecord): Promise<void> {
    return Promise.resolve()
  }

  public close(): Promise<void> {
    return Promise.resolve()
  }
}

function formatUtcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}
