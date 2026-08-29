import { constants } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LubanError } from './errors.js'

export interface JsonCodec<Value> {
  decode(value: unknown): Value
  encode(value: Value): unknown
}

export interface AtomicJsonStoreOptions<Value> {
  readonly filePath: string
  readonly codec: JsonCodec<Value>
  readonly initial: () => Value
  readonly lockTimeoutMs?: number
  readonly staleLockMs?: number
  readonly backupCount?: number
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve): void => {
    setTimeout(resolve, milliseconds)
  })
}

/** Atomic JSON persistence with a cross-process lock and bounded rolling backups. */
export class AtomicJsonStore<Value> {
  readonly #filePath: string
  readonly #codec: JsonCodec<Value>
  readonly #initial: () => Value
  readonly #lockTimeoutMs: number
  readonly #staleLockMs: number
  readonly #backupCount: number

  public constructor(options: AtomicJsonStoreOptions<Value>) {
    this.#filePath = options.filePath
    this.#codec = options.codec
    this.#initial = options.initial
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5_000
    this.#staleLockMs = options.staleLockMs ?? 30_000
    this.#backupCount = options.backupCount ?? 7
  }

  public async read(): Promise<Value> {
    try {
      const raw = await readFile(this.#filePath, 'utf8')
      return this.#codec.decode(JSON.parse(raw) as unknown)
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return this.#initial()
      if (error instanceof SyntaxError) {
        throw new LubanError('E_IO', `Invalid JSON in ${this.#filePath}`, { cause: error })
      }
      if (error instanceof LubanError) throw error
      throw new LubanError('E_IO', `Unable to read ${this.#filePath}`, {
        retriable: true,
        cause: error,
      })
    }
  }

  public async write(value: Value): Promise<void> {
    const release = await this.#acquireLock()
    try {
      await this.#writeUnlocked(value)
    } finally {
      await release()
    }
  }

  public async update(mutator: (current: Value) => Value | Promise<Value>): Promise<Value> {
    const release = await this.#acquireLock()
    try {
      const current = await this.read()
      const next = await mutator(current)
      await this.#writeUnlocked(next)
      return next
    } finally {
      await release()
    }
  }

  async #writeUnlocked(value: Value): Promise<void> {
    const directory = dirname(this.#filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${basename(this.#filePath)}.${randomUUID()}.tmp`)
    const serialized = `${JSON.stringify(this.#codec.encode(value), null, 2)}\n`
    try {
      await this.#rotateBackups()
      await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      // Windows requires a writable handle for FlushFileBuffers/fsync.
      const handle = await open(temporary, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.#filePath)
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch((): undefined => undefined)
      throw new LubanError('E_IO', `Unable to atomically write ${this.#filePath}`, {
        retriable: true,
        cause: error,
      })
    }
  }

  async #rotateBackups(): Promise<void> {
    if (this.#backupCount <= 0) return
    try {
      await access(this.#filePath, constants.F_OK)
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    for (let index = this.#backupCount - 1; index >= 1; index -= 1) {
      const source = `${this.#filePath}.bak.${String(index)}`
      const target = `${this.#filePath}.bak.${String(index + 1)}`
      try {
        await rename(source, target)
      } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
    await copyFile(this.#filePath, `${this.#filePath}.bak.1`)
  }

  async #acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.#filePath}.lock`
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + this.#lockTimeoutMs
    while (Date.now() <= deadline) {
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        await handle.writeFile(`${String(process.pid)}\n${String(Date.now())}\n`, 'utf8')
        return async (): Promise<void> => {
          await handle.close()
          await rm(lockPath, { force: true })
        }
      } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') {
          throw new LubanError('E_IO', `Unable to lock ${this.#filePath}`, {
            retriable: true,
            cause: error,
          })
        }
        try {
          const lockStat = await stat(lockPath)
          if (Date.now() - lockStat.mtimeMs > this.#staleLockMs) {
            await rm(lockPath, { force: true })
            continue
          }
        } catch (statError: unknown) {
          if (errorCode(statError) === 'ENOENT') continue
          throw statError
        }
        await delay(25)
      }
    }
    throw new LubanError('E_TIMEOUT', `Timed out acquiring lock for ${this.#filePath}`, {
      retriable: true,
    })
  }
}
