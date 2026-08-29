import { spawn } from 'node:child_process'
import { LubanError, isLubanError } from '@luban/core'
import { detectImage } from './image-format.js'
import type { ClipboardAdapter, ClipboardCapture } from './types.js'

export interface CommandSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: string
}

export interface BinaryCommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Readonly<{ code?: unknown }>).code
  return typeof value === 'string' ? value : undefined
}

/** Execute one fixed binary with no shell, bounded time, and bounded captured output. */
export class NodeBinaryCommandRunner implements BinaryCommandRunner {
  public run(spec: CommandSpec): Promise<CommandResult> {
    return new Promise((resolve, reject): void => {
      const child = spawn(spec.file, [...spec.args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false

      const settleError = (error: LubanError): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        child.kill()
        reject(error)
      }
      const timeout = setTimeout((): void => {
        settleError(
          new LubanError('E_TIMEOUT', `Clipboard command ${spec.file} timed out`, {
            retriable: true,
          }),
        )
      }, spec.timeoutMs)
      timeout.unref()

      child.stdout.on('data', (raw: Buffer): void => {
        if (settled) return
        const chunk = Buffer.from(raw)
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > spec.maxOutputBytes) {
          settleError(new LubanError('E_INVALID_INPUT', 'Clipboard image exceeds maxBytes'))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (raw: Buffer): void => {
        if (settled || stderrBytes >= 64 * 1024) return
        const remaining = 64 * 1024 - stderrBytes
        const chunk = Buffer.from(raw).subarray(0, remaining)
        stderrBytes += chunk.byteLength
        stderr.push(chunk)
      })
      child.once('error', (error: Error): void => {
        settleError(
          new LubanError('E_UNAVAILABLE', `Clipboard command ${spec.file} could not start`, {
            retriable: true,
            cause: error,
            details: { spawnCode: errorCode(error) ?? 'unknown' },
          }),
        )
      })
      child.once('close', (code): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve({
          exitCode: code ?? -1,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: Buffer.concat(stderr).toString('utf8').trim(),
        })
      })
    })
  }
}

const WINDOWS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$image = [System.Windows.Forms.Clipboard]::GetImage();',
  'if ($null -eq $image) { exit 3 };',
  '$stream = New-Object System.IO.MemoryStream;',
  'try {',
  '  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png);',
  '  $bytes = $stream.ToArray();',
  '  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length);',
  '} finally { $stream.Dispose(); $image.Dispose() }',
].join(' ')

const LINUX_COMMANDS: readonly { readonly file: string; readonly args: readonly string[] }[] = [
  { file: 'wl-paste', args: ['--no-newline', '--type', 'image/png'] },
  { file: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] },
]

export interface SystemClipboardOptions {
  readonly platform?: NodeJS.Platform
  readonly runner?: BinaryCommandRunner
  readonly timeoutMs: number
  readonly maxBytes: number
}

function noImage(detail: string): LubanError {
  return new LubanError('E_INVALID_INPUT', `Clipboard does not contain a readable image${detail}`)
}

/** Platform HAL for PNG clipboard capture using only fixed, argument-array commands. */
export class SystemClipboardAdapter implements ClipboardAdapter {
  readonly #platform: NodeJS.Platform
  readonly #runner: BinaryCommandRunner
  readonly #timeoutMs: number
  readonly #maxBytes: number

  public constructor(options: SystemClipboardOptions) {
    this.#platform = options.platform ?? process.platform
    this.#runner = options.runner ?? new NodeBinaryCommandRunner()
    this.#timeoutMs = options.timeoutMs
    this.#maxBytes = options.maxBytes
  }

  public async capture(): Promise<ClipboardCapture> {
    const result =
      this.#platform === 'win32'
        ? await this.#captureWindows()
        : this.#platform === 'linux'
          ? await this.#captureLinux()
          : undefined
    if (result === undefined) {
      throw new LubanError(
        'E_PLATFORM_UNSUPPORTED',
        `Clipboard capture is unsupported on ${this.#platform}`,
      )
    }
    if (result.exitCode !== 0 || result.stdout.byteLength === 0) {
      const suffix = result.stderr === '' ? '' : `: ${result.stderr.slice(0, 500)}`
      throw noImage(suffix)
    }
    if (result.stdout.byteLength > this.#maxBytes) {
      throw new LubanError('E_INVALID_INPUT', 'Clipboard image exceeds maxBytes')
    }
    const detected = detectImage(result.stdout)
    return {
      bytes: result.stdout,
      mime: detected.mime,
      nameHint: 'clipboard',
    }
  }

  #captureWindows(): Promise<CommandResult> {
    return this.#runner.run({
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', WINDOWS_SCRIPT],
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: this.#maxBytes,
    })
  }

  async #captureLinux(): Promise<CommandResult> {
    for (const command of LINUX_COMMANDS) {
      try {
        const result = await this.#runner.run({
          ...command,
          timeoutMs: this.#timeoutMs,
          maxOutputBytes: this.#maxBytes,
        })
        if (result.exitCode === 0 && result.stdout.byteLength > 0) return result
        if (result.exitCode !== 1) return result
      } catch (error: unknown) {
        if (
          !isLubanError(error) ||
          error.code !== 'E_UNAVAILABLE' ||
          error.details?.spawnCode !== 'ENOENT'
        ) {
          throw error
        }
      }
    }
    throw new LubanError(
      'E_UNAVAILABLE',
      'Install wl-clipboard (Wayland) or xclip (X11) for CLI clipboard capture',
    )
  }
}
