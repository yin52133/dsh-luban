import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runM03UbuntuKeepaliveAcceptance,
  tmuxPaneCommandSha256,
} from '../acceptance/m03-ubuntu-keepalive.mjs'

const roots = new Set()
const MACHINE = 'a'.repeat(64)
const GIT_HEAD = 'b'.repeat(40)
const RUNNER_HASH = 'c'.repeat(64)
const BOOT_ONE = '11111111-1111-4111-8111-111111111111'
const BOOT_TWO = '22222222-2222-4222-8222-222222222222'
const STEP_LIST = ['prepare', 'verify-disconnect', 'observe-attach', 'arm-reboot', 'verify-reboot']

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function temporaryRun() {
  const root = join(tmpdir(), `m03-ubuntu-acceptance-${randomUUID()}`)
  roots.add(root)
  await mkdir(root, { mode: 0o700 })
  return {
    root,
    runDir: join(root, 'run'),
    ledger: join(root, 'keepalive.json'),
    witness: join(root, 'disconnect-witness.json'),
  }
}

function parsed(output) {
  return JSON.parse(output)
}

function fakeOperator(clock, options = {}) {
  const calls = []
  let currentStep = 1
  let sequence = 0
  let bootId = BOOT_ONE
  let mainPid = 700
  let startedAt = clock.now() - 1_000
  let sessionCreatedAt = clock.now()
  let preparedPanePid = 701
  let preparedHeartbeatPid = 702
  let attached = true
  let cleaned = false
  let cleanedRunId

  const host = () => ({
    machineIdSha256: MACHINE,
    bootId,
    source: { gitHead: GIT_HEAD, runnerSha256: RUNNER_HASH },
    systemd: {
      unit: 'dsh-luban.service',
      enabled: 'enabled',
      active: 'active',
      mainPid,
      bootRestoreSentinel: true,
    },
    ubuntuVersion: '24.04',
    nodeVersion: 'v22.19.0',
    tmuxVersion: 'tmux 3.4',
    linger: 'yes',
  })

  const fixture = (marker) => {
    sequence += 1
    return {
      tmux: {
        sessionName: marker.sessionId,
        tmuxSessionId: '$7',
        paneId: '%12',
        panePid: bootId === BOOT_ONE ? preparedPanePid : 801,
        commandSha256: marker.commandSha256,
      },
      heartbeat: {
        schemaVersion: 'dsh-luban/m03-ubuntu-heartbeat/v1',
        runId: marker.runId,
        machineIdSha256: MACHINE,
        bootId,
        pid: bootId === BOOT_ONE ? preparedHeartbeatPid : 802,
        sequence,
        startedAt,
        observedAt: clock.now(),
      },
      ledger: {
        sessionId: marker.sessionId,
        ownerTaskId: marker.taskId,
        sessionCreatedAt,
        checkpoint: {
          taskId: marker.taskId,
          stepList: STEP_LIST,
          currentStep,
          savedAt: clock.now(),
        },
      },
    }
  }

  return {
    calls,
    reboot() {
      bootId = BOOT_TWO
      mainPid = 800
      startedAt = clock.now()
      sessionCreatedAt = clock.now()
      sequence = 0
    },
    replacePreparedRuntime() {
      preparedPanePid += 1
      preparedHeartbeatPid += 1
    },
    setAttached(value) {
      attached = value
    },
    operator: {
      async preflight() {
        calls.push('preflight')
        return { ready: options.ready !== false, host: host() }
      },
      async prepare(marker) {
        calls.push('prepare')
        currentStep = 1
        sessionCreatedAt = marker.createdAt
        return { host: host(), fixture: fixture(marker) }
      },
      async inspect(marker) {
        calls.push('inspect')
        return { host: host(), fixture: fixture(marker) }
      },
      async advance(marker, expected, next) {
        calls.push(`advance:${String(expected)}:${String(next)}`)
        if (currentStep !== expected) throw new Error('secret checkpoint mismatch')
        currentStep = next
        return { host: host(), fixture: fixture(marker) }
      },
      async attach() {
        calls.push('attach')
        return { attached, detached: attached }
      },
      async cleanup(marker) {
        calls.push('cleanup')
        cleaned = true
        cleanedRunId = marker.runId
        return { sessionMissing: true, ledgerMissing: true, heartbeatMissing: true }
      },
    },
    isCleaned() {
      return cleaned
    },
    cleanedRunId() {
      return cleanedRunId
    },
  }
}

