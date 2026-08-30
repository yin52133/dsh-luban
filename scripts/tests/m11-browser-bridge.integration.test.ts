import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const BRIDGE_PROJECT = resolve('tools/browser-bridge')
const UV_ARGUMENTS = [
  'run',
  '--locked',
  '--no-dev',
  '--python',
  '3.12',
  '--project',
  BRIDGE_PROJECT,
  'python',
  '-m',
  'luban_browser_bridge',
] as const

describe('M11 Python browser bridge process integration', (): void => {
  it('answers ping and exits after shutdown through the locked uv environment', async (): Promise<void> => {
    const environment = bridgeTestEnvironment(process.env)
    const child = spawn('uv', UV_ARGUMENTS, {
      cwd: resolve('.'),
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const client = new JsonlBridgeClient(child)

    try {
      expect(Object.keys(environment)).not.toEqual(
        expect.arrayContaining([
          'ANTHROPIC_API_KEY',
          'BROWSER_USE_API_KEY',
          'GOOGLE_API_KEY',
          'OPENAI_API_KEY',
        ]),
      )
      await expect(client.request('ping')).resolves.toEqual({
        bridgeVersion: '0.1.0',
        browserUseVersion: '0.13.8',
        python: '3.12',
      })
      await expect(client.request('shutdown')).resolves.toEqual({ stopped: true })
      await expect(client.closed()).resolves.toEqual({ code: 0, signal: null })
    } finally {
      await client.dispose()
    }
  })
})

interface ProcessClose {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface PendingResponse {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

class JsonlBridgeClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #lines
  readonly #pending = new Map<string, PendingResponse>()
  readonly #close: Promise<ProcessClose>
  readonly #stderr: string[] = []
  #sequence = 0

  public constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.#lines.on('line', (line): void => this.#handleLine(line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string): void => {
      this.#stderr.push(chunk)
    })
    this.#close = new Promise<ProcessClose>((resolveClose, rejectClose): void => {
      child.once('error', rejectClose)
      child.once('close', (code, signal): void => {
        resolveClose({ code, signal })
        const error = new Error(this.#failureMessage('Browser bridge closed before responding'))
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.#pending.clear()
      })
    })
  }

  public request(method: 'ping' | 'shutdown'): Promise<unknown> {
    this.#sequence += 1
    const id = `integration-${String(this.#sequence)}`
    return new Promise<unknown>((resolveResponse, rejectResponse): void => {
      const timer = setTimeout((): void => {
        this.#pending.delete(id)
        rejectResponse(new Error(this.#failureMessage(`Timed out waiting for ${method}`)))
      }, 10_000)
      this.#pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer })
      this.#child.stdin.write(
        `${JSON.stringify({ v: 1, id, kind: 'request', method, params: {} })}\n`,
        'utf8',
        (error): void => {
          if (error === null || error === undefined) return
          const pending = this.#pending.get(id)
          if (pending === undefined) return
          clearTimeout(pending.timer)
          this.#pending.delete(id)
          pending.reject(error)
        },
      )
    })
  }

  public async closed(): Promise<ProcessClose> {
    return await within(this.#close, 10_000, () => this.#failureMessage('Bridge did not exit'))
  }

  public async dispose(): Promise<void> {
    this.#lines.close()
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill()
    try {
      await within(this.#close, 5_000, () => this.#failureMessage('Bridge cleanup timed out'))
    } catch {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill('SIGKILL')
      }
    }
    this.#child.stdin.destroy()
    this.#child.stdout.destroy()
    this.#child.stderr.destroy()
  }

  #handleLine(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line) as unknown
    } catch {
      throw new Error(this.#failureMessage('Bridge emitted invalid JSON'))
    }
    if (!isRecord(frame) || typeof frame.id !== 'string' || frame.kind !== 'response') return
    const pending = this.#pending.get(frame.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.#pending.delete(frame.id)
    if (frame.ok === true) pending.resolve(frame.result)
    else pending.reject(new Error(this.#failureMessage(`Bridge rejected ${frame.id}`)))
  }

  #failureMessage(message: string): string {
    const stderr = this.#stderr.join('').trim()
    return stderr === '' ? message : `${message}: ${stderr}`
  }
}

function bridgeTestEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'APPDATA',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'PATH',
    'Path',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
    'XDG_CACHE_HOME',
  ] as const
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv
  for (const name of allowed) {
    if (source[name] !== undefined) environment[name] = source[name]
  }
  environment.PYTHONUNBUFFERED = '1'
  environment.PYTHONUTF8 = '1'
  return environment
}

async function within<Value>(
  operation: Promise<Value>,
  milliseconds: number,
  message: () => string,
): Promise<Value> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => reject(new Error(message())), milliseconds)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
