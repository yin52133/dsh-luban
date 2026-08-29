import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const directory = join(tmpdir(), `dsh-luban-core-${randomUUID()}`)
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
    const input = [
      'password: hunter2',
      'api_key=super-secret',
      'Authorization: Bearer abc.def-123',
      'ghp_1234567890abcdef',
      '[REDACTED TEST KEY HEADER]',
      'private material',
      '[REDACTED TEST KEY FOOTER]',
    ].join('\n')

    const output = redactSecrets(input)
    expect(output).not.toContain('hunter2')
    expect(output).not.toContain('super-secret')
    expect(output).not.toContain('abc.def-123')
    expect(output).not.toContain('1234567890abcdef')
    expect(output).not.toContain('private material')
    expect(output.match(/\[REDACTED\]/gu)?.length).toBe(5)
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

  it('initializes, serializes concurrent updates, and rotates backups', async (): Promise<void> => {
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

    await store.write(9)
    await store.write(10)
    expect(JSON.parse(await readFile(`${filePath}.bak.1`, 'utf8'))).toBe(9)
    expect(JSON.parse(await readFile(`${filePath}.bak.2`, 'utf8'))).toBe(8)
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
