import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeManagedProcessRunner, type ManagedProcessFactory } from '../src/command-runner.js'
import type { ManagedProcessOptions } from '../src/types.js'

class FakeManagedChild extends EventEmitter {
  public readonly stdin = new PassThrough()
  public readonly stdout = new PassThrough()
  public readonly stderr = new PassThrough()
  public readonly pid: number | undefined
  public exitCode: number | null = null
  public signalCode: NodeJS.Signals | null = null
  public readonly kills: NodeJS.Signals[] = []
  public unreferenced = false
  public throwOnKill = false
  public closeAfterKill: Readonly<{ signal: NodeJS.Signals; delayMs: number }> | undefined
  public errorAfterKill: Readonly<{ signal: NodeJS.Signals; delayMs: number }> | undefined

  public constructor(options: { readonly pid?: number } = { pid: 42_424 }) {
    super()
    this.pid = options.pid
  }

  public kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    if (this.errorAfterKill?.signal === signal) {
      setTimeout((): void => {
        this.emit('error', new Error('asynchronous kill failure'))
      }, this.errorAfterKill.delayMs)
    }
    if (this.throwOnKill) throw new Error('kill failed')
    if (this.closeAfterKill?.signal === signal) {
      setTimeout((): void => this.close(null, signal), this.closeAfterKill.delayMs)
    }
    return true
  }

  public close(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = exitCode
    this.signalCode = signal
    this.emit('close', exitCode, signal)
  }

  public unref(): void {
    this.unreferenced = true
  }
}

function factory(child: FakeManagedChild): ManagedProcessFactory {
  return (): ChildProcessWithoutNullStreams => child as unknown as ChildProcessWithoutNullStreams
}

function options(signal?: AbortSignal): ManagedProcessOptions {
  return {
    timeoutMs: 10_000,
    startupTimeoutMs: 10,
    maxOutputBytes: 1024,
    ...(signal === undefined ? {} : { signal }),
  }
}

function expectDetached(child: FakeManagedChild, retainedErrorSink = false): void {
  expect(child.listenerCount('spawn')).toBe(0)
  expect(child.listenerCount('error')).toBe(retainedErrorSink ? 1 : 0)
  expect(child.listenerCount('close')).toBe(0)
  expect(child.stdout.listenerCount('data')).toBe(0)
  expect(child.stderr.listenerCount('data')).toBe(0)
}

afterEach((): void => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

describe('M10 managed process lifecycle', (): void => {
  it('maps a synchronous process factory failure without retaining lifecycle state', async (): Promise<void> => {
    const throwingFactory = ((): never => {
      throw new Error('synchronous spawn failure')
    }) as ManagedProcessFactory

    await expect(
      new NodeManagedProcessRunner(throwingFactory, 5).start('missing-tool', [], options()),
    ).rejects.toMatchObject({
      code: 'E_CHANNEL_UNAVAILABLE',
      message: 'Unable to start missing-tool',
      retriable: true,
    })
  })

  it('cleans a pre-spawn asynchronous error without starting a termination timer', async (): Promise<void> => {
    vi.useFakeTimers()
    const child = new FakeManagedChild({})
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = new NodeManagedProcessRunner(factory(child), 5)
      .start('missing-tool', [], options(controller.signal))
      .catch((error: unknown) => error)

    child.emit('error', new Error('asynchronous spawn failure'))
    const error = await outcome

    expect(error).toMatchObject({
      code: 'E_CHANNEL_UNAVAILABLE',
      message: 'Unable to start missing-tool',
      retriable: true,
    })
    expect(child.kills).toEqual([])
    expect(child.stdin.destroyed).toBe(true)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unreferenced).toBe(true)
    expectDetached(child)
    expect(removeAbortListener).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for startup-timeout termination to close before rejecting', async (): Promise<void> => {
    vi.useFakeTimers()
    const child = new FakeManagedChild()
    child.closeAfterKill = { signal: 'SIGKILL', delayMs: 1 }
    child.errorAfterKill = { signal: 'SIGTERM', delayMs: 1 }
    let settled = false
    const outcome = new NodeManagedProcessRunner(factory(child), 5)
      .start('slow-tool', [], { ...options(), startupTimeoutMs: 2 })
      .catch((error: unknown) => error)
      .finally((): void => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(2)
    expect(child.kills).toEqual(['SIGTERM'])
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(5)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome

    expect(error).toMatchObject({ code: 'E_TIMEOUT', message: 'slow-tool startup timed out' })
    expect(child.unreferenced).toBe(true)
    expectDetached(child)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds startup cancellation even when every kill call throws', async (): Promise<void> => {
    vi.useFakeTimers()
    const child = new FakeManagedChild()
    child.throwOnKill = true
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const outcome = new NodeManagedProcessRunner(factory(child), 5)
      .start('stuck-tool', [], options(controller.signal))
      .catch((error: unknown) => error)

    setTimeout((): void => {
      child.emit('error', new Error('late asynchronous kill error'))
    }, 1)
    controller.abort()
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(5)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(5)
    const error = await outcome

    expect(error).toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'stuck-tool startup was cancelled',
      retriable: true,
    })
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
    expect(child.stdin.destroyed).toBe(true)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unreferenced).toBe(true)
    expectDetached(child, true)
    expect((): boolean =>
      child.emit('error', new Error('post-settlement kill error')),
    ).not.toThrow()
    expect(removeAbortListener).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles managed stop after TERM, KILL and a final bounded release', async (): Promise<void> => {
    vi.useFakeTimers()
    const child = new FakeManagedChild()
    child.errorAfterKill = { signal: 'SIGTERM', delayMs: 1 }
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const starting = new NodeManagedProcessRunner(factory(child), 5).start(
      'stuck-server',
      [],
      options(controller.signal),
    )
    child.emit('spawn')
    const managed = await starting
    const outcome = managed.stop().catch((error: unknown) => error)

    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(5)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(5)
    const error = await outcome

    expect(error).toMatchObject({
      code: 'E_TIMEOUT',
      message: 'Managed process did not close after forced termination',
      retriable: true,
    })
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL'])
    expect(child.stdin.destroyed).toBe(true)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unreferenced).toBe(true)
    expectDetached(child, true)
    expect((): boolean =>
      child.emit('error', new Error('post-settlement kill error')),
    ).not.toThrow()
    expect(removeAbortListener).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes managed listeners after a normal graceful close', async (): Promise<void> => {
    vi.useFakeTimers()
    const child = new FakeManagedChild()
    child.closeAfterKill = { signal: 'SIGTERM', delayMs: 1 }
    const controller = new AbortController()
    const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener')
    const starting = new NodeManagedProcessRunner(factory(child), 5).start(
      'normal-server',
      [],
      options(controller.signal),
    )
    child.emit('spawn')
    const managed = await starting
    const outcome = managed.stop()

    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toMatchObject({ exitCode: -1 })
    expect(child.kills).toEqual(['SIGTERM'])
    expectDetached(child)
    expect(removeAbortListener).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
