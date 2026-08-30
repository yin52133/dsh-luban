import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runM03WindowsKeepaliveAcceptance } from '../acceptance/m03-windows-keepalive.mjs'

const directories = new Set()
const HOST_SCHEMA = 'dsh-luban/m03-windows-host-heartbeat/v1'
const SESSION_SCHEMA = 'dsh-luban/m03-windows-session-heartbeat/v1'
const CLEANUP_SCHEMA = 'dsh-luban/m03-windows-cleanup-confirmation/v1'

function temporaryRunDirectory() {
  const directory = join(tmpdir(), `m03-windows-acceptance-${randomUUID()}`)
  directories.add(directory)
  return directory
}

function parseOutput(result) {
  return JSON.parse(result.output)
}

function canonicalDigest(value) {
  return createHash('sha256')
    .update(`${JSON.stringify(value, null, 2)}\n`)
    .digest('hex')
}

function fakeRuntime() {
  const calls = []
  const runtimeConfiguration = (runDir) => ({
    nodePath: join(runDir, 'runtime', 'node.exe'),
    dshEntryPath: join(runDir, 'runtime', 'dsh', 'lib', 'bin.js'),
    dshHome: join(runDir, 'dsh-home'),
    operatorPath: join(runDir, 'runtime', 'windows-operator-cli.js'),
    bootstrapPath: join(runDir, 'runtime', 'windows-host-bootstrap.js'),
    workerPath: join(runDir, 'runtime', 'windows-acceptance-worker.js'),
  })
  return {
    calls,
    async prepareRunDirectory(runDir) {
      calls.push({ method: 'prepare-run', runDir })
      return 'S-1-5-21-1000'
    },
    async validateRunDirectory(runDir, principalSid) {
      calls.push({ method: 'validate-run', runDir, principalSid })
    },
    async prepare(runDir) {
      calls.push({ method: 'prepare', runDir })
      return runtimeConfiguration(runDir)
    },
    async verify(runDir, _owner, _ownerSha256, expected) {
      calls.push({ method: 'verify', runDir })
      expect(expected).toEqual(runtimeConfiguration(runDir))
      return runtimeConfiguration(runDir)
    },
  }
}

