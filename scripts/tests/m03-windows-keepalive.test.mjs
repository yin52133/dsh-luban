import { access, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { runM03WindowsKeepaliveAcceptance } from '../acceptance/m03-windows-keepalive.mjs'

const directories = new Set()

function temporaryEvidence() {
  const directory = join(tmpdir(), `m03-windows-acceptance-${randomUUID()}`)
  directories.add(directory)
  return join(directory, 'evidence.json')
}

function fakeOperator() {
  const calls = []
  let installed = false
  let running = false
  let failStatusAt = null
  let statusCalls = 0
  return {
    calls,
    setRunning(value) {
      running = value
    },
    setFailStatusAt(value) {
      failStatusAt = value
    },
    isInstalled() {
      return installed
    },
    async execute(command, apply) {
      calls.push({ command, apply })
      if (command === 'install') {
        if (apply !== true) throw new Error('install must be explicit')
        installed = true
        return { ok: true }
      }
      if (command === 'uninstall') {
        if (apply !== true) throw new Error('uninstall must be explicit')
        installed = false
        running = false
        return { ok: true }
      }
      if (command !== 'status' || apply !== false) throw new Error('unexpected operator call')
      statusCalls += 1
      if (statusCalls === failStatusAt) throw new Error('secret-status-diagnostic')
      return {
        ok: true,
        status: {
          taskName: '\\dsh-luban-host',
          user: 'builder',
          state: installed ? 'exact' : 'missing',
          running: installed ? running : null,
        },
      }
    },
  }
}

function parsed(output) {
  return JSON.parse(output)
}

afterEach(async () => {
  await Promise.all(
    [...directories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('M03 Windows staged keepalive acceptance', () => {
  it('defaults to a no-write plan and keeps mutating stages behind --apply', async () => {
    const evidence = temporaryEvidence()
    const operator = fakeOperator()
    const dependencies = {
      platform: 'win32',
      executeOperator: operator.execute,
      now: () => 1_000_000,
      uptime: () => 500,
    }

    const planned = await runM03WindowsKeepaliveAcceptance(['--output', evidence], dependencies)
    expect(planned.exitCode).toBe(0)
    expect(parsed(planned.output)).toMatchObject({
      ok: true,
      mode: 'plan',
      scope: 'M03-F003/windows-boot-launcher',
      acceptancePassed: false,
      stages: [
        { stage: 'prepare', requiresApply: true },
        { stage: 'human-reboot', automated: false },
        { stage: 'verify', readOnly: true },
        { stage: 'cleanup', requiresApply: true },
      ],
      rebootOrSignOutCommandExecuted: false,
    })
    const preparePreview = await runM03WindowsKeepaliveAcceptance(
      ['prepare', '--output', evidence],
      dependencies,
    )
    const cleanupPreview = await runM03WindowsKeepaliveAcceptance(
      ['cleanup', '--output', evidence],
      dependencies,
    )
    expect(parsed(preparePreview.output)).toMatchObject({ mode: 'plan' })
    expect(parsed(cleanupPreview.output)).toMatchObject({ mode: 'plan' })
    expect(operator.calls).toHaveLength(0)
    await expect(access(evidence)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('prepares once, records the boot boundary, and never performs reboot or sign-out', async () => {
    const evidence = temporaryEvidence()
    const operator = fakeOperator()
    const dependencies = {
      platform: 'win32',
      executeOperator: operator.execute,
      now: () => 1_000_000,
      uptime: () => 500,
    }

    const prepared = await runM03WindowsKeepaliveAcceptance(
      ['prepare', '--apply', '--output', evidence],
      dependencies,
    )
    expect(prepared.exitCode).toBe(0)
    expect(parsed(prepared.output)).toMatchObject({
      stage: 'prepared',
      next: 'restart-windows-manually-then-verify',
      rebootOrSignOutCommandExecuted: false,
    })
    expect(operator.calls).toEqual([
      { command: 'status', apply: false },
      { command: 'install', apply: true },
      { command: 'status', apply: false },
    ])
    expect(JSON.parse(await readFile(evidence, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      scope: 'M03-F003/windows-boot-launcher',
      coveredFeatures: ['M03-F002', 'M03-F003'],
      evidenceKind: 'simulated',
      stage: 'prepared',
      preparedBootStartedAt: 500_000,
      rebootObserved: false,
      cleanup: 'pending',
      acceptancePassed: false,
      featureResults: {
        'M03-F002': { passed: false },
        'M03-F003': { passed: false },
      },
      host: { state: 'exact', running: false },
    })
    expect(operator.calls.some(({ command }) => /shutdown|restart|logoff/iu.test(command))).toBe(
      false,
    )

    const repeated = await runM03WindowsKeepaliveAcceptance(
      ['prepare', '--apply', '--output', evidence],
      dependencies,
    )
    expect(parsed(repeated.output)).toMatchObject({ stage: 'prepared', resumed: true })
    expect(operator.calls).toHaveLength(3)

    const mismatchedExecution = await runM03WindowsKeepaliveAcceptance(
      ['verify', '--output', evidence],
      { platform: 'win32', now: () => 2_000_000, uptime: () => 10 },
    )
    expect(mismatchedExecution.exitCode).toBe(1)
    expect(parsed(mismatchedExecution.output)).toMatchObject({
      error: { code: 'E_ACCEPTANCE_REQUIRED' },
    })
  })

  it('fails verification on the same boot, then passes after a simulated human reboot', async () => {
    const evidence = temporaryEvidence()
    const operator = fakeOperator()
    let now = 1_000_000
    let hostUptime = 500
    const dependencies = {
      platform: 'win32',
      executeOperator: operator.execute,
      now: () => now,
      uptime: () => hostUptime,
    }
    await runM03WindowsKeepaliveAcceptance(
      ['prepare', '--apply', '--output', evidence],
      dependencies,
    )

    operator.setRunning(true)
    now = 1_010_000
    hostUptime = 510
    const sameBoot = await runM03WindowsKeepaliveAcceptance(
      ['verify', '--output', evidence],
      dependencies,
    )
    expect(sameBoot.exitCode).toBe(1)
    expect(parsed(sameBoot.output)).toMatchObject({ error: { code: 'E_ACCEPTANCE_REQUIRED' } })
    expect(JSON.parse(await readFile(evidence, 'utf8'))).toMatchObject({ stage: 'prepared' })

    now = 2_000_000
    hostUptime = 10
    const verified = await runM03WindowsKeepaliveAcceptance(
      ['verify', '--output', evidence],
      dependencies,
    )
    expect(verified.exitCode).toBe(0)
    expect(parsed(verified.output)).toMatchObject({ stage: 'verified', next: 'cleanup --apply' })
    expect(JSON.parse(await readFile(evidence, 'utf8'))).toMatchObject({
      stage: 'verified',
      rebootObserved: true,
      verifiedBootStartedAt: 1_990_000,
      host: { state: 'exact', running: true },
    })
  })

  it('cleans up only with --apply and preserves final evidence idempotently', async () => {
    const evidence = temporaryEvidence()
    const operator = fakeOperator()
    let now = 1_000_000
    let hostUptime = 500
    const dependencies = {
      platform: 'win32',
      executeOperator: operator.execute,
      now: () => now,
      uptime: () => hostUptime,
    }
    await runM03WindowsKeepaliveAcceptance(
      ['prepare', '--apply', '--output', evidence],
      dependencies,
    )
    operator.setRunning(true)
    now = 2_000_000
    hostUptime = 10
    await runM03WindowsKeepaliveAcceptance(['verify', '--output', evidence], dependencies)

    const before = operator.calls.length
    const preview = await runM03WindowsKeepaliveAcceptance(
      ['cleanup', '--output', evidence],
      dependencies,
    )
    expect(parsed(preview.output)).toMatchObject({ mode: 'plan' })
    expect(operator.calls).toHaveLength(before)

    const cleaned = await runM03WindowsKeepaliveAcceptance(
      ['cleanup', '--apply', '--output', evidence],
      dependencies,
    )
    expect(cleaned.exitCode).toBe(0)
    expect(parsed(cleaned.output)).toMatchObject({ stage: 'cleaned' })
    expect(operator.isInstalled()).toBe(false)
    expect(JSON.parse(await readFile(evidence, 'utf8'))).toMatchObject({
      stage: 'cleaned',
      cleanup: 'pass',
      rebootObserved: true,
      host: { state: 'missing', running: null },
    })

    const calls = operator.calls.length
    const repeated = await runM03WindowsKeepaliveAcceptance(
      ['cleanup', '--apply', '--output', evidence],
      dependencies,
    )
    expect(parsed(repeated.output)).toMatchObject({ stage: 'cleaned', resumed: true })
    expect(operator.calls).toHaveLength(calls)
  })

  it('redacts operator failures and rejects verify without prepared evidence', async () => {
    const evidence = temporaryEvidence()
    const operator = fakeOperator()
    operator.setFailStatusAt(2)
    const dependencies = {
      platform: 'win32',
      executeOperator: operator.execute,
      now: () => 1_000_000,
      uptime: () => 500,
    }

    const failed = await runM03WindowsKeepaliveAcceptance(
      ['prepare', '--apply', '--output', evidence],
      dependencies,
    )
    expect(failed.exitCode).toBe(1)
    expect(failed.output).not.toContain('secret-status-diagnostic')
    expect(operator.isInstalled()).toBe(false)
    expect(operator.calls).toEqual([
      { command: 'status', apply: false },
      { command: 'install', apply: true },
      { command: 'status', apply: false },
      { command: 'uninstall', apply: true },
    ])
    const missing = await runM03WindowsKeepaliveAcceptance(
      ['verify', '--output', temporaryEvidence()],
      dependencies,
    )
    expect(missing.exitCode).toBe(1)
    expect(parsed(missing.output)).toMatchObject({ error: { code: 'E_ACCEPTANCE_REQUIRED' } })
  })
})
