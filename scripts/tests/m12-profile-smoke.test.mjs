import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  M12_PROFILE_DSH_VERSION,
  M12_PROFILE_CHECK_IDS,
  M12_PROFILE_DUAL_SCHEMA,
  M12_PROFILE_EVIDENCE_SCHEMA,
  M12_PROFILE_FIXTURE_SHA256,
  M12_PROFILE_TASK_SHA256,
  aggregateM12ProfileSmokeEvidence,
  createProfileSmokePlan,
  evaluateLazyClient,
  inspectM12RuntimePlatform,
  isOwnedTemporaryRoot,
  m12PluginInstallArgs,
  m12TsdownArgs,
  removeOwnedTemporaryRoot,
  runM12ProfileSmoke,
  runM12ProfileSmokeCli,
} from '../acceptance/m12-profile-smoke.mjs'

const directories = new Set()
const GIT_SHA = 'a'.repeat(40)
const DRIFTED_GIT_SHA = 'b'.repeat(40)
const WORKFLOW = Object.freeze({ expectedGitSha: GIT_SHA, runId: '987654321', runAttempt: 2 })
const WORKFLOW_OPTIONS = Object.freeze({
  expectedGitSha: GIT_SHA,
  workflowRunId: WORKFLOW.runId,
  workflowRunAttempt: WORKFLOW.runAttempt,
})

const WINDOWS_PLATFORM = Object.freeze({
  target: 'windows',
  runtimePlatform: 'win32',
  arch: 'x64',
  node: 'v22.19.0',
})
const UBUNTU_PLATFORM = Object.freeze({
  target: 'ubuntu',
  runtimePlatform: 'linux',
  arch: 'x64',
  node: 'v22.19.0',
  osReleaseId: 'ubuntu',
})

function liveEvidence(target, overrides = {}) {
  const platform = target === 'windows' ? WINDOWS_PLATFORM : UBUNTU_PLATFORM
  const profile = target === 'windows' ? 'win-debug' : 'ubuntu-server'
  return {
    schemaVersion: M12_PROFILE_EVIDENCE_SCHEMA,
    featureId: 'M12-F001',
    runId: `${target}-run`,
    execution: 'production',
    evidenceKind: 'live',
    platform,
    profile,
    workflow: WORKFLOW,
    git: {
      before: { sha: GIT_SHA, clean: true },
      after: { sha: GIT_SHA, clean: true },
    },
    taskSha256: M12_PROFILE_TASK_SHA256,
    fixtureSha256: M12_PROFILE_FIXTURE_SHA256,
    dsh: {
      expectedVersion: M12_PROFILE_DSH_VERSION,
      actualVersion: M12_PROFILE_DSH_VERSION,
    },
    status: 'pass',
    acceptancePassed: true,
    checks: M12_PROFILE_CHECK_IDS.map((id) => ({ id, status: 'pass', actual: 'ok' })),
    cleanup: 'pass',
    startedAt: '2026-08-30T01:00:00.000Z',
    finishedAt: '2026-08-30T01:01:00.000Z',
    ...overrides,
  }
}

