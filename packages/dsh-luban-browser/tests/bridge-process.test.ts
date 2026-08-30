import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeProcess } from '../src/bridge-process.js'
import { resolveConfig } from '../src/config.js'

const temporaryDirectories = new Set<string>()
const childProcesses = new Set<ChildProcessWithoutNullStreams>()

afterEach(async (): Promise<void> => {
  for (const child of childProcesses) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    childProcesses.delete(child)
  }
  await Promise.all(
    [...temporaryDirectories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      temporaryDirectories.delete(directory)
    }),
  )
})

describe('BridgeProcess', (): void => {
  it('parses fragmented JSONL and waits for the child close after shutdown responds', async (): Promise<void> => {
    const harness = await createHarness({ shutdownWithoutNewline: false, exitDelayMs: 100 })
    const bridge = new BridgeProcess({
      config: harness.config,
      spawnProcess: harness.spawnProcess,
    })

    await expect(bridge.start({ kernel: 'chromium-headless' })).resolves.toMatchObject({
      profile: { kernel: 'chromium-headless' },
    })
    const child = harness.child()
    let closed = false
    const closing = bridge.close().then((): void => {
      closed = true
    })

    await delay(20)
    expect(closed).toBe(false)
    await closing

    expect(child.exitCode).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.stdin.destroyed).toBe(true)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
  })

  it('accepts a final unterminated response before handling child close', async (): Promise<void> => {
    const harness = await createHarness({ shutdownWithoutNewline: true, exitDelayMs: 20 })
    const bridge = new BridgeProcess({
      config: harness.config,
      spawnProcess: harness.spawnProcess,
    })

    await bridge.start({ kernel: 'chromium-headless' })
    await expect(bridge.close()).resolves.toBeUndefined()

    const child = harness.child()
    expect(child.exitCode).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('rejects an invalid resolved profile from the bridge', async (): Promise<void> => {
    const harness = await createHarness({
      shutdownWithoutNewline: false,
      exitDelayMs: 20,
      resolvedProfile: { kernel: 'auto', headless: false, isolated: true },
    })
    const bridge = new BridgeProcess({
      config: harness.config,
      spawnProcess: harness.spawnProcess,
    })

    await expect(bridge.start({ kernel: 'chrome' })).rejects.toMatchObject({
      code: 'E_BROWSER_PROTOCOL',
    })
    await expect(bridge.close()).resolves.toBeUndefined()
  })
})

interface HarnessOptions {
  readonly shutdownWithoutNewline: boolean
  readonly exitDelayMs: number
  readonly resolvedProfile?: unknown
}

async function createHarness(options: HarnessOptions): Promise<{
  readonly config: ReturnType<typeof resolveConfig>['bridge']
  readonly spawnProcess: typeof spawn
  readonly child: () => ChildProcessWithoutNullStreams
}> {
  const directory = await mkdtemp(join(tmpdir(), 'luban-bridge-process-test-'))
  temporaryDirectories.add(directory)
  let activeChild: ChildProcessWithoutNullStreams | undefined
  const script = bridgeFixtureScript(options)
  const spawnProcess = ((): ChildProcessWithoutNullStreams => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    activeChild = child
    childProcesses.add(child)
    return child
  }) as unknown as typeof spawn
  return {
    config: resolveConfig({
      dataDir: directory,
      bridge: { projectDir: directory, environmentDir: join(directory, 'environment') },
    }).bridge,
    spawnProcess,
    child: (): ChildProcessWithoutNullStreams => {
      if (activeChild === undefined) throw new Error('Bridge fixture was not spawned')
      return activeChild
    },
  }
}

function bridgeFixtureScript(options: HarnessOptions): string {
  const resolvedProfile = JSON.stringify(
    options.resolvedProfile ?? {
      kernel: 'chromium-headless',
      headless: true,
      isolated: true,
    },
  )
  return String.raw`
    import { createInterface } from 'node:readline'

    const requests = createInterface({ input: process.stdin, crlfDelay: Infinity })
    const response = (request, result) => JSON.stringify({
      v: 1,
      id: request.id,
      kind: 'response',
      ok: true,
      result,
    })

    requests.on('line', (line) => {
      const request = JSON.parse(line)
      if (request.method === 'ping') {
        const unrelated = JSON.stringify({
          v: 1,
          id: 'unrelated-request',
          kind: 'response',
          ok: true,
          result: {},
        })
        const payload = unrelated + '\n' + response(request, {
          bridgeVersion: '0.1.0',
          browserUseVersion: '0.13.8',
          python: '3.12',
        }) + '\n'
        process.stdout.write(payload.slice(0, 17))
        setTimeout(() => process.stdout.write(payload.slice(17)), 2)
        return
      }
      if (request.method === 'start') {
        process.stdout.write(response(request, { profile: ${resolvedProfile} }) + '\n')
        return
      }
      if (request.method === 'shutdown') {
        process.stdout.write(response(request, { shutdown: true })${options.shutdownWithoutNewline ? '' : " + '\\n'"})
        setTimeout(() => process.exit(0), ${String(options.exitDelayMs)})
      }
    })
  `
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds)
  })
}