function fakeOperator(clock) {
  const calls = []
  let state = 'missing'
  let running = null
  let childState = 'missing'
  let childRunning = null
  let bootStartedAt = 500_000
  let hostStartedAt = 600_000
  let hostSequence = 0
  let sessionStartedAt = 700_000
  let sessionSequence = 0
  let stale = false
  let checkpointChanged = false
  let failObservationCount = 0
  let cleanupConfirmation = null
  let installCalls = 0
  let uninstallCalls = 0
  let cleanupWaitCalls = 0
  let crashAfterUninstall = false

  const launch = (context) => ({
    nodeExecutable: context.spec.runtime.nodePath,
    bootstrapPath: context.spec.runtime.bootstrapPath,
    dshEntry: context.spec.runtime.dshEntryPath,
    dshHome: context.spec.runtime.dshHome,
    profile: 'win-debug',
    acceptance: {
      runDir: context.runDir,
      runId: context.spec.runId,
      specSha256: context.specSha256,
    },
  })
  const status = (context) => ({
    host: {
      taskName: '\\dsh-luban-host',
      user: 'builder',
      state,
      running: state === 'missing' ? null : running,
      trigger: 'boot',
      logon: 's4u',
      runLevel: 'limited',
      launch: launch(context),
      environment: { LUBAN_BOOT_RESTORE: '1' },
      elevated: true,
      operationallyVerified: false,
    },
    child: {
      taskName: `\\dsh-luban-session-${context.spec.sessionId}`,
      state: childState,
      running: childState === 'exact' ? childRunning : null,
    },
  })

  return {
    calls,
    get installCalls() {
      return installCalls
    },
    get uninstallCalls() {
      return uninstallCalls
    },
    get cleanupWaitCalls() {
      return cleanupWaitCalls
    },
    signOut() {
      return undefined
    },
    reboot() {
      bootStartedAt = clock.value - 10_000
      hostStartedAt = clock.value - 9_000
      hostSequence = 0
      sessionStartedAt = clock.value - 8_000
      sessionSequence = 0
    },
    setStale(value) {
      stale = value
    },
    setCheckpointChanged(value) {
      checkpointChanged = value
    },
    failNextObservation() {
      failObservationCount += 1
    },
    setConflict() {
      state = 'conflict'
      running = true
      childState = 'conflict'
      childRunning = null
    },
    crashAfterNextUninstall() {
      crashAfterUninstall = true
    },
    async status(context) {
      calls.push({ method: 'status' })
      return status(context)
    },
    async install() {
      calls.push({ method: 'install' })
      installCalls += 1
      state = 'exact'
      running = false
    },
    async start() {
      calls.push({ method: 'start' })
      if (state !== 'exact') throw new Error('cannot start a foreign task')
      running = true
      childState = 'exact'
      childRunning = true
    },
    async observe(context) {
      calls.push({ method: 'observe' })
      if (failObservationCount > 0) {
        failObservationCount -= 1
        throw new Error('simulated crash after task install')
      }
      hostSequence += 1
      sessionSequence += 1
      const observedAt = stale ? clock.value - 20_000 : clock.value
      const checkpoint = checkpointChanged
        ? { ...context.spec.checkpoint, currentStep: 0 }
        : context.spec.checkpoint
      const checkpointSha256 = createHash('sha256')
        .update(JSON.stringify(context.spec.checkpoint))
        .digest('hex')
      const seedAttempt = {
        schemaVersion: 'dsh-luban/m03-windows-checkpoint-seed-attempt/v1',
        runId: context.spec.runId,
        specSha256: context.specSha256,
        sessionId: context.spec.sessionId,
        taskId: context.spec.taskId,
        checkpointSha256,
        bootStartedAt: 500_000,
        attemptedAt: 900_000,
      }
      const attemptSha256 = canonicalDigest(seedAttempt)
      const seedConfirmation = {
        schemaVersion: 'dsh-luban/m03-windows-checkpoint-seeded/v1',
        runId: context.spec.runId,
        specSha256: context.specSha256,
        sessionId: context.spec.sessionId,
        taskId: context.spec.taskId,
        checkpointSha256,
        attemptSha256,
        seededAt: 900_100,
      }
      const markerSha256 = canonicalDigest(seedConfirmation)
      const checkpointSeedSummary = {
        attemptSha256,
        markerSha256,
        bootStartedAt: seedAttempt.bootStartedAt,
      }
      return {
        capturedAt: clock.value,
        systemBootStartedAt: bootStartedAt,
        host: {
          schemaVersion: HOST_SCHEMA,
          runId: context.spec.runId,
          specSha256: context.specSha256,
          bootStartedAt,
          startedAt: hostStartedAt,
          sequence: hostSequence,
          observedAt,
          managed: {
            sessionId: context.spec.sessionId,
            ownerTaskId: context.spec.taskId,
            kind: 'service',
            checkpoint,
            checkpointSeed: checkpointSeedSummary,
          },
        },
        session: {
          schemaVersion: SESSION_SCHEMA,
          runId: context.spec.runId,
          specSha256: context.specSha256,
          bootStartedAt,
          startedAt: sessionStartedAt,
          sequence: sessionSequence,
          observedAt,
          sessionId: context.spec.sessionId,
          taskId: context.spec.taskId,
        },
        checkpointSeed: {
          attempt: seedAttempt,
          attemptSha256,
          confirmation: seedConfirmation,
          markerSha256,
        },
      }
    },
    async cleanupConfirmation(context, wait) {
      calls.push({ method: 'cleanup-confirmation', wait })
      if (wait) {
        cleanupWaitCalls += 1
        cleanupConfirmation = {
          schemaVersion: CLEANUP_SCHEMA,
          runId: context.spec.runId,
          specSha256: context.specSha256,
          sessionId: context.spec.sessionId,
          taskId: context.spec.taskId,
          confirmedAt: clock.value,
        }
        childState = 'missing'
        childRunning = null
      }
      return cleanupConfirmation
    },
    async uninstall() {
      calls.push({ method: 'uninstall' })
      uninstallCalls += 1
      state = 'missing'
      running = null
      if (crashAfterUninstall) {
        crashAfterUninstall = false
        throw new Error('simulated crash after exact task deletion')
      }
    },
  }
}

function fixture() {
  const runDir = temporaryRunDirectory()
  const clock = { value: 1_000_000 }
  const runtime = fakeRuntime()
  const operator = fakeOperator(clock)
  const dependencies = { platform: 'win32', now: () => clock.value, runtime, operator }
  return { runDir, clock, runtime, operator, dependencies }
}