function serializeEvidence(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'luban-m12-profile-smoke-test-'))
  directories.add(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    [...directories].map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('M12 real profile smoke runner', () => {
  it('defaults to a non-writing plan and selects the platform profile', async () => {
    const root = await temporaryRoot()
    const result = await runM12ProfileSmoke({ root, platform: 'linux', runId: 'plan-run' })

    expect(result).toMatchObject({
      featureId: 'M12-F001',
      runId: 'plan-run',
      profile: 'ubuntu-server',
      evidenceKind: 'none',
      status: 'planned',
      acceptancePassed: false,
    })
    await expect(
      readFile(join(root, 'node_modules', '.cache', 'dsh-luban-acceptance', 'anything')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(createProfileSmokePlan({ root, platform: 'win32' }).profile).toBe('win-debug')
    expect(() => createProfileSmokePlan({ root, platform: 'darwin' })).toThrow(/unsupported/u)
    expect(result.taskSha256).toBe(M12_PROFILE_TASK_SHA256)
    expect(result.fixtureSha256).toBe(M12_PROFILE_FIXTURE_SHA256)
    expect(M12_PROFILE_TASK_SHA256).toMatch(/^[a-f0-9]{64}$/u)
    expect(M12_PROFILE_FIXTURE_SHA256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('never promotes injected fake execution to live acceptance evidence', async () => {
    const executeLive = vi.fn(async () => ({
      status: 'pass',
      checks: [{ id: 'fake', status: 'pass', actual: 'simulated only' }],
      cleanup: 'pass',
    }))
    const result = await runM12ProfileSmoke(
      { live: true, platform: 'linux', runId: 'fake-run', ...WORKFLOW_OPTIONS },
      {
        inspectPlatform: async () => UBUNTU_PLATFORM,
        inspectGit: async () => ({ sha: GIT_SHA, clean: true }),
        executeLive,
      },
    )

    expect(executeLive).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      evidenceKind: 'simulated',
      execution: 'test-double',
      status: 'simulated',
      acceptancePassed: false,
    })
    expect(result.git).toEqual({
      before: { sha: GIT_SHA, clean: true },
      after: { sha: GIT_SHA, clean: true },
    })
  })

  it('requires an explicit workflow identity and blocks execution on expected SHA drift', async () => {
    await expect(
      runM12ProfileSmoke({ live: true, platform: 'linux', runId: 'unbound-run' }),
    ).rejects.toThrow(/must be provided together/u)

    const executeLive = vi.fn()
    const result = await runM12ProfileSmoke(
      {
        live: true,
        platform: 'linux',
        runId: 'sha-drift-run',
        ...WORKFLOW_OPTIONS,
        expectedGitSha: DRIFTED_GIT_SHA,
      },
      {
        inspectPlatform: async () => UBUNTU_PLATFORM,
        inspectGit: async () => ({ sha: GIT_SHA, clean: true }),
        executeLive,
      },
    )

    expect(executeLive).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'blocked', acceptancePassed: false })
    expect(result.checks).toContainEqual({
      id: 'git-expected-sha',
      status: 'blocked',
      actual: 'mismatch',
    })
  })

  it('fails closed on a dirty tree before execution', async () => {
    const executeLive = vi.fn()
    const inspectGit = vi
      .fn()
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: false })
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: false })
    const result = await runM12ProfileSmoke(
      { live: true, platform: 'win32', runId: 'dirty-run', ...WORKFLOW_OPTIONS },
      {
        inspectPlatform: async () => WINDOWS_PLATFORM,
        inspectGit,
        executeLive,
      },
    )

    expect(executeLive).not.toHaveBeenCalled()
    expect(inspectGit).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      execution: 'test-double',
      evidenceKind: 'simulated',
      status: 'blocked',
      acceptancePassed: false,
      git: {
        before: { sha: GIT_SHA, clean: false },
        after: { sha: GIT_SHA, clean: false },
      },
    })
  })

  it('fails closed when Git HEAD drifts after an otherwise passing execution', async () => {
    const inspectGit = vi
      .fn()
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: true })
      .mockResolvedValueOnce({ sha: DRIFTED_GIT_SHA, clean: true })
    const result = await runM12ProfileSmoke(
      { live: true, platform: 'win32', runId: 'head-drift-run', ...WORKFLOW_OPTIONS },
      {
        inspectPlatform: async () => WINDOWS_PLATFORM,
        inspectGit,
        executeLive: async () => ({
          status: 'pass',
          checks: [{ id: 'fake-live-body', status: 'pass', actual: 'ok' }],
          cleanup: 'pass',
          actualDshVersion: M12_PROFILE_DSH_VERSION,
        }),
      },
    )

    expect(result).toMatchObject({
      execution: 'test-double',
      evidenceKind: 'simulated',
      status: 'fail',
      acceptancePassed: false,
      git: {
        before: { sha: GIT_SHA, clean: true },
        after: { sha: DRIFTED_GIT_SHA, clean: true },
      },
    })
    expect(result.checks).toContainEqual({
      id: 'git-head-unchanged',
      status: 'fail',
      actual: 'false',
    })
  })

  it('fails closed when a clean tree becomes dirty during execution', async () => {
    const inspectGit = vi
      .fn()
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: true })
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: false })
    const result = await runM12ProfileSmoke(
      { live: true, platform: 'linux', runId: 'after-dirty-run', ...WORKFLOW_OPTIONS },
      {
        inspectPlatform: async () => UBUNTU_PLATFORM,
        inspectGit,
        executeLive: async () => ({
          status: 'pass',
          checks: [{ id: 'fake-live-body', status: 'pass', actual: 'ok' }],
          cleanup: 'pass',
          actualDshVersion: M12_PROFILE_DSH_VERSION,
        }),
      },
    )

    expect(result).toMatchObject({
      execution: 'test-double',
      status: 'fail',
      acceptancePassed: false,
      git: {
        before: { sha: GIT_SHA, clean: true },
        after: { sha: GIT_SHA, clean: false },
      },
    })
    expect(result.checks).toContainEqual({
      id: 'git-after-clean',
      status: 'fail',
      actual: 'false',
    })
  })

  it('attests only Windows or Linux with /etc/os-release ID=ubuntu', async () => {
    await expect(inspectM12RuntimePlatform('win32', 'x64', 'v22.19.0')).resolves.toEqual(
      WINDOWS_PLATFORM,
    )
    await expect(
      inspectM12RuntimePlatform(
        'linux',
        'x64',
        'v22.19.0',
        async () => 'NAME=Ubuntu\nID="ubuntu"\n',
      ),
    ).resolves.toEqual(UBUNTU_PLATFORM)
    await expect(
      inspectM12RuntimePlatform('linux', 'x64', 'v22.19.0', async () => 'ID=debian\n'),
    ).rejects.toThrow(/ID=ubuntu/u)
    await expect(inspectM12RuntimePlatform('darwin', 'arm64', 'v22.19.0')).rejects.toThrow(
      /unsupported/u,
    )
  })

  it('fails closed before side effects when project-local dsh is absent', async () => {
    const root = await temporaryRoot()
    const result = await runM12ProfileSmoke(
      {
        root,
        live: true,
        platform: 'win32',
        runId: 'blocked-run',
        ...WORKFLOW_OPTIONS,
      },
      {
        inspectPlatform: async () => WINDOWS_PLATFORM,
        inspectGit: async () => ({ sha: GIT_SHA, clean: true }),
      },
    )

    expect(result).toMatchObject({
      evidenceKind: 'simulated',
      status: 'blocked',
      acceptancePassed: false,
      cleanup: 'not-needed',
    })
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'live-preflight', status: 'blocked' }),
    )
    await expect(
      readFile(join(root, 'node_modules', '.cache', 'dsh-luban-acceptance', 'anything')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('only removes absolute, directly owned smoke roots from the ignored cache', async () => {
    const root = await temporaryRoot()
    const owner = join(root, 'node_modules', '.cache', 'dsh-luban-acceptance')
    const owned = join(owner, 'm12-profile-delete-me')
    const outside = join(root, 'node_modules', '.cache', 'dsh-luban-acceptance-other')
    const prefixTrick = join(outside, 'm12-profile-keep-me')
    await mkdir(owned, { recursive: true })
    await mkdir(prefixTrick, { recursive: true })

    expect(isOwnedTemporaryRoot(root, owned)).toBe(true)
    expect(isOwnedTemporaryRoot(root, 'm12-profile-relative')).toBe(false)
    expect(isOwnedTemporaryRoot(root, owner)).toBe(false)
    expect(isOwnedTemporaryRoot(root, join(owned, 'nested'))).toBe(false)
    expect(isOwnedTemporaryRoot(root, prefixTrick)).toBe(false)

    await expect(removeOwnedTemporaryRoot(root, prefixTrick)).rejects.toThrow(
      /Refusing to clean an unowned temporary path/u,
    )
    await expect(stat(prefixTrick)).resolves.toMatchObject({})
    await removeOwnedTemporaryRoot(root, owned)
    await expect(stat(owned)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses offline profile installation and evaluates a lazy-CJS lifecycle', () => {
    expect(m12TsdownArgs('D:\\repo\\node_modules\\tsdown\\dist\\run.mjs')).toEqual([
      'D:\\repo\\node_modules\\tsdown\\dist\\run.mjs',
      '--config-loader',
      'tsx',
    ])
    expect(
      m12PluginInstallArgs('ubuntu-server', 'C:\\fixture\\plugin', 'C:\\fixture\\pnpm-store'),
    ).toEqual([
      'plugin',
      '--profile',
      'ubuntu-server',
      '--ignore-workspace',
      'add',
      '--offline',
      '--config.auto-install-peers=false',
      '--store-dir',
      'C:/fixture/pnpm-store',
      'file:C:/fixture/plugin',
    ])

    const source = `window.__ModuleLoader__.load({
      id: 'dsh-luban-acceptance',
      factory: function () {
        return {
          apply: function (ctx) {
            Reflect.set(globalThis, '__LUBAN_M12_CLIENT_LIFECYCLE__', { runId: 'client-run', event: 'mounted' })
            ctx.effect(function () {
              return function () {
                Reflect.set(globalThis, '__LUBAN_M12_CLIENT_LIFECYCLE__', { runId: 'client-run', event: 'disposed' })
              }
            })
          }
        }
      }
    })`
    expect(evaluateLazyClient(source, 'client-run')).toEqual({
      moduleId: 'dsh-luban-acceptance',
      lifecycle: ['mounted', 'disposed'],
    })
    expect(() => evaluateLazyClient('window.__ModuleLoader__.load({ id: "wrong" })', 'x')).toThrow(
      /expected lazy-CJS/u,
    )
  })

  it('aggregates exactly one same-source Windows and Ubuntu live pass without copying logs', () => {
    const secretLikeDiagnostic = 'never-copy-this-secret-value'
    const windows = liveEvidence('windows', {
      checks: M12_PROFILE_CHECK_IDS.map((id) => ({
        id,
        status: 'pass',
        actual: id === 'host-mounted' ? secretLikeDiagnostic : 'ok',
      })),
    })
    const ubuntu = liveEvidence('ubuntu')
    const windowsInput = serializeEvidence(windows)
    const ubuntuInput = serializeEvidence(ubuntu)
    const aggregate = aggregateM12ProfileSmokeEvidence(
      [windowsInput, ubuntuInput],
      WORKFLOW,
      () => new Date('2026-08-30T02:00:00.000Z'),
    )

    expect(aggregate).toMatchObject({
      featureId: 'M12-F001',
      status: 'pass',
      acceptancePassed: true,
      gitSha: GIT_SHA,
      taskSha256: M12_PROFILE_TASK_SHA256,
      fixtureSha256: M12_PROFILE_FIXTURE_SHA256,
      dshVersion: M12_PROFILE_DSH_VERSION,
      workflow: { runId: WORKFLOW.runId, runAttempt: WORKFLOW.runAttempt },
      generatedAt: '2026-08-30T02:00:00.000Z',
      inputs: {
        windows: { runId: 'windows-run', evidenceSha256: sha256(windowsInput) },
        ubuntu: { runId: 'ubuntu-run', evidenceSha256: sha256(ubuntuInput) },
      },
    })
    expect(JSON.stringify(aggregate)).not.toContain(secretLikeDiagnostic)
  })

  it('rejects canonical hash drift and fake or simulated evidence', () => {
    const ubuntu = liveEvidence('ubuntu')
    expect(() =>
      aggregateM12ProfileSmokeEvidence(
        [
          serializeEvidence(liveEvidence('windows', { fixtureSha256: 'c'.repeat(64) })),
          serializeEvidence(ubuntu),
        ],
        WORKFLOW,
      ),
    ).toThrow(/not an aggregatable|same source/u)

    const fake = liveEvidence('windows', {
      execution: 'test-double',
      evidenceKind: 'simulated',
      status: 'simulated',
      acceptancePassed: false,
    })
    expect(() =>
      aggregateM12ProfileSmokeEvidence(
        [serializeEvidence(fake), serializeEvidence(ubuntu)],
        WORKFLOW,
      ),
    ).toThrow(/production live pass/u)
  })

  it('requires the exact canonical checks in their deterministic order', () => {
    const ubuntuInput = serializeEvidence(liveEvidence('ubuntu'))
    const missingCheck = liveEvidence('windows', {
      checks: M12_PROFILE_CHECK_IDS.slice(1).map((id) => ({ id, status: 'pass', actual: 'ok' })),
    })
    const reorderedChecks = liveEvidence('windows', {
      checks: [...liveEvidence('windows').checks].reverse(),
    })
    const extraCheck = liveEvidence('windows', {
      checks: [
        ...liveEvidence('windows').checks,
        { id: 'forged-extra-check', status: 'pass', actual: 'ok' },
      ],
    })

    for (const evidence of [missingCheck, reorderedChecks, extraCheck]) {
      expect(() =>
        aggregateM12ProfileSmokeEvidence([serializeEvidence(evidence), ubuntuInput], WORKFLOW),
      ).toThrow(/exact canonical check set/u)
    }
  })

  it('rejects SHA drift, prior workflow attempts, and replayed host run identifiers', () => {
    const ubuntu = liveEvidence('ubuntu')
    const priorAttempt = liveEvidence('windows', {
      workflow: { ...WORKFLOW, runAttempt: WORKFLOW.runAttempt - 1 },
    })
    expect(() =>
      aggregateM12ProfileSmokeEvidence(
        [serializeEvidence(priorAttempt), serializeEvidence(ubuntu)],
        WORKFLOW,
      ),
    ).toThrow(/expected workflow run attempt/u)

    expect(() =>
      aggregateM12ProfileSmokeEvidence(
        [serializeEvidence(liveEvidence('windows')), serializeEvidence(ubuntu)],
        { ...WORKFLOW, expectedGitSha: DRIFTED_GIT_SHA },
      ),
    ).toThrow(/expected workflow run attempt/u)

    expect(() =>
      aggregateM12ProfileSmokeEvidence(
        [
          serializeEvidence(liveEvidence('windows', { runId: 'replayed-run' })),
          serializeEvidence(liveEvidence('ubuntu', { runId: 'replayed-run' })),
        ],
        WORKFLOW,
      ),
    ).toThrow(/distinct one-time run identifiers/u)
  })

  it('writes a new dual-host aggregate through the CLI and refuses overwrite', async () => {
    const root = await temporaryRoot()
    const windowsPath = join(root, 'windows.json')
    const ubuntuPath = join(root, 'ubuntu.json')
    const outputPath = join(root, 'aggregate.json')
    await writeFile(windowsPath, serializeEvidence(liveEvidence('windows')), 'utf8')
    await writeFile(ubuntuPath, serializeEvidence(liveEvidence('ubuntu')), 'utf8')
    const log = vi.fn()
    const argv = [
      'aggregate',
      '--windows',
      windowsPath,
      '--ubuntu',
      ubuntuPath,
      '--expected-git-sha',
      WORKFLOW.expectedGitSha,
      '--workflow-run-id',
      WORKFLOW.runId,
      '--workflow-run-attempt',
      String(WORKFLOW.runAttempt),
      '--output',
      outputPath,
    ]

    await expect(runM12ProfileSmokeCli(argv, log)).resolves.toBe(0)
    await expect(readFile(outputPath, 'utf8')).resolves.toContain(M12_PROFILE_DUAL_SCHEMA)
    await expect(runM12ProfileSmokeCli(argv, log)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('runs both live hosts and aggregates their same-source evidence in CI', async () => {
    const workflow = await readFile(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    for (const required of [
      'pnpm test:integration',
      'pnpm validate:features',
      'pnpm check:architecture',
      'node-version: 22.19.0',
      'Canonicalize Windows temporary directory',
      'realpathSync.native(process.env.RUNNER_TEMP)',
      '"TEMP=$canonicalTemp" >> $env:GITHUB_ENV',
      '"TMP=$canonicalTemp" >> $env:GITHUB_ENV',
      'Prepare browser bridge environment',
      'uv sync --locked --no-dev --python 3.12 --project tools/browser-bridge',
      'm12-profile-smoke.mjs --live',
      'm12-profile-smoke.mjs aggregate',
      'm12-profile-smoke-Windows',
      'm12-profile-smoke-Linux',
      'm12-profile-smoke-dual',
      '--expected-git-sha ${{ github.sha }}',
      '--workflow-run-id ${{ github.run_id }}',
      '--workflow-run-attempt ${{ github.run_attempt }}',
      'm12-profile-smoke-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}',
      'm12-profile-smoke-Windows-${{ github.run_id }}-${{ github.run_attempt }}',
      'm12-profile-smoke-Linux-${{ github.run_id }}-${{ github.run_attempt }}',
    ]) {
      expect(workflow).toContain(required)
    }
    expect(workflow.match(/--expected-git-sha \$\{\{ github\.sha \}\}/gu)).toHaveLength(2)
    expect(workflow.match(/--workflow-run-id \$\{\{ github\.run_id \}\}/gu)).toHaveLength(2)
    expect(workflow.match(/--workflow-run-attempt \$\{\{ github\.run_attempt \}\}/gu)).toHaveLength(
      2,
    )
    expect(workflow.indexOf('Canonicalize Windows temporary directory')).toBeLessThan(
      workflow.indexOf('pnpm/action-setup@'),
    )
    expect(workflow.indexOf('Prepare browser bridge environment')).toBeLessThan(
      workflow.indexOf('pnpm test:integration'),
    )
    expect(workflow).not.toContain('continue-on-error')
  })
})
