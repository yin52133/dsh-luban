import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { LubanError } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWorker } from '../src/build-worker.js'
import { NodeProcessRunner } from '../src/process-runner.js'
import { NodeResourceProbe } from '../src/resources.js'

const directories = new Set<string>()
const childProcesses = new Set<number>()
type Spawn = typeof spawn

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough()
  public readonly stderr = new PassThrough()
  public readonly pid: number | undefined
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  public readonly kills: NodeJS.Signals[] = []
  public unreferenced = false

  public constructor(options: { readonly pid: number | undefined } = { pid: 42_424 }) {
    super()
    this.pid = options.pid
  }

  public kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    return true
  }

  public unref(): void {
    this.unreferenced = true
  }
}

function fakeSpawner(child: FakeChild): Spawn {
  return ((): FakeChild => child) as unknown as Spawn
}

const LONG_RUNNING_NODE_SCRIPT = String.raw`
  const { writeFileSync } = require('node:fs');
  process.stdout.write('stdout-started\n');
  process.stderr.write('stderr-started\n');
  writeFileSync(process.argv[1], String(process.pid));
  if (process.platform !== 'win32') {
    process.on('SIGTERM', () => process.stdout.write('sigterm-received\n'));
  }
  let sequence = 0;
  setInterval(() => {
    sequence += 1;
    process.stdout.write('stdout-heartbeat-' + sequence + '\n');
    process.stderr.write('stderr-heartbeat-' + sequence + '\n');
  }, 5);
`

async function waitForPid(filePath: string): Promise<number> {
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      const pid = Number.parseInt(await readFile(filePath, 'utf8'), 10)
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') {
        throw error
      }
    }
    if (Date.now() >= deadline) throw new Error('child process did not publish its pid')
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 10)
    })
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH') {
      return false
    }
    return true
  }
}

