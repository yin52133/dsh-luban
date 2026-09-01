import { spawn } from 'node:child_process'
import { mkdir, open, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTH_ROUTES,
  AtomicJsonStore,
  LubanError,
  TypedEventBus,
  isLubanError,
  modulePrefix,
  moduleRoute,
  redactSecrets,
} from '../src/index.js'

const temporaryDirectories = new Set<string>()

async function temporaryDirectory(): Promise<string> {
  const directory = join(tmpdir(), `@yin52133/dsh-luban-core-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  temporaryDirectories.add(directory)
  return directory
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...temporaryDirectories].map(async (directory): Promise<void> => {
      await rm(directory, { force: true, recursive: true })
      temporaryDirectories.delete(directory)
    }),
  )
})

describe('route helpers', (): void => {
  it('uses the public luban plugin prefix convention', (): void => {
    expect(modulePrefix('auth')).toBe('/luban-auth')
    expect(moduleRoute('taskboard', '/tasks')).toBe('/luban-taskboard/tasks')
    expect(moduleRoute('server-mode')).toBe('/luban-server-mode')
    expect(AUTH_ROUTES.login).toBe('/luban-auth/login')
  })
})

describe('LubanError', (): void => {
  it('serializes only the stable public error shape', (): void => {
    const secretCause = new Error('password=never-serialize')
    const error = new LubanError('E_TIMEOUT', 'operation timed out', {
      cause: secretCause,
      retriable: true,
      details: { phase: 'lock' },
    })

    expect(isLubanError(error)).toBe(true)
    expect(error.cause).toBe(secretCause)
    expect(error.toJSON()).toEqual({
      name: 'LubanError',
      code: 'E_TIMEOUT',
      message: 'operation timed out',
      retriable: true,
      details: { phase: 'lock' },
    })
    expect(JSON.stringify(error)).not.toContain('never-serialize')
  })
})

describe('TypedEventBus', (): void => {
  it('delivers typed events and supports deterministic disposal', (): void => {
    interface Events {
      readonly update: { readonly version: number }
    }

    const versions: number[] = []
    const bus = new TypedEventBus<Events>()
    const unsubscribe = bus.on('update', ({ version }): void => {
      versions.push(version)
    })

    bus.emit('update', { version: 1 })
    unsubscribe()
    bus.emit('update', { version: 2 })

    expect(versions).toEqual([1])
  })

  it('takes a listener snapshot so disposal during emit is safe', (): void => {
    interface Events {
      readonly ping: number
    }

    const calls: string[] = []
    const bus = new TypedEventBus<Events>()
    let disposeSecond = (): void => undefined
    bus.on('ping', (): void => {
      calls.push('first')
      disposeSecond()
    })
    disposeSecond = bus.on('ping', (): void => {
      calls.push('second')
    })

    bus.emit('ping', 1)
    bus.emit('ping', 2)

    expect(calls).toEqual(['first', 'second', 'first'])
  })
})

describe('redactSecrets', (): void => {
  it('redacts assignments, bearer tokens, provider tokens, and private keys', (): void => {
    const rsaPrivateKeyHeader = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')
    const rsaPrivateKeyFooter = ['-----END RSA', 'PRIVATE KEY-----'].join(' ')
    const openSshPrivateKeyHeader = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ')
    const input = [
      'password: hunter2',
      'api_key=super-secret',
      'Authorization: Bearer abc.def-123==',
      'ghp_1234567890abcdef',
      rsaPrivateKeyHeader,
      'private material',
      rsaPrivateKeyFooter,
    ].join('\n')

    const output = redactSecrets(input)
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('super-secret')
    expect(output).not.toContain('abc.def-123')
    expect(output).not.toContain('1234567890abcdef')
    expect(output).not.toContain('private material')
    expect(output.match(/\[REDACTED\]/gu)?.length).toBe(5)

    const partialKey = redactSecrets(
      `${openSshPrivateKeyHeader}\npartial private material without a footer`,
    )
    expect(partialKey).toBe('[REDACTED]')

    const paddedKey = redactSecrets(
      `${rsaPrivateKeyHeader}\nc2VjcmV0LW1hdGVyaWFsPT0=\n${rsaPrivateKeyFooter}`,
    )
    expect(paddedKey).toBe('[REDACTED]')
  })
})

describe('AtomicJsonStore', (): void => {
  const numberCodec = {
    decode(value: unknown): number {
      if (typeof value !== 'number') throw new LubanError('E_INVALID_INPUT', 'number required')
      return value
    },
    encode(value: number): unknown {
      return value
    },
  }

  interface CrashSnapshot {
    readonly generation: 'old' | 'new'
    readonly payload: string
    readonly closingMarker: string
  }

  const crashSnapshotCodec = {
    decode(value: unknown): CrashSnapshot {
      if (typeof value !== 'object' || value === null) {
        throw new LubanError('E_INVALID_INPUT', 'crash snapshot object required')
      }
      const row = value as Readonly<Record<string, unknown>>
      if (
        (row.generation !== 'old' && row.generation !== 'new') ||
        typeof row.payload !== 'string' ||
        typeof row.closingMarker !== 'string'
      ) {
        throw new LubanError('E_INVALID_INPUT', 'complete crash snapshot required')
      }
      return {
        generation: row.generation,
        payload: row.payload,
        closingMarker: row.closingMarker,
      }
    },
    encode(value: CrashSnapshot): unknown {
      return value
    },
  }

  it('serializes concurrent updates and retains one snapshot per local calendar day', async (): Promise<void> => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'ledger.json')
    const store = new AtomicJsonStore({
      filePath,
      codec: numberCodec,
      initial: (): number => 0,
      backupCount: 2,
    })

    expect(await store.read()).toBe(0)
    await Promise.all(
      Array.from({ length: 8 }, async (): Promise<void> => {
        await store.update((current): number => current + 1)
      }),
    )
    expect(await store.read()).toBe(8)
    expect(JSON.parse(await readFile(`${filePath}.bak.1`, 'utf8'))).toBe(1)

    await store.write(9)
    await store.write(10)
    expect(JSON.parse(await readFile(`${filePath}.bak.1`, 'utf8'))).toBe(1)
    await expect(readFile(`${filePath}.bak.2`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const previousDay = new Date(2000, 0, 1)
    await utimes(`${filePath}.bak.1`, previousDay, previousDay)
    await store.write(11)
    expect(JSON.parse(await readFile(`${filePath}.bak.1`, 'utf8'))).toBe(10)
    expect(JSON.parse(await readFile(`${filePath}.bak.2`, 'utf8'))).toBe(1)

    await store.write(12)
    expect(JSON.parse(await readFile(`${filePath}.bak.1`, 'utf8'))).toBe(10)
  })

  it('publishes updates while local readers repeatedly open the ledger', async (): Promise<void> => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'read-write-ledger.json')
    const store = new AtomicJsonStore({
      filePath,
      codec: numberCodec,
      initial: (): number => 0,
      backupCount: 0,
    })
    await store.write(0)

    let reading = true
    const readers = Array.from({ length: 4 }, async (): Promise<void> => {
      while (reading) await store.read()
    })
    try {
      for (let value = 1; value <= 4; value += 1) await store.write(value)
    } finally {
      reading = false
      await Promise.all(readers)
    }

    expect(await store.read()).toBe(4)
  })

  it('keeps the old JSON complete when its writer is killed at the publish boundary', async (): Promise<void> => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'crash-ledger.json')
    const oldSnapshot: CrashSnapshot = {
      generation: 'old',
      payload: 'stable-old-payload',
      closingMarker: 'old-complete',
    }
    const store = new AtomicJsonStore({
      filePath,
      codec: crashSnapshotCodec,
      initial: (): CrashSnapshot => oldSnapshot,
      backupCount: 0,
    })
    await store.write(oldSnapshot)

    const writerPath = fileURLToPath(new URL('./fixtures/atomic-json-writer.ts', import.meta.url))
    const writer = spawn(process.execPath, ['--import', 'tsx', writerPath, filePath, '1024'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let writerOutput = ''
    let writerError = ''
    writer.stdout.setEncoding('utf8')
    writer.stdout.on('data', (chunk: string): void => {
      writerOutput += chunk
    })
    writer.stderr.setEncoding('utf8')
    writer.stderr.on('data', (chunk: string): void => {
      writerError += chunk
    })
    const writerExit = new Promise<{
      readonly code: number | null
      readonly signal: string | null
    }>((resolve, reject): void => {
      writer.once('error', reject)
      writer.once('exit', (code, signal): void => resolve({ code, signal }))
    })

    try {
      await new Promise<void>((resolve, reject): void => {
        const timeout = setTimeout((): void => {
          reject(new Error(`writer did not reach the publish boundary: ${writerError}`))
        }, 10_000)
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          clearTimeout(timeout)
          writer.stdout.off('data', onOutput)
          reject(
            new Error(
              `writer exited before the publish boundary (${String(code)}, ${String(signal)}): ${writerError}`,
            ),
          )
        }
        const onOutput = (): void => {
          if (!writerOutput.includes('before-publish\n')) return
          clearTimeout(timeout)
          writer.off('exit', onExit)
          writer.stdout.off('data', onOutput)
          resolve()
        }
        writer.stdout.on('data', onOutput)
        writer.once('exit', onExit)
      })
      expect(writer.kill('SIGKILL')).toBe(true)
      const exit = await writerExit
      expect(exit.signal !== null || exit.code !== 0).toBe(true)
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill('SIGKILL')
        await writerExit.catch((): undefined => undefined)
      }
    }

    const serialized = await readFile(filePath, 'utf8')
    const parsed = crashSnapshotCodec.decode(JSON.parse(serialized) as unknown)
    expect(parsed).toEqual(oldSnapshot)

    const reopened = new AtomicJsonStore({
      filePath,
      codec: crashSnapshotCodec,
      initial: (): CrashSnapshot => oldSnapshot,
      lockTimeoutMs: 1_000,
      staleLockMs: 0,
      backupCount: 0,
    })
    expect(await reopened.read()).toEqual(parsed)
  })

  it('retries an atomic publish until an external Windows read handle closes', async (): Promise<void> => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'external-reader-ledger.json')
    const store = new AtomicJsonStore({
      filePath,
      codec: numberCodec,
      initial: (): number => 0,
      backupCount: 0,
    })
    await store.write(0)

    const reader = await open(filePath, 'r')
    const writing = store.write(1)
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 50)
    })
    await reader.close()
    await writing

    expect(await store.read()).toBe(1)
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await expect(readFile(`${filePath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds the default daily history to seven write days', async (): Promise<void> => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'seven-day-ledger.json')
    const store = new AtomicJsonStore({
      filePath,
      codec: numberCodec,
      initial: (): number => 0,
    })
    await store.write(0)
    const previousDay = new Date(2000, 0, 1)
    for (let value = 1; value <= 8; value += 1) {
      await store.write(value)
      await utimes(`${filePath}.bak.1`, previousDay, previousDay)
    }

    for (let index = 1; index <= 7; index += 1) {
      expect(JSON.parse(await readFile(`${filePath}.bak.${String(index)}`, 'utf8'))).toBe(8 - index)
    }
    await expect(readFile(`${filePath}.bak.8`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports invalid JSON as a stable IO error', async (): Promise<void> => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'invalid.json')
    await writeFile(filePath, '{broken', 'utf8')
    const store = new AtomicJsonStore({ filePath, codec: numberCodec, initial: (): number => 0 })

    await expect(store.read()).rejects.toMatchObject({ code: 'E_IO', retriable: false })
  })

  it('recovers a stale lock and times out on an active lock', async (): Promise<void> => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'locked.json')
    const lockPath = `${filePath}.lock`
    await writeFile(lockPath, 'stale', 'utf8')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const recovering = new AtomicJsonStore({
      filePath,
      codec: numberCodec,
      initial: (): number => 0,
      lockTimeoutMs: 100,
      staleLockMs: 10,
    })
    await recovering.write(1)
    expect(await recovering.read()).toBe(1)

    await writeFile(lockPath, 'active', 'utf8')
    const blocked = new AtomicJsonStore({
      filePath,
      codec: numberCodec,
      initial: (): number => 0,
      lockTimeoutMs: 20,
      staleLockMs: 60_000,
    })
    await expect(blocked.write(2)).rejects.toMatchObject({ code: 'E_TIMEOUT', retriable: true })
  })
})
