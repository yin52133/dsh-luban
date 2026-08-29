import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ChannelEndpoint, SnippetFile } from '@luban/core'
import { LubanError, redactSecrets } from '@luban/core'
import type { Config } from './config.js'

function boundedContent(content: string, maxLines: number, maxBytes: number): string {
  const lines = content.split(/\r?\n/u).slice(-maxLines)
  let output = redactSecrets(lines.join('\n'))
  const encoded = Buffer.from(output, 'utf8')
  if (encoded.byteLength > maxBytes)
    output = encoded.subarray(encoded.byteLength - maxBytes).toString('utf8')
  return output
}

/** Redacted, bounded and atomically persisted debug artifacts. */
export class SnippetStore {
  readonly #config: Config['snippet']

  public constructor(config: Config['snippet']) {
    this.#config = config
  }

  public async write(
    endpoint: ChannelEndpoint,
    content: string,
    timeFrom: number,
    timeTo: number,
  ): Promise<SnippetFile> {
    if (!Number.isFinite(timeFrom) || !Number.isFinite(timeTo) || timeFrom > timeTo) {
      throw new LubanError('E_INVALID_INPUT', 'Snippet time range is invalid')
    }
    const safe = boundedContent(content, this.#config.maxLines, this.#config.maxBytes)
    if (safe === '') throw new LubanError('E_INVALID_INPUT', 'Snippet is empty')
    await mkdir(this.#config.dir, { recursive: true })
    const prefix = endpoint.kind.replace(/[^a-z0-9-]/gu, '-')
    const file = join(this.#config.dir, `${prefix}-${String(timeFrom)}-${randomUUID()}.log`)
    const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${safe}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      await rename(temporary, file)
    } catch (error: unknown) {
      await handle.close().catch((): undefined => undefined)
      await rm(temporary, { force: true }).catch((): undefined => undefined)
      throw new LubanError('E_IO', 'Unable to persist debug snippet', { cause: error })
    }
    return Object.freeze({ path: file, content: safe, timeFrom, timeTo, endpoint })
  }
}
