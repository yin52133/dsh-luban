import type { Context } from '@deepseek-ai/cordis'
import { LubanError } from '@luban/core'
import { describe, expect, it } from 'vitest'
import {
  SystemClipboardAdapter,
  type BinaryCommandRunner,
  type CommandResult,
  type CommandSpec,
} from '../src/clipboard.js'
import { parseConfig } from '../src/config.js'
import { assertMimeMatches, detectImage } from '../src/image-format.js'
import { apply, assertLoopbackWebServer } from '../src/index.js'
import { PNG_BYTES } from './helpers.js'

class RecordingRunner implements BinaryCommandRunner {
  public readonly calls: CommandSpec[] = []

  public constructor(private readonly results: readonly (CommandResult | Error)[]) {}

  public run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec)
    const result = this.results[this.calls.length - 1]
    if (result === undefined) return Promise.reject(new Error('unexpected command'))
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
}

describe('configuration and image detection', () => {
  it('resolves a safe workspace child and strict operational bounds', () => {
    const config = parseConfig({
      workspaceRoot: '.',
      attachDir: 'assets/images',
      maxBytes: 2_048,
      maxSidePx: 512,
      compression: true,
      compressionQuality: 75,
      retainDays: 30,
      recentLimit: 25,
      cleanupIntervalMinutes: 5,
      injectStyle: 'path',
      clipboardTimeoutMs: 2_000,
    })
    expect(config.attachDir).toBe('assets/images')
    expect(config.injectStyle).toBe('path')
    expect(config.maxBytes).toBe(2_048)
    expect(config.recentLimit).toBe(25)
  })

  it.each(['.', '..', '../outside', '/absolute'])('rejects unsafe attachDir %s', (attachDir) => {
    expect(() => parseConfig({ attachDir })).toThrow(/attachDir/u)
  })

  it('requires the internal DSH WebServer to use the loopback boundary', () => {
    expect(() => assertLoopbackWebServer('127.0.0.1')).not.toThrow()
    expect(() => assertLoopbackWebServer('0.0.0.0')).toThrow(/127\.0\.0\.1/u)
    expect(() => assertLoopbackWebServer('::1')).toThrow(/127\.0\.0\.1/u)
  })

  it('rejects non-loopback startup before creating the attachment service', async () => {
    const context = {
      get: () => ({}),
      webServer: { host: '0.0.0.0' },
    } as unknown as Context
    await expect(
      apply(context, { workspaceRoot: process.cwd(), compression: false }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
  })

  it.each([0, 501])('rejects unsafe recentLimit %s', (recentLimit) => {
    expect(() => parseConfig({ recentLimit })).toThrow(/recentLimit/u)
  })

  it('detects supported signatures and rejects MIME confusion', () => {
    expect(detectImage(PNG_BYTES)).toEqual({ mime: 'image/png', extension: 'png' })
    expect(detectImage(Uint8Array.of(0xff, 0xd8, 0xff))).toEqual({
      mime: 'image/jpeg',
      extension: 'jpg',
    })
    expect(detectImage(Uint8Array.from(Buffer.from('RIFF0000WEBP', 'ascii')))).toEqual({
      mime: 'image/webp',
      extension: 'webp',
    })
    expect(() => assertMimeMatches(PNG_BYTES, 'image/jpeg')).toThrow(/does not match/u)
    expect(() => detectImage(Uint8Array.of(1, 2, 3))).toThrow(/Only PNG/u)
  })
})

describe('system clipboard adapter with fake process runner', () => {
  it('uses one fixed PowerShell invocation on Windows', async () => {
    const runner = new RecordingRunner([{ exitCode: 0, stdout: PNG_BYTES, stderr: '' }])
    const adapter = new SystemClipboardAdapter({
      platform: 'win32',
      runner,
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })
    await expect(adapter.capture()).resolves.toMatchObject({
      mime: 'image/png',
      nameHint: 'clipboard',
    })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.file).toBe('powershell.exe')
    expect(runner.calls[0]?.args).toContain('-Sta')
    expect(runner.calls[0]?.args).toContain('-NoProfile')
  })

  it('falls back from missing wl-paste to fixed xclip arguments', async () => {
    const missing = new LubanError('E_UNAVAILABLE', 'missing', {
      details: { spawnCode: 'ENOENT' },
    })
    const runner = new RecordingRunner([missing, { exitCode: 0, stdout: PNG_BYTES, stderr: '' }])
    const adapter = new SystemClipboardAdapter({
      platform: 'linux',
      runner,
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })
    await expect(adapter.capture()).resolves.toMatchObject({ mime: 'image/png' })
    expect(runner.calls.map((call) => call.file)).toEqual(['wl-paste', 'xclip'])
    expect(runner.calls[1]?.args).toEqual(['-selection', 'clipboard', '-t', 'image/png', '-o'])
  })

  it('fails closed on unsupported platforms without invoking a process', async () => {
    const runner = new RecordingRunner([])
    const adapter = new SystemClipboardAdapter({
      platform: 'darwin',
      runner,
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })
    await expect(adapter.capture()).rejects.toMatchObject({
      code: 'E_PLATFORM_UNSUPPORTED',
    })
    expect(runner.calls).toHaveLength(0)
  })

  it('rejects empty or oversized command output', async () => {
    const empty = new SystemClipboardAdapter({
      platform: 'win32',
      runner: new RecordingRunner([{ exitCode: 3, stdout: new Uint8Array(), stderr: '' }]),
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })
    await expect(empty.capture()).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })

    const oversized = new SystemClipboardAdapter({
      platform: 'win32',
      runner: new RecordingRunner([{ exitCode: 0, stdout: new Uint8Array(1_025), stderr: '' }]),
      timeoutMs: 2_000,
      maxBytes: 1_024,
    })
    await expect(oversized.capture()).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
  })
})
