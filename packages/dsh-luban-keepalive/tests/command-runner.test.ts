import { describe, expect, it } from 'vitest'
import { NodeCommandRunner } from '../src/command-runner.js'

describe('NodeCommandRunner', (): void => {
  it('runs an argv-only child and retains bounded output tails', async (): Promise<void> => {
    const result = await new NodeCommandRunner().run(
      process.execPath,
      ['-e', "process.stdout.write('abcdefgh'); process.stderr.write('12345678')"],
      { timeoutMs: 2_000, maxOutputBytes: 4 },
    )

    expect(result).toMatchObject({ exitCode: 0, stdout: 'efgh', stderr: '5678' })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('maps timeout, pre-abort, and spawn failure to stable bounded errors', async (): Promise<void> => {
    const runner = new NodeCommandRunner()
    await expect(
      runner.run(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: 'E_TIMEOUT', retriable: true })

    const controller = new AbortController()
    controller.abort()
    await expect(
      runner.run(process.execPath, ['--version'], { timeoutMs: 1_000, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })

    await expect(
      runner.run('dsh-luban-command-that-does-not-exist', [], { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })
  })
})