async function witness(path, evidence, clock, overrides = {}) {
  const value = {
    schemaVersion: 'dsh-luban/m03-ubuntu-disconnect-witness/v1',
    runId: evidence.runId,
    machineIdSha256: evidence.binding.machineIdSha256,
    bootId: evidence.binding.preparedBootId,
    observer: 'ubuntu-operator',
    sshDisconnected: true,
    disconnectedAt: evidence.recordedAt + 1_000,
    reconnectedAt: clock.now(),
    ...overrides,
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
}

async function latestEvidence(runDir) {
  const files = (await readdir(join(runDir, 'evidence'))).sort()
  return JSON.parse(await readFile(join(runDir, 'evidence', files.at(-1)), 'utf8'))
}

function dependencies(fake, clock) {
  return { platform: 'linux', operator: fake.operator, now: clock.now }
}

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { recursive: true, force: true })
      roots.delete(root)
    }),
  )
})

describe('M03 Ubuntu staged keepalive acceptance', () => {
  it('accepts only tmux display quoting around the exact owned command', () => {
    const command = "'/usr/bin/node' '/srv/dsh/scripts/m03.mjs' '__heartbeat-worker'"
    const expected = sha256(command)

    expect(tmuxPaneCommandSha256(command, expected)).toBe(expected)
    expect(tmuxPaneCommandSha256(`"${command}"`, expected)).toBe(expected)
    expect(tmuxPaneCommandSha256(`"${command} --unexpected"`, expected)).not.toBe(expected)
  })

  it('defaults to a no-write plan and gates prepare/cleanup behind --apply', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock)
    const deps = dependencies(fake, clock)

    const plan = await runM03UbuntuKeepaliveAcceptance(
      ['--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(plan.exitCode).toBe(0)
    expect(parsed(plan.output)).toMatchObject({
      mode: 'plan',
      acceptancePassed: false,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'preflight', readOnly: true }),
        expect.objectContaining({ stage: 'prepare', requiresApply: true }),
        expect.objectContaining({ stage: 'human-ssh-disconnect', automated: false }),
      ]),
      safety: {
        disconnectCommandExecuted: false,
        rebootCommandExecuted: false,
        lingerChanged: false,
        systemdUnitInstalledOrRemoved: false,
      },
    })
    const preparePlan = await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    const cleanupPlan = await runM03UbuntuKeepaliveAcceptance(
      ['cleanup', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(parsed(preparePlan.output)).toMatchObject({ mode: 'plan' })
    expect(parsed(cleanupPlan.output)).toMatchObject({ mode: 'plan' })
    expect(fake.calls).toHaveLength(0)
    await expect(access(paths.runDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('runs the strict staged chain with append-only evidence and never promotes simulation', async () => {
    const paths = await temporaryRun()
    let instant = 10_000
    const clock = { now: () => instant }
    const fake = fakeOperator(clock)
    const deps = dependencies(fake, clock)

    const prepared = await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(prepared.exitCode).toBe(0)
    expect(parsed(prepared.output)).toMatchObject({
      evidenceKind: 'simulated',
      stage: 'prepared',
      acceptancePassed: false,
    })
    const first = await latestEvidence(paths.runDir)
    expect(first).toMatchObject({
      sequence: 1,
      previousSha256: null,
      safety: { rebootCommandExecuted: false, disconnectCommandExecuted: false },
      latest: {
        host: { machineIdSha256: MACHINE, bootId: BOOT_ONE, systemd: { mainPid: 700 } },
        fixture: {
          tmux: { tmuxSessionId: '$7', paneId: '%12' },
          ledger: { ownerTaskId: first.binding.taskId, checkpoint: { currentStep: 1 } },
        },
      },
    })

    instant = 13_000
    await witness(paths.witness, first, clock)
    const disconnected = await runM03UbuntuKeepaliveAcceptance(
      [
        'verify-disconnect',
        '--run-dir',
        paths.runDir,
        '--ledger',
        paths.ledger,
        '--witness',
        paths.witness,
      ],
      deps,
    )
    expect(disconnected.exitCode).toBe(0)
    expect(parsed(disconnected.output)).toMatchObject({
      stage: 'disconnect-verified',
      acceptancePassed: false,
    })

    instant = 16_000
    const attached = await runM03UbuntuKeepaliveAcceptance(
      ['observe-attach', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(parsed(attached.output)).toMatchObject({ stage: 'attach-observed' })

    instant = 19_000
    const armed = await runM03UbuntuKeepaliveAcceptance(
      ['arm-reboot', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(parsed(armed.output)).toMatchObject({
      stage: 'reboot-armed',
      safety: { rebootCommandExecuted: false },
    })

    instant = 30_000
    fake.reboot()
    instant = 33_000
    const rebooted = await runM03UbuntuKeepaliveAcceptance(
      ['verify-reboot', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(rebooted.exitCode).toBe(0)
    expect(parsed(rebooted.output)).toMatchObject({
      stage: 'reboot-verified',
      evidenceKind: 'simulated',
      acceptancePassed: false,
      featureResults: {
        'M03-F001': { passed: false },
        'M03-F003': { passed: false },
      },
    })
    const rebootEvidence = await latestEvidence(paths.runDir)
    expect(rebootEvidence.binding.preparedSessionCreatedAt).toBe(10_000)
    expect(rebootEvidence.latest.fixture.ledger.sessionCreatedAt).toBe(30_000)
    const beforeCleanup = (await readdir(join(paths.runDir, 'evidence'))).sort()
    expect(beforeCleanup).toEqual([
      '01-prepared.json',
      '02-disconnect-verified.json',
      '03-attach-observed.json',
      '04-reboot-armed.json',
      '05-reboot-verified.json',
    ])

    const cleaned = await runM03UbuntuKeepaliveAcceptance(
      ['cleanup', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(parsed(cleaned.output)).toMatchObject({ stage: 'cleaned', acceptancePassed: false })
    expect(fake.isCleaned()).toBe(true)
    const finalEvidence = await latestEvidence(paths.runDir)
    expect(finalEvidence).toMatchObject({ sequence: 6, stage: 'cleaned', cleanup: 'pass' })
    expect(finalEvidence.latest).toBeNull()
  })

  it('requires a valid human disconnect witness bound to the prepared run', async () => {
    const paths = await temporaryRun()
    let instant = 10_000
    const clock = { now: () => instant }
    const fake = fakeOperator(clock)
    const deps = dependencies(fake, clock)
    await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    const first = await latestEvidence(paths.runDir)
    instant = 13_000
    await witness(paths.witness, first, clock, { runId: randomUUID() })

    const failed = await runM03UbuntuKeepaliveAcceptance(
      [
        'verify-disconnect',
        '--run-dir',
        paths.runDir,
        '--ledger',
        paths.ledger,
        '--witness',
        paths.witness,
      ],
      deps,
    )
    expect(failed.exitCode).toBe(1)
    expect(parsed(failed.output)).toMatchObject({ error: { code: 'E_ACCEPTANCE_REQUIRED' } })
    expect(await readdir(join(paths.runDir, 'evidence'))).toEqual(['01-prepared.json'])
  })

  it('rejects out-of-order stages and same-boot reboot verification', async () => {
    const paths = await temporaryRun()
    let instant = 10_000
    const clock = { now: () => instant }
    const fake = fakeOperator(clock)
    const deps = dependencies(fake, clock)
    await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    const outOfOrder = await runM03UbuntuKeepaliveAcceptance(
      ['observe-attach', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(outOfOrder.exitCode).toBe(1)

    const first = await latestEvidence(paths.runDir)
    instant = 13_000
    await witness(paths.witness, first, clock)
    await runM03UbuntuKeepaliveAcceptance(
      [
        'verify-disconnect',
        '--run-dir',
        paths.runDir,
        '--ledger',
        paths.ledger,
        '--witness',
        paths.witness,
      ],
      deps,
    )
    instant = 16_000
    await runM03UbuntuKeepaliveAcceptance(
      ['observe-attach', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    instant = 19_000
    await runM03UbuntuKeepaliveAcceptance(
      ['arm-reboot', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    instant = 22_000
    const sameBoot = await runM03UbuntuKeepaliveAcceptance(
      ['verify-reboot', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(sameBoot.exitCode).toBe(1)
    expect(await readdir(join(paths.runDir, 'evidence'))).toHaveLength(4)
  })

  it('fails closed on tampered evidence and redacts injected diagnostics', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock)
    const deps = dependencies(fake, clock)
    await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    const evidencePath = join(paths.runDir, 'evidence', '01-prepared.json')
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    evidence.acceptancePassed = true
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

    const failed = await runM03UbuntuKeepaliveAcceptance(
      ['arm-reboot', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(failed.exitCode).toBe(1)
    expect(failed.output).not.toContain('secret')
    expect(parsed(failed.output)).toEqual({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'E_ACCEPTANCE_REQUIRED',
        message: 'M03 Ubuntu acceptance stage did not pass',
      },
    })
  })

  it('reports read-only preflight and allows verified early cleanup only with apply', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock, { ready: false })
    const deps = dependencies(fake, clock)
    const preflight = await runM03UbuntuKeepaliveAcceptance(
      ['preflight', '--ledger', paths.ledger],
      deps,
    )
    expect(preflight.exitCode).toBe(2)
    expect(parsed(preflight.output)).toMatchObject({
      ok: false,
      mode: 'read-only',
      acceptancePassed: false,
    })

    const readyFake = fakeOperator(clock)
    const readyDeps = dependencies(readyFake, clock)
    await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      readyDeps,
    )
    const preview = await runM03UbuntuKeepaliveAcceptance(
      ['cleanup', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      readyDeps,
    )
    expect(parsed(preview.output)).toMatchObject({ mode: 'plan' })
    expect(readyFake.isCleaned()).toBe(false)
    const cleanup = await runM03UbuntuKeepaliveAcceptance(
      ['cleanup', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      readyDeps,
    )
    expect(parsed(cleanup.output)).toMatchObject({ stage: 'cleaned', acceptancePassed: false })
  })

  it('fails closed when a purported ready host lacks the exact boot-restore sentinel', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock)
    const operator = {
      ...fake.operator,
      async preflight() {
        const result = await fake.operator.preflight()
        return {
          ...result,
          host: {
            ...result.host,
            systemd: { ...result.host.systemd, bootRestoreSentinel: false },
          },
        }
      },
    }
    const result = await runM03UbuntuKeepaliveAcceptance(['preflight', '--ledger', paths.ledger], {
      platform: 'linux',
      operator,
      now: clock.now,
    })
    expect(result.exitCode).toBe(1)
    expect(parsed(result.output)).toMatchObject({ error: { code: 'E_ACCEPTANCE_REQUIRED' } })
  })

  it('treats inherited dependency seams as simulation', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock)
    const inherited = Object.create({
      platform: 'linux',
      operator: fake.operator,
      now: clock.now,
    })
    const result = await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      inherited,
    )
    expect(result.exitCode).toBe(0)
    expect(parsed(result.output)).toMatchObject({
      evidenceKind: 'simulated',
      acceptancePassed: false,
    })
  })

  it('timestamps snapshots after a long-running operator stage', async () => {
    const paths = await temporaryRun()
    let instant = 10_000
    const clock = { now: () => instant }
    const fake = fakeOperator(clock)
    const operator = {
      ...fake.operator,
      async prepare(marker) {
        instant += 5_000
        return await fake.operator.prepare(marker)
      },
    }
    const result = await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      { platform: 'linux', operator, now: clock.now },
    )
    expect(result.exitCode).toBe(0)
    expect(await latestEvidence(paths.runDir)).toMatchObject({
      recordedAt: 15_000,
      latest: { fixture: { heartbeat: { observedAt: 15_000 } } },
    })
  })

  it('rejects an evidence directory inside the repository', async () => {
    const runDir = resolve('node_modules', '.cache', `m03-${randomUUID()}`)
    const ledger = resolve(tmpdir(), `m03-ledger-${randomUUID()}.json`)
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock)
    const result = await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', runDir, '--ledger', ledger],
      dependencies(fake, clock),
    )
    expect(result.exitCode).toBe(1)
    await expect(access(runDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a repository-local ledger before preflight or fixture writes', async () => {
    const paths = await temporaryRun()
    const ledger = resolve('node_modules', '.cache', `m03-ledger-${randomUUID()}.json`)
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock)
    const result = await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', ledger],
      dependencies(fake, clock),
    )
    expect(result.exitCode).toBe(1)
    expect(fake.calls).toHaveLength(0)
    await expect(access(paths.runDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(ledger)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects same-boot pane and heartbeat process replacement before advancing', async () => {
    const paths = await temporaryRun()
    let instant = 10_000
    const clock = { now: () => instant }
    const fake = fakeOperator(clock)
    const deps = dependencies(fake, clock)
    await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    const first = await latestEvidence(paths.runDir)
    instant = 13_000
    await witness(paths.witness, first, clock)
    fake.replacePreparedRuntime()

    const failed = await runM03UbuntuKeepaliveAcceptance(
      [
        'verify-disconnect',
        '--run-dir',
        paths.runDir,
        '--ledger',
        paths.ledger,
        '--witness',
        paths.witness,
      ],
      deps,
    )
    expect(failed.exitCode).toBe(1)
    expect(fake.calls).not.toContain('advance:1:2')
    expect(await readdir(join(paths.runDir, 'evidence'))).toEqual(['01-prepared.json'])
  })

  it('cleans the exact owner after the first evidence publication fails', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 10_000 }
    const fake = fakeOperator(clock)
    const operator = {
      ...fake.operator,
      async prepare(marker) {
        const snapshot = await fake.operator.prepare(marker)
        await writeFile(join(marker.runDir, 'evidence', '01-prepared.json'), '{broken', {
          mode: 0o600,
          flag: 'wx',
        })
        return snapshot
      },
    }
    const deps = { platform: 'linux', operator, now: clock.now }
    const prepared = await runM03UbuntuKeepaliveAcceptance(
      ['prepare', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(prepared.exitCode).toBe(1)
    expect(fake.isCleaned()).toBe(false)
    const owner = JSON.parse(await readFile(join(paths.runDir, 'owner.json'), 'utf8'))

    const cleaned = await runM03UbuntuKeepaliveAcceptance(
      ['cleanup', '--apply', '--run-dir', paths.runDir, '--ledger', paths.ledger],
      deps,
    )
    expect(cleaned.exitCode).toBe(0)
    expect(parsed(cleaned.output)).toMatchObject({
      stage: 'cleaned',
      acceptancePassed: false,
      cleanup: 'pass',
      evidenceAppended: false,
      evidenceStatus: 'unavailable-or-invalid',
    })
    expect(fake.cleanedRunId()).toBe(owner.runId)
    expect(await readdir(join(paths.runDir, 'evidence'))).toEqual(['01-prepared.json'])
  })

  it('enumerates all panes in the owned tmux session before attach or cleanup', async () => {
    const source = await readFile(
      resolve('scripts', 'acceptance', 'm03-ubuntu-keepalive.mjs'),
      'utf8',
    )
    expect(source).toMatch(/'list-panes',\s*'-s',\s*'-t'/u)
    expect(source).toContain('if (lines.length !== 1) throw new Error')
  })
})