afterEach(async (): Promise<void> => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
  for (const pid of childProcesses) {
    if (pid !== process.pid && processIsAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The child may exit between the liveness check and cleanup.
      }
    }
    childProcesses.delete(pid)
  }
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('M09 resource and process boundaries', (): void => {
  it('samples the current host filesystem without network access', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-resource-probe-${randomUUID()}`)
    directories.add(directory)

    const sample = await new NodeResourceProbe(directory).sample()

    expect(Number.isFinite(sample.diskFreeGb)).toBe(true)
    expect(sample.diskFreeGb).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(sample.load1)).toBe(true)
    expect(sample.load1).toBeGreaterThanOrEqual(0)
  })

  it('maps a synchronous spawn failure to the stable unavailable error', async (): Promise<void> => {
    const throwingSpawner = ((): never => {
      throw new Error('synchronous spawn failure')
    }) as Spawn

    await expect(
      new NodeProcessRunner(throwingSpawner).run('missing-command', [], { timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'Unable to start missing-command',
      retriable: true,
    })
  })

  it('maps an asynchronous pre-spawn child error and clears its lifecycle resources', async (): Promise<void> => {
    vi.useFakeTimers()
    const child = new FakeChild({ pid: undefined })
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = new NodeProcessRunner(fakeSpawner(child))
      .run('async-missing-command', [], { timeoutMs: 100, signal: controller.signal })
      .catch((error: unknown) => error)
    setTimeout((): void => {
      child.emit('error', new Error('asynchronous spawn failure'))
    }, 1)

    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome

    expect(error).toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'Unable to start async-missing-command',
      retriable: true,
    })
    expect(child.kills).toEqual([])
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(removeAbortListener).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles after TERM and KILL bounds even when a child never closes', async (): Promise<void> => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = new NodeProcessRunner(fakeSpawner(child))
      .run('stalled-command', [], { timeoutMs: 100, signal: controller.signal })
      .then(
        (result) => ({ result }) as const,
        (error: unknown) => ({ error }) as const,
      )

    await vi.advanceTimersByTimeAsync(100)
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(1_000)
    const completed = await outcome

    expect(completed).toHaveProperty('error')
    const error = 'error' in completed ? completed.error : undefined
    expect(error).toBeInstanceOf(LubanError)
    expect(error).toMatchObject({ code: 'E_TIMEOUT' })
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unreferenced).toBe(true)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(removeAbortListener).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { first: 'cancelled' as const, code: 'E_UNAVAILABLE', message: 'was cancelled' },
    { first: 'timed-out' as const, code: 'E_TIMEOUT', message: 'timed out' },
  ])('keeps $first as the first termination reason', async ({ first, code, message }) => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = new NodeProcessRunner(fakeSpawner(child))
      .run('racing-command', [], { timeoutMs: 100, signal: controller.signal })
      .catch((error: unknown) => error)

    if (first === 'cancelled') {
      await vi.advanceTimersByTimeAsync(50)
      controller.abort()
      await vi.advanceTimersByTimeAsync(50)
    } else {
      await vi.advanceTimersByTimeAsync(100)
      controller.abort()
    }
    child.emit('close', null, 'SIGTERM')
    const error = await outcome

    expect(error).toMatchObject({ code })
    expect(error).toHaveProperty('message', expect.stringContaining(message))
    expect(child.kills).toEqual(['SIGTERM'])
    expect(removeAbortListener).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for a timed-out child to close and drains its bounded output', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-process-timeout-${randomUUID()}`)
    const pidFile = join(directory, 'child.pid')
    directories.add(directory)
    await mkdir(directory, { recursive: true })
    const runner = new NodeProcessRunner()
    const outcome = runner
      .run(process.execPath, ['-e', LONG_RUNNING_NODE_SCRIPT, pidFile], {
        timeoutMs: 500,
        maxOutputBytes: 4_096,
      })
      .then(
        (result) => ({ result }) as const,
        (error: unknown) => ({ error }) as const,
      )
    const pid = await waitForPid(pidFile)
    childProcesses.add(pid)

    const completed = await outcome

    expect(completed).toHaveProperty('error')
    const error = 'error' in completed ? completed.error : undefined
    expect(error).toBeInstanceOf(LubanError)
    expect(error).toMatchObject({ code: 'E_TIMEOUT', retriable: true })
    const details = error instanceof LubanError ? error.details : undefined
    expect(details?.stdout).toContain('stdout-heartbeat-')
    expect(details?.stderr).toContain('stderr-heartbeat-')
    expect(Buffer.byteLength(String(details?.stdout))).toBeLessThanOrEqual(4_096)
    expect(Buffer.byteLength(String(details?.stderr))).toBeLessThanOrEqual(4_096)
    expect(processIsAlive(pid)).toBe(false)
    childProcesses.delete(pid)
  })

  it('cancels a real Node child, drains its output, and leaves no process behind', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-process-cancel-${randomUUID()}`)
    const pidFile = join(directory, 'child.pid')
    directories.add(directory)
    await mkdir(directory, { recursive: true })
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = new NodeProcessRunner()
      .run(process.execPath, ['-e', LONG_RUNNING_NODE_SCRIPT, pidFile], {
        timeoutMs: 10_000,
        signal: controller.signal,
        maxOutputBytes: 4_096,
      })
      .then(
        (result) => ({ result }) as const,
        (error: unknown) => ({ error }) as const,
      )
    const pid = await waitForPid(pidFile)
    childProcesses.add(pid)

    controller.abort()
    const completed = await outcome

    expect(completed).toHaveProperty('error')
    const error = 'error' in completed ? completed.error : undefined
    expect(error).toBeInstanceOf(LubanError)
    expect(error).toMatchObject({
      code: 'E_UNAVAILABLE',
      message: `${process.execPath} was cancelled`,
      retriable: true,
    })
    const details = error instanceof LubanError ? error.details : undefined
    expect(details?.stdout).toContain('stdout-started')
    expect(details?.stderr).toContain('stderr-started')
    expect(Buffer.byteLength(String(details?.stdout))).toBeLessThanOrEqual(4_096)
    expect(Buffer.byteLength(String(details?.stderr))).toBeLessThanOrEqual(4_096)
    expect(processIsAlive(pid)).toBe(false)
    expect(removeAbortListener).toHaveBeenCalledOnce()
    childProcesses.delete(pid)
  })

  it('writes a durable failed worker result only after its timed-out child exits', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-worker-timeout-${randomUUID()}`)
    const pidFile = join(directory, 'child.pid')
    const resultFile = join(directory, 'result.json')
    const specFile = join(directory, 'worker.json')
    directories.add(directory)
    await mkdir(directory, { recursive: true })
    await writeFile(
      specFile,
      JSON.stringify({
        schemaVersion: 1,
        command: process.execPath,
        args: ['-e', LONG_RUNNING_NODE_SCRIPT, pidFile],
        cwd: directory,
        timeoutMs: 500,
        artifactDirectory: join(directory, 'artifacts'),
        collect: [],
        resultFile,
      }),
      'utf8',
    )
    const outcome = runWorker(specFile)
    const pid = await waitForPid(pidFile)
    childProcesses.add(pid)

    const result = await outcome

    expect(result).toMatchObject({ schemaVersion: 1, exitCode: 1 })
    expect(result.stderr).toContain('timed out')
    expect(JSON.parse(await readFile(resultFile, 'utf8'))).toEqual(result)
    expect(processIsAlive(pid)).toBe(false)
    childProcesses.delete(pid)
  })
})