async function runStage(stage, fixtureValue, apply = false) {
  return await runM03WindowsKeepaliveAcceptance(
    [stage, ...(apply ? ['--apply'] : []), '--run-dir', fixtureValue.runDir],
    fixtureValue.dependencies,
  )
}

async function reachRebootVerified(fixtureValue, options = {}) {
  expect((await runStage('prepare', fixtureValue, true)).exitCode).toBe(0)
  fixtureValue.operator.signOut()
  fixtureValue.clock.value += 10_000
  expect((await runStage('verify-signout', fixtureValue)).exitCode).toBe(0)
  fixtureValue.clock.value += 10_000
  expect((await runStage('arm-reboot', fixtureValue)).exitCode).toBe(0)
  fixtureValue.clock.value += 1_000_000
  fixtureValue.operator.reboot(options)
  expect((await runStage('verify-reboot', fixtureValue)).exitCode).toBe(0)
}

afterEach(async () => {
  await Promise.all(
    [...directories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('M03 Windows mounted keepalive acceptance', () => {
  it('defaults to a no-write plan and keeps task mutations behind --apply', async () => {
    const value = fixture()
    const plan = await runM03WindowsKeepaliveAcceptance([], value.dependencies)
    expect(parseOutput(plan)).toMatchObject({
      ok: true,
      mode: 'plan',
      scope: 'M03-F002+M03-F003/windows-signout-reboot-continuation',
      acceptancePassed: false,
      stages: [
        { stage: 'prepare', requiresApply: true },
        { stage: 'verify-signout' },
        { stage: 'arm-reboot' },
        { stage: 'verify-reboot' },
        { stage: 'cleanup', requiresApply: true },
      ],
      signoutOrRebootCommandExecuted: false,
    })
    expect(parseOutput(await runStage('prepare', value))).toMatchObject({ mode: 'plan' })
    expect(parseOutput(await runStage('cleanup', value))).toMatchObject({ mode: 'plan' })
    expect(value.operator.calls).toHaveLength(0)
    expect(value.runtime.calls).toHaveLength(0)
    await expect(access(value.runDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform === 'win32')(
    'accepts a normal external run directory reached through a junction',
    async () => {
      const linkContainer = temporaryRunDirectory()
      const linkTarget = temporaryRunDirectory()
      await mkdir(linkContainer, { mode: 0o700 })
      await mkdir(linkTarget, { mode: 0o700 })
      const linkedParent = join(linkContainer, 'linked')
      await symlink(linkTarget, linkedParent, 'junction')
      const value = fixture()
      value.runDir = join(linkedParent, 'run')

      const result = await runStage('prepare', value, true)

      expect(result.exitCode).toBe(0)
      expect(parseOutput(result)).toMatchObject({ stage: 'prepared' })
      expect(value.runtime.calls.length).toBeGreaterThan(0)
      expect(value.operator.calls.length).toBeGreaterThan(0)
      await expect(access(join(linkTarget, 'run', 'owner.json'))).resolves.toBeUndefined()
    },
  )

  it.runIf(process.platform === 'win32')(
    'prepares the normal workspace build and profile for the staged run',
    async () => {
      const value = fixture()
      const result = await runM03WindowsKeepaliveAcceptance(
        ['prepare', '--apply', '--run-dir', value.runDir],
        {
          platform: 'win32',
          now: () => value.clock.value,
          operator: value.operator,
          environment: process.env,
        },
      )

      expect(result.exitCode).toBe(0)
      expect(parseOutput(result)).toMatchObject({ stage: 'prepared' })
      const profilePatch = await readFile(
        join(value.runDir, 'dsh-home', 'profiles', 'win-debug', 'cordis.patch.yml'),
        'utf8',
      )
      expect(profilePatch).toContain('strategy: service')
      await expect(access(join(value.runDir, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it.runIf(process.platform === 'win32')(
    'ignores inherited and proxied dependency values instead of treating them as adapters',
    async () => {
      const inherited = fixture()
      const inheritedDependencies = Object.create({
        ...inherited.dependencies,
        platform: 'linux',
      })
      const inheritedResult = await runM03WindowsKeepaliveAcceptance(
        ['verify-signout', '--run-dir', inherited.runDir],
        inheritedDependencies,
      )
      expect(parseOutput(inheritedResult)).toMatchObject({
        error: { code: 'E_ACCEPTANCE_REQUIRED' },
      })
      expect(inherited.runtime.calls).toHaveLength(0)
      expect(inherited.operator.calls).toHaveLength(0)

      const proxied = fixture()
      const proxiedDependencies = new Proxy(
        Object.create({ ...proxied.dependencies, platform: 'linux' }),
        {
          ownKeys: () => [],
        },
      )
      const proxiedResult = await runM03WindowsKeepaliveAcceptance(
        ['verify-signout', '--run-dir', proxied.runDir],
        proxiedDependencies,
      )
      expect(parseOutput(proxiedResult)).toMatchObject({
        error: { code: 'E_ACCEPTANCE_REQUIRED' },
      })
      expect(proxied.runtime.calls).toHaveLength(0)
      expect(proxied.operator.calls).toHaveLength(0)
    },
  )

  it('runs every human-bounded stage without ever claiming simulation passed', async () => {
    const value = fixture()
    const prepared = await runStage('prepare', value, true)
    expect(parseOutput(prepared)).toMatchObject({
      stage: 'prepared',
      evidenceKind: 'simulated',
      acceptancePassed: false,
      next: expect.stringContaining('sign out'),
      signoutOrRebootCommandExecuted: false,
    })

    value.operator.signOut()
    value.clock.value += 10_000
    expect(parseOutput(await runStage('verify-signout', value))).toMatchObject({
      stage: 'signout-verified',
      acceptancePassed: false,
    })

    value.clock.value += 10_000
    expect(parseOutput(await runStage('arm-reboot', value))).toMatchObject({
      stage: 'reboot-armed',
      next: expect.stringContaining('reboot Windows manually'),
    })
    const sameBoot = await runStage('verify-reboot', value)
    expect(sameBoot.exitCode).toBe(1)
    value.clock.value += 1_000_000
    value.operator.reboot({ reusePids: true })
    expect(parseOutput(await runStage('verify-reboot', value))).toMatchObject({
      stage: 'reboot-verified',
      acceptancePassed: false,
    })

    const cleanupPlan = await runStage('cleanup', value)
    expect(parseOutput(cleanupPlan)).toMatchObject({ mode: 'plan' })
    const cleaned = await runStage('cleanup', value, true)
    expect(parseOutput(cleaned)).toMatchObject({
      stage: 'cleaned',
      evidenceKind: 'simulated',
      acceptancePassed: false,
      featureResults: { 'M03-F002': { passed: false }, 'M03-F003': { passed: false } },
    })
    expect(value.operator.installCalls).toBe(1)
    expect(value.operator.uninstallCalls).toBe(1)
    expect(
      value.operator.calls.some((call) => /signout|reboot|shutdown|logoff/iu.test(call.method)),
    ).toBe(false)

    const eventNames = (await readdir(join(value.runDir, 'events'))).sort()
    expect(eventNames).toHaveLength(10)
    expect(eventNames[0]).toBe('000001-prepare-attempt.json')
    expect(eventNames.at(-1)).toBe('000010-cleanup-confirmed.json')
    const repeated = await runStage('cleanup', value, true)
    expect(parseOutput(repeated)).toMatchObject({ stage: 'cleaned', resumed: true })
    expect(value.operator.uninstallCalls).toBe(1)

    const owner = JSON.parse(await readFile(join(value.runDir, 'owner.json'), 'utf8'))
    const spec = JSON.parse(await readFile(join(value.runDir, 'acceptance-spec.json'), 'utf8'))
    expect(owner.evidenceKind).toBe('simulated')
    expect(spec.evidenceKind).toBe('simulated')
    if (process.platform === 'win32') {
      const runtimeCalls = value.runtime.calls.length
      const operatorCalls = value.operator.calls.length
      const launderingAttempt = await runM03WindowsKeepaliveAcceptance([
        'cleanup',
        '--apply',
        '--run-dir',
        value.runDir,
      ])
      expect(parseOutput(launderingAttempt)).toMatchObject({
        error: { code: 'E_ACCEPTANCE_REQUIRED' },
      })
      expect(value.runtime.calls).toHaveLength(runtimeCalls)
      expect(value.operator.calls).toHaveLength(operatorCalls)
    }
  })

  it('requires fresh advancing host and worker heartbeats across sign-out', async () => {
    const stale = fixture()
    expect((await runStage('prepare', stale, true)).exitCode).toBe(0)
    stale.operator.signOut()
    stale.clock.value += 30_000
    stale.operator.setStale(true)
    expect((await runStage('verify-signout', stale)).exitCode).toBe(1)
  })

  it('accepts PID reuse after reboot when the boot marker advances', async () => {
    const reused = fixture()
    await reachRebootVerified(reused, { reusePids: true })
    expect(parseOutput(await runStage('verify-reboot', reused))).toMatchObject({
      stage: 'reboot-verified',
      resumed: true,
    })
  })

  it('rejects a changed mounted checkpoint even when the task reports Running', async () => {
    const value = fixture()
    expect((await runStage('prepare', value, true)).exitCode).toBe(0)
    value.operator.signOut()
    value.clock.value += 10_000
    value.operator.setCheckpointChanged(true)
    expect((await runStage('verify-signout', value)).exitCode).toBe(1)
  })

  it('recovers when prepare crashes after installing the exact task but before confirmation', async () => {
    const value = fixture()
    value.operator.failNextObservation()
    const crashed = await runStage('prepare', value, true)
    expect(crashed.exitCode).toBe(1)
    expect(value.operator.installCalls).toBe(1)
    expect(await readdir(join(value.runDir, 'events'))).toEqual(['000001-prepare-attempt.json'])

    const resumed = await runStage('prepare', value, true)
    expect(parseOutput(resumed)).toMatchObject({ stage: 'prepared', acceptancePassed: false })
    expect(value.operator.installCalls).toBe(1)
    expect((await readdir(join(value.runDir, 'events'))).sort()).toEqual([
      '000001-prepare-attempt.json',
      '000002-prepare-confirmed.json',
    ])
  })

  it('re-enters cleanup safely after the exact task was removed but before event confirmation', async () => {
    const value = fixture()
    await reachRebootVerified(value)
    value.operator.crashAfterNextUninstall()

    expect((await runStage('cleanup', value, true)).exitCode).toBe(1)
    expect(value.operator.uninstallCalls).toBe(1)
    expect(value.operator.cleanupWaitCalls).toBe(1)
    expect((await readdir(join(value.runDir, 'events'))).sort().at(-1)).toBe(
      '000009-cleanup-attempt.json',
    )

    const resumed = await runStage('cleanup', value, true)
    expect(parseOutput(resumed)).toMatchObject({ stage: 'cleaned', acceptancePassed: false })
    expect(value.operator.uninstallCalls).toBe(1)
    expect(value.operator.cleanupWaitCalls).toBe(1)
  })

  it('never installs over or cleans a foreign task target', async () => {
    const blockedPrepare = fixture()
    blockedPrepare.operator.setConflict()
    expect((await runStage('prepare', blockedPrepare, true)).exitCode).toBe(1)
    expect(blockedPrepare.operator.installCalls).toBe(0)
    expect(blockedPrepare.operator.uninstallCalls).toBe(0)

    const blockedCleanup = fixture()
    await reachRebootVerified(blockedCleanup)
    blockedCleanup.operator.setConflict()
    expect((await runStage('cleanup', blockedCleanup, true)).exitCode).toBe(1)
    expect(blockedCleanup.operator.cleanupWaitCalls).toBe(0)
    expect(blockedCleanup.operator.uninstallCalls).toBe(0)
    await expect(access(join(blockedCleanup.runDir, 'cleanup-request.json'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    )
  })

  it('rejects an inconsistent create-once spec or out-of-sequence stage state', async () => {
    const changedSpec = fixture()
    expect((await runStage('prepare', changedSpec, true)).exitCode).toBe(0)
    const specPath = join(changedSpec.runDir, 'acceptance-spec.json')
    const spec = JSON.parse(await readFile(specPath, 'utf8'))
    spec.sessionId = 'luban-foreign'
    await writeFile(specPath, `${JSON.stringify(spec)}\n`, 'utf8')
    expect((await runStage('prepare', changedSpec, true)).exitCode).toBe(1)

    const outOfSequenceState = fixture()
    expect((await runStage('prepare', outOfSequenceState, true)).exitCode).toBe(0)
    const eventPath = join(outOfSequenceState.runDir, 'events', '000002-prepare-confirmed.json')
    const event = JSON.parse(await readFile(eventPath, 'utf8'))
    event.payload.observation.host.managed.checkpoint.currentStep = 0
    await writeFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8')
    outOfSequenceState.operator.signOut()
    outOfSequenceState.clock.value += 10_000
    expect((await runStage('verify-signout', outOfSequenceState)).exitCode).toBe(1)
  })
})
