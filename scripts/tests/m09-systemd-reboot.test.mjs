import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createM09ChildEnvironment,
  runM09SystemdRebootAcceptance,
} from '../acceptance/m09-systemd-reboot.mjs'

const roots = new Set()
const MACHINE = 'a'.repeat(64)
const HOSTNAME = 'b'.repeat(64)
const GIT_HEAD = 'c'.repeat(40)
const RUNNER_SHA = 'd'.repeat(64)
const UNIT_SHA = '1'.repeat(64)
const BOOT_ONE = '11111111-1111-4111-8111-111111111111'
const BOOT_TWO = '22222222-2222-4222-8222-222222222222'
const BUILD_INPUT_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/acceptance/m09-pnpm-trust.json',
  'tsconfig.base.json',
  'packages/core/package.json',
  'packages/core/src/index.ts',
  'packages/core/tsconfig.json',
  'packages/core/tsdown.config.ts',
  'packages/dsh-luban-server-mode/package.json',
  'packages/dsh-luban-server-mode/src/operator-cli.ts',
  'packages/dsh-luban-server-mode/src/process-runner.ts',
  'packages/dsh-luban-server-mode/src/systemd.ts',
  'packages/dsh-luban-server-mode/tsconfig.json',
  'packages/dsh-luban-server-mode/tsdown.config.ts',
]
const FRESH_BUILD_PATHS = [
  'packages/core/dist/index.js',
  'packages/dsh-luban-server-mode/dist/operator-cli.js',
]
const TEST_TOOL_ROOT = join(tmpdir(), 'm09-tools')
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const execFileAsync = promisify(execFile)

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function manifest(kind, paths, seed) {
  const files = [...paths]
    .sort()
    .map((path, index) => ({ path, sha256: String((seed + index) % 10).repeat(64) }))
  return { kind, files, sha256: hash(JSON.stringify(files)) }
}

function sourceIdentity() {
  const buildInputs = manifest('head-build-inputs', BUILD_INPUT_PATHS, 4)
  const trustManifest = buildInputs.files.find(
    (entry) => entry.path === 'scripts/acceptance/m09-pnpm-trust.json',
  )
  return {
    gitHead: GIT_HEAD,
    runnerSha256: RUNNER_SHA,
    operatorRuntime: manifest(
      'complete-runtime-closure',
      [
        'packages/core/dist/index.js',
        'packages/core/package.json',
        'packages/dsh-luban-server-mode/dist/operator-cli.js',
        'packages/dsh-luban-server-mode/dist/process-runner-build.js',
        'packages/dsh-luban-server-mode/dist/systemd-build.js',
        'packages/dsh-luban-server-mode/package.json',
      ],
      2,
    ),
    buildInputs,
    freshBuild: manifest('fresh-head-build-javascript', FRESH_BUILD_PATHS, 6),
    toolchain: {
      gitPath: join(TEST_TOOL_ROOT, 'git'),
      installMode: 'pnpm-frozen-offline-ignore-scripts-copy-v1',
      loginctlPath: join(TEST_TOOL_ROOT, 'loginctl'),
      nodePath: join(TEST_TOOL_ROOT, 'node'),
      nodeVersion: 'v22.19.0',
      packageManager: 'pnpm@11.24.0',
      pnpmEntryPath: join(TEST_TOOL_ROOT, 'pnpm', 'bin', 'pnpm.cjs'),
      pnpmEntrySha256: 'e'.repeat(64),
      pnpmRootPath: join(TEST_TOOL_ROOT, 'pnpm'),
      pnpmRuntimeFiles: 455,
      pnpmRuntimeSha256: 'f'.repeat(64),
      pnpmRuntimeUnpackedSize: 20_095_957,
      pnpmTarballIntegrity:
        'sha512-vSfjRel23LC+C3oSKCF7BJqBfiGx81XJDb59xGZxiVqLwebQbCRVRQXqk+oLRfSJon7Bv7yN5qlln8oPFvoAAA==',
      pnpmTrustManifestSha256: trustManifest.sha256,
      pnpmVersion: '11.24.0',
      storePath: join(tmpdir(), 'm09-pnpm-store'),
      systemctlPath: join(TEST_TOOL_ROOT, 'systemctl'),
      tsdownVersion: '0.22.14',
    },
  }
}

async function temporaryRun() {
  const root = join(tmpdir(), `m09-systemd-acceptance-${randomUUID()}`)
  roots.add(root)
  await mkdir(root, { mode: 0o700 })
  return { root, runDir: join(root, 'run'), unitPath: join(root, 'dsh-luban.service') }
}

async function provenanceWorkspaceClone(options = {}) {
  const root = join(dirname(REPOSITORY_ROOT), `.m09-systemd-tool-pollution-${randomUUID()}`)
  const repository = join(root, 'repository')
  roots.add(root)
  await mkdir(root, { mode: 0o700 })
  await execFileAsync(
    'git',
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
      'clone',
      '--quiet',
      '--no-hardlinks',
      REPOSITORY_ROOT,
      repository,
    ],
    { cwd: REPOSITORY_ROOT, timeout: 30_000, windowsHide: true },
  )

  const runnerPath = join(repository, 'scripts', 'acceptance', 'm09-systemd-reboot.mjs')
  await mkdir(dirname(runnerPath), { recursive: true })
  await copyFile(
    join(REPOSITORY_ROOT, 'scripts', 'acceptance', 'm09-systemd-reboot.mjs'),
    runnerPath,
  )
  await copyFile(
    join(REPOSITORY_ROOT, 'scripts', 'acceptance', 'm09-pnpm-trust.json'),
    join(repository, 'scripts', 'acceptance', 'm09-pnpm-trust.json'),
  )
  await execFileAsync(
    'git',
    [
      'add',
      '--',
      'scripts/acceptance/m09-systemd-reboot.mjs',
      'scripts/acceptance/m09-pnpm-trust.json',
    ],
    { cwd: repository, timeout: 30_000, windowsHide: true },
  )
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=M09 Fixture',
      '-c',
      'user.email=m09-fixture.invalid',
      '-c',
      `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      'commit',
      '--quiet',
      '-m',
      'test: add M09 runner fixture',
    ],
    { cwd: repository, timeout: 30_000, windowsHide: true },
  )
  for (const packageName of ['core', 'dsh-luban-server-mode']) {
    await cp(
      join(REPOSITORY_ROOT, 'packages', packageName, 'dist'),
      join(repository, 'packages', packageName, 'dist'),
      { recursive: true },
    )
  }

  const operatorPath = join(
    repository,
    'packages',
    'dsh-luban-server-mode',
    'dist',
    'operator-cli.js',
  )
  if (options.tamperDist === true) {
    await writeFile(operatorPath, `${await readFile(operatorPath, 'utf8')}\n// polluted-dist\n`)
  }

  const markerPath = join(repository, 'workspace-tool-used.txt')
  if (options.fakeWorkspaceTool === true) {
    const fakeToolRoot = join(repository, 'node_modules', 'tsdown')
    await mkdir(join(fakeToolRoot, 'dist'), { recursive: true })
    await writeFile(
      join(fakeToolRoot, 'package.json'),
      `${JSON.stringify({ name: 'tsdown', version: '0.22.14', type: 'module' })}\n`,
    )
    await writeFile(
      join(fakeToolRoot, 'dist', 'run.mjs'),
      `import { cp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const packageName = basename(process.cwd())
await writeFile(join(repository, 'workspace-tool-used.txt'), 'used')
await rm(join(process.cwd(), 'dist'), { recursive: true, force: true })
await cp(join(repository, 'packages', packageName, 'dist'), join(process.cwd(), 'dist'), { recursive: true })
`,
    )
  }

  const serverNodeModules = join(repository, 'packages', 'dsh-luban-server-mode', 'node_modules')
  await mkdir(serverNodeModules, { recursive: true })
  await symlink(
    join(repository, 'packages', 'core'),
    join(serverNodeModules, 'dsh-luban-core'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return { markerPath, repository, runnerPath }
}

async function forgedPathPnpm(repository) {
  const root = dirname(repository)
  const binRoot = join(root, 'forged-pnpm-bin')
  const packageRoot = join(binRoot, 'node_modules', 'pnpm')
  const markerPath = join(root, 'forged-path-pnpm-used.txt')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: 'pnpm', version: '11.24.0', type: 'module' })}\n`,
  )
  await writeFile(
    join(packageRoot, 'bin', 'pnpm.mjs'),
    `import { cp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
if (process.argv.includes('--version')) {
  process.stdout.write('11.24.0\\n')
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const repository = join(root, 'repository')
  const packageName = basename(process.cwd())
  await writeFile(join(root, 'forged-path-pnpm-used.txt'), 'used')
  await rm(join(process.cwd(), 'dist'), { recursive: true, force: true })
  await cp(join(repository, 'packages', packageName, 'dist'), join(process.cwd(), 'dist'), { recursive: true })
}
`,
  )
  const launcher = join(binRoot, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  await writeFile(
    launcher,
    process.platform === 'win32' ? '@echo off\r\nexit /b 99\r\n' : '#!/bin/sh\nexit 99\n',
    { mode: 0o755 },
  )
  return { binRoot, markerPath }
}

function parsed(result) {
  return JSON.parse(result.output)
}

function fakeOperator(unitPath, options = {}) {
  const calls = []
  let installed = false
  let partial = false
  let partialUninstallPending = options.partialUninstallOnce === true
  let bootId = BOOT_ONE
  let mainPid = 700
  let invocationId = 'a'.repeat(32)
  let activeEnterTimestampMonotonic = 100
  let sessionTimestampMonotonic = 200
  let earliestSessionTimestampMonotonic = 200
  let source = sourceIdentity()
  let machineIdSha256 = MACHINE
  let ownership = {
    unitPath,
    sha256: UNIT_SHA,
    device: '10',
    inode: '20',
    size: 512,
  }

  const status = () => ({
    schemaVersion: 1,
    service: 'dsh-luban.service',
    user: 'builder',
    unitPath,
    linger: 'enabled',
    unit: installed ? 'exact' : 'missing',
    enabled: installed ? (partial ? 'disabled' : 'enabled') : 'not-found',
    active: installed && !partial ? 'active' : 'inactive',
  })

  return {
    calls,
    reboot(options = {}) {
      bootId = BOOT_TWO
      if (options.reusePid !== true) mainPid = 800
      invocationId = 'b'.repeat(32)
      activeEnterTimestampMonotonic = 300
      sessionTimestampMonotonic = 600
      earliestSessionTimestampMonotonic = 600
    },
    setBootId(value) {
      bootId = value
    },
    setLoginTimestamp(value) {
      sessionTimestampMonotonic = value
      earliestSessionTimestampMonotonic = value
    },
    setEarliestLoginTimestamp(value) {
      earliestSessionTimestampMonotonic = value
    },
    driftSource() {
      source = { ...source, gitHead: '9'.repeat(40) }
    },
    driftRuntime() {
      const files = source.operatorRuntime.files.map((entry, index) =>
        index === 2 ? { ...entry, sha256: '8'.repeat(64) } : entry,
      )
      source = {
        ...source,
        operatorRuntime: { ...source.operatorRuntime, files, sha256: hash(JSON.stringify(files)) },
      }
    },
    driftBuildInput() {
      const files = source.buildInputs.files.map((entry, index) =>
        index === 2 ? { ...entry, sha256: '7'.repeat(64) } : entry,
      )
      source = {
        ...source,
        buildInputs: { ...source.buildInputs, files, sha256: hash(JSON.stringify(files)) },
      }
    },
    driftMachine() {
      machineIdSha256 = '8'.repeat(64)
    },
    driftOwnership() {
      ownership = { ...ownership, inode: '21' }
    },
    isInstalled() {
      return installed
    },
    operator: {
      async source() {
        calls.push('source')
        return source
      },
      async host() {
        calls.push('host')
        return {
          machineIdSha256,
          hostnameSha256: HOSTNAME,
          bootId,
          ubuntuVersion: '24.04',
          user: 'builder',
          uid: 1_000,
          linger: 'yes',
        }
      },
      async cli({ command, apply, user }) {
        calls.push(`cli:${command}:${apply ? 'apply' : 'read'}`)
        if (options.throwSecret === command) throw new Error('secret stdout token=do-not-leak')
        if (command === 'preflight') {
          return {
            exitCode: 0,
            envelope: {
              schemaVersion: 1,
              ok: true,
              command,
              mode: 'read-only',
              preflight: {
                schemaVersion: 1,
                service: 'dsh-luban.service',
                user,
                unitPath,
                linger: 'enabled',
                unit: installed ? 'exact' : 'missing',
                ready: true,
              },
            },
          }
        }
        if (command === 'status') {
          return {
            exitCode: 0,
            envelope: {
              schemaVersion: 1,
              ok: true,
              command,
              mode: 'read-only',
              status: status(),
            },
          }
        }
        if (command === 'install') {
          installed = true
          partial = false
        }
        if (command === 'uninstall') {
          if (partialUninstallPending) {
            partialUninstallPending = false
            partial = true
            throw new Error('injected partial uninstall')
          }
          installed = false
          partial = false
        }
        return {
          exitCode: 0,
          envelope: {
            schemaVersion: 1,
            ok: true,
            command,
            mode: 'apply',
            service: 'dsh-luban.service',
            user,
            applied: true,
          },
        }
      },
      async serviceProperties() {
        calls.push('properties')
        if (!installed) {
          return {
            id: 'dsh-luban.service',
            invocationId: '',
            loadState: 'not-found',
            fragmentPath: '',
            dropInPaths: '',
            needDaemonReload: 'no',
            unitFileState: 'not-found',
            activeState: 'inactive',
            subState: 'dead',
            mainPid: 0,
            type: '',
            activeEnterTimestampMonotonic: 0,
            environment: '',
          }
        }
        return {
          id: 'dsh-luban.service',
          invocationId,
          loadState: 'loaded',
          fragmentPath: unitPath,
          dropInPaths: options.invalidAfterInstall ? '/tmp/foreign.conf' : '',
          needDaemonReload: 'no',
          unitFileState: 'enabled',
          activeState: 'active',
          subState: 'running',
          mainPid,
          type: 'exec',
          activeEnterTimestampMonotonic,
          environment: 'PATH=/usr/bin LUBAN_BOOT_RESTORE=1',
        }
      },
      async unitOwnership() {
        calls.push('ownership')
        return ownership
      },
      async currentSession() {
        calls.push('session')
        return {
          earliestTimestampMonotonic: earliestSessionTimestampMonotonic,
          id: '42',
          user: 'builder',
          uid: 1_000,
          timestampMonotonic: sessionTimestampMonotonic,
        }
      },
    },
  }
}

function dependencies(fake, clock) {
  return { platform: 'linux', operator: fake.operator, now: clock.now }
}

async function runStage(command, paths, deps) {
  return await runM09SystemdRebootAcceptance([command, '--apply', '--run-dir', paths.runDir], deps)
}

async function reachArmed(paths, fake, clock) {
  const deps = dependencies(fake, clock)
  expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)
  expect((await runStage('install', paths, deps)).exitCode).toBe(0)
  expect((await runStage('arm-reboot', paths, deps)).exitCode).toBe(0)
  return deps
}

async function evidenceFiles(runDir) {
  return (await readdir(join(runDir, 'evidence'))).sort()
}

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { recursive: true, force: true })
      roots.delete(root)
    }),
  )
})

describe('M09 Ubuntu systemd staged reboot acceptance', () => {
  it('fresh-builds HEAD and binds the operator, all build JavaScript, and complete inputs', async () => {
    const fixture = await provenanceWorkspaceClone()
    const isolatedModule = await import(
      `${pathToFileURL(fixture.runnerPath).href}?baseline=${randomUUID()}`
    )
    const provenance = await isolatedModule.inspectM09OperatorRuntimeProvenance()

    expect(provenance.operatorRuntime.kind).toBe('complete-runtime-closure')
    expect(provenance.operatorRuntime.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'packages/core/dist/index.js',
        'packages/core/package.json',
        'packages/dsh-luban-server-mode/dist/operator-cli.js',
        'packages/dsh-luban-server-mode/package.json',
      ]),
    )
    expect(
      provenance.operatorRuntime.files.some((entry) =>
        /\/dist\/process-runner-[a-zA-Z0-9_-]+\.js$/u.test(entry.path),
      ),
    ).toBe(true)
    expect(
      provenance.operatorRuntime.files.some((entry) =>
        /\/dist\/systemd-[a-zA-Z0-9_-]+\.js$/u.test(entry.path),
      ),
    ).toBe(true)
    expect(provenance.buildInputs.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(BUILD_INPUT_PATHS),
    )
    expect(provenance.freshBuild.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        'packages/core/dist/index.js',
        'packages/dsh-luban-server-mode/dist/operator-cli.js',
      ]),
    )
    expect(provenance.buildToolchain).toMatchObject({
      installMode: 'pnpm-frozen-offline-ignore-scripts-copy-v1',
      packageManager: 'pnpm@11.24.0',
      pnpmEntrySha256: 'ff3224d46b47fbb24a7e9fe15fededef7e00892d07d4e376b6762d4899906bfd',
      pnpmRuntimeFiles: 455,
      pnpmRuntimeSha256: 'ae41ae90778f9f2ad79fee5ab06d7bcfab0838491540129a8886a628d8e24dac',
      pnpmRuntimeUnpackedSize: 20_095_957,
      pnpmTarballIntegrity:
        'sha512-vSfjRel23LC+C3oSKCF7BJqBfiGx81XJDb59xGZxiVqLwebQbCRVRQXqk+oLRfSJon7Bv7yN5qlln8oPFvoAAA==',
      pnpmVersion: '11.24.0',
    })
    expect(provenance.buildToolchain.pnpmRootPath).not.toContain(REPOSITORY_ROOT)
    expect(provenance.buildToolchain.pnpmRuntimeFiles).toBeGreaterThan(0)
  }, 120_000)

  it('rejects joint workspace build-tool and ignored-dist pollution', async () => {
    const contaminated = await provenanceWorkspaceClone({
      fakeWorkspaceTool: true,
      tamperDist: true,
    })
    const isolatedModule = await import(
      `${pathToFileURL(contaminated.runnerPath).href}?pollution=${randomUUID()}`
    )

    await expect(isolatedModule.inspectM09OperatorRuntimeProvenance()).rejects.toMatchObject({
      code: 'E_PROVENANCE_MISMATCH',
    })
    await expect(access(contaminated.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('rejects a self-identifying forged pnpm at the front of PATH before install', async () => {
    const fixture = await provenanceWorkspaceClone({ tamperDist: true })
    const forged = await forgedPathPnpm(fixture.repository)
    const isolatedModule = await import(
      `${pathToFileURL(fixture.runnerPath).href}?forged-pnpm=${randomUUID()}`
    )
    const originalPath = process.env.PATH
    process.env.PATH = `${forged.binRoot}${delimiter}${originalPath ?? ''}`
    try {
      await expect(isolatedModule.inspectM09OperatorRuntimeProvenance()).rejects.toMatchObject({
        code: 'E_PACKAGE_MANAGER_TRUST',
      })
    } finally {
      process.env.PATH = originalPath
    }
    await expect(access(forged.markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('defaults every non-applied command to a zero-write plan', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = dependencies(fake, { now: () => 1_000 })

    const defaultPlan = await runM09SystemdRebootAcceptance([], deps)
    const installPlan = await runM09SystemdRebootAcceptance(
      ['install', '--run-dir', paths.runDir],
      deps,
    )

    expect(defaultPlan.exitCode).toBe(0)
    expect(parsed(defaultPlan)).toMatchObject({ mode: 'plan', acceptancePassed: false })
    expect(parsed(installPlan)).toMatchObject({
      mode: 'plan',
      requestedStage: 'install',
      safety: {
        evidenceWritten: false,
        lingerChanged: false,
        rebootCommandExecuted: false,
        systemdMutationExecuted: false,
      },
    })
    expect(fake.calls).toHaveLength(0)
    await expect(access(paths.runDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('builds a minimal secret-free child environment and rejects Node/Git injection', () => {
    const environment = createM09ChildEnvironment(
      {
        HOME: '/home/builder',
        XDG_RUNTIME_DIR: '/run/user/1000',
        GH_TOKEN: 'must-not-propagate',
        LUBAN_SESSION_COOKIE: 'must-not-propagate',
        npm_config_userconfig: '/tmp/credential-bearing-npmrc',
      },
      '/trusted/bin:/usr/bin',
      'linux',
    )

    expect(environment).toMatchObject({
      HOME: '/home/builder',
      PATH: '/trusted/bin:/usr/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
    })
    expect(environment).not.toHaveProperty('GH_TOKEN')
    expect(environment).not.toHaveProperty('LUBAN_SESSION_COOKIE')
    expect(environment).not.toHaveProperty('npm_config_userconfig')
    expect(() =>
      createM09ChildEnvironment({ NODE_OPTIONS: '--import=/tmp/evil.mjs' }, '/usr/bin', 'linux'),
    ).toThrow('prerequisites')
    expect(() =>
      createM09ChildEnvironment({ GIT_WORK_TREE: '/tmp/other' }, '/usr/bin', 'linux'),
    ).toThrow('prerequisites')
  })

  it('runs the full simulated chain without ever promoting acceptance', async () => {
    const paths = await temporaryRun()
    let instant = 1_000
    const clock = { now: () => instant++ }
    const fake = fakeOperator(paths.unitPath)
    const deps = await reachArmed(paths, fake, clock)

    fake.reboot()
    const verified = await runStage('verify-reboot', paths, deps)
    expect(verified.exitCode).toBe(0)
    expect(parsed(verified)).toMatchObject({
      evidenceKind: 'simulated',
      stage: 'reboot-verified',
      acceptancePassed: false,
      safety: {
        lingerChanged: false,
        rebootCommandExecuted: false,
        logoutCommandExecuted: false,
        disconnectCommandExecuted: false,
      },
    })

    const cleaned = await runStage('cleanup', paths, deps)
    expect(cleaned.exitCode).toBe(0)
    expect(parsed(cleaned)).toMatchObject({ stage: 'cleaned', acceptancePassed: false })
    expect(fake.isInstalled()).toBe(false)
    expect(await evidenceFiles(paths.runDir)).toEqual([
      '0001-preflight-verified.json',
      '0002-install-attempted.json',
      '0003-installed.json',
      '0004-reboot-armed.json',
      '0005-reboot-verified.json',
      '0006-cleanup-attempted.json',
      '0007-cleaned.json',
    ])

    const callsBeforeRetry = fake.calls.length
    const retry = await runStage('cleanup', paths, deps)
    expect(parsed(retry)).toMatchObject({ stage: 'cleaned', idempotent: true })
    expect(fake.calls).toHaveLength(callsBeforeRetry)
  })

  it('recovers an install whose confirmed evidence commit failed after the side effect', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    let failConfirmed = true
    const deps = {
      ...dependencies(fake, { now: () => 1_500 }),
      async beforeEvidenceCommit(stage) {
        if (stage === 'installed' && failConfirmed) throw new Error('injected commit fault')
      },
    }
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)

    const interrupted = await runStage('install', paths, deps)
    expect(interrupted.exitCode).toBe(1)
    expect(fake.isInstalled()).toBe(true)
    expect(await evidenceFiles(paths.runDir)).toEqual([
      '0001-preflight-verified.json',
      '0002-install-attempted.json',
    ])

    failConfirmed = false
    const recovered = await runStage('install', paths, deps)
    expect(recovered.exitCode).toBe(0)
    expect(parsed(recovered)).toMatchObject({ stage: 'installed', acceptancePassed: false })
    const confirmed = JSON.parse(
      await readFile(join(paths.runDir, 'evidence', '0003-installed.json'), 'utf8'),
    )
    expect(confirmed.operation).toMatchObject({ phase: 'confirmed', recovered: true })
    expect(fake.calls.filter((call) => call === 'cli:install:apply')).toHaveLength(1)
  })

  it('recovers cleanup after uninstall completed but confirmed evidence commit failed', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    let failConfirmed = false
    const deps = {
      ...dependencies(fake, { now: () => 1_750 }),
      async beforeEvidenceCommit(stage) {
        if (stage === 'cleaned' && failConfirmed) throw new Error('injected commit fault')
      },
    }
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)
    expect((await runStage('install', paths, deps)).exitCode).toBe(0)
    expect((await runStage('arm-reboot', paths, deps)).exitCode).toBe(0)
    fake.reboot()
    expect((await runStage('verify-reboot', paths, deps)).exitCode).toBe(0)

    failConfirmed = true
    const interrupted = await runStage('cleanup', paths, deps)
    expect(interrupted.exitCode).toBe(1)
    expect(fake.isInstalled()).toBe(false)
    expect(await evidenceFiles(paths.runDir)).toHaveLength(6)

    failConfirmed = false
    const recovered = await runStage('cleanup', paths, deps)
    expect(recovered.exitCode).toBe(0)
    const confirmed = JSON.parse(
      await readFile(join(paths.runDir, 'evidence', '0007-cleaned.json'), 'utf8'),
    )
    expect(confirmed.operation).toMatchObject({ phase: 'confirmed', recovered: true })
    expect(fake.calls.filter((call) => call === 'cli:uninstall:apply')).toHaveLength(1)
  })

  it('reconciles an exact owned unit left partially disabled by cleanup', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath, { partialUninstallOnce: true })
    const deps = await reachArmed(paths, fake, { now: () => 1_800 })
    fake.reboot()
    expect((await runStage('verify-reboot', paths, deps)).exitCode).toBe(0)

    const interrupted = await runStage('cleanup', paths, deps)
    expect(interrupted.exitCode).toBe(1)
    expect(fake.isInstalled()).toBe(true)
    expect(await evidenceFiles(paths.runDir)).toHaveLength(6)

    const recovered = await runStage('cleanup', paths, deps)
    expect(recovered.exitCode).toBe(0)
    expect(fake.isInstalled()).toBe(false)
    expect(fake.calls.filter((call) => call === 'cli:uninstall:apply')).toHaveLength(2)
  })

  it('accepts a reused numeric PID only when the boot and InvocationID changed', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = await reachArmed(paths, fake, { now: () => 1_900 })
    fake.reboot({ reusePid: true })

    const result = await runStage('verify-reboot', paths, deps)

    expect(result.exitCode).toBe(0)
    expect(parsed(result)).toMatchObject({ stage: 'reboot-verified', acceptancePassed: false })
  })

  it('rejects a same-boot verification and leaves the armed chain intact', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 2_000 }
    const fake = fakeOperator(paths.unitPath)
    const deps = await reachArmed(paths, fake, clock)

    const result = await runStage('verify-reboot', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_UNAVAILABLE')
    expect(await evidenceFiles(paths.runDir)).toHaveLength(4)
  })

  it('fails closed unless service activation predates the current login session', async () => {
    const paths = await temporaryRun()
    const clock = { now: () => 3_000 }
    const fake = fakeOperator(paths.unitPath)
    const deps = await reachArmed(paths, fake, clock)
    fake.reboot()
    fake.setLoginTimestamp(300)

    const result = await runStage('verify-reboot', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_UNAVAILABLE')
    expect(await evidenceFiles(paths.runDir)).toHaveLength(4)
  })

  it('uses the earliest current-boot login instead of a later operator-selected session', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = await reachArmed(paths, fake, { now: () => 3_500 })
    fake.reboot()
    fake.setEarliestLoginTimestamp(250)

    const result = await runStage('verify-reboot', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_UNAVAILABLE')
    expect(await evidenceFiles(paths.runDir)).toHaveLength(4)
  })

  it.each([
    ['source', (fake) => fake.driftSource()],
    ['machine', (fake) => fake.driftMachine()],
  ])('rejects %s identity drift between stages', async (_label, drift) => {
    const paths = await temporaryRun()
    const clock = { now: () => 4_000 }
    const fake = fakeOperator(paths.unitPath)
    const deps = dependencies(fake, clock)
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)
    drift(fake)

    const result = await runStage('install', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_UNAVAILABLE')
    expect(fake.isInstalled()).toBe(false)
    expect(await evidenceFiles(paths.runDir)).toHaveLength(1)
  })

  it.each([
    ['imported runtime chunk', (fake) => fake.driftRuntime()],
    ['tracked build input', (fake) => fake.driftBuildInput()],
  ])('rejects %s drift even when Git HEAD is unchanged', async (_label, drift) => {
    const paths = await temporaryRun()
    const clock = { now: () => 4_500 }
    const fake = fakeOperator(paths.unitPath)
    const deps = dependencies(fake, clock)
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)
    drift(fake)

    const result = await runStage('install', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_UNAVAILABLE')
    expect(fake.isInstalled()).toBe(false)
    expect(await evidenceFiles(paths.runDir)).toHaveLength(1)
  })

  it('enforces stage order and requires --apply plus an explicit run directory', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = dependencies(fake, { now: () => 5_000 })
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)

    const outOfOrder = await runStage('arm-reboot', paths, deps)
    const missingDirectory = await runM09SystemdRebootAcceptance(['install', '--apply'], deps)
    const invalidPlanApply = await runM09SystemdRebootAcceptance(['plan', '--apply'], deps)

    expect(parsed(outOfOrder).error.code).toBe('E_STAGE_ORDER')
    expect(parsed(missingDirectory).error.code).toBe('E_INVALID_INPUT')
    expect(parsed(invalidPlanApply).error.code).toBe('E_INVALID_INPUT')
    expect(fake.isInstalled()).toBe(false)
  })

  it('rolls back through the production mutation boundary when post-install checks fail', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath, { invalidAfterInstall: true })
    const deps = dependencies(fake, { now: () => 6_000 })
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)

    const result = await runStage('install', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_UNAVAILABLE')
    expect(fake.calls).toContain('cli:install:apply')
    expect(fake.calls).toContain('cli:uninstall:apply')
    expect(fake.isInstalled()).toBe(false)
    expect(await evidenceFiles(paths.runDir)).toHaveLength(2)
  })

  it('refuses cleanup when the evidence-owned unit identity changed', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = await reachArmed(paths, fake, { now: () => 7_000 })
    fake.reboot()
    expect((await runStage('verify-reboot', paths, deps)).exitCode).toBe(0)
    fake.driftOwnership()

    const result = await runStage('cleanup', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_OWNERSHIP')
    expect(fake.isInstalled()).toBe(true)
    expect(fake.calls.filter((call) => call === 'cli:uninstall:apply')).toHaveLength(0)
  })

  it('detects an unexpected evidence entry as tampering', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = dependencies(fake, { now: () => 8_000 })
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)
    await writeFile(join(paths.runDir, 'evidence', 'foreign.json'), '{}\n')

    const result = await runStage('install', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_EVIDENCE_INVALID')
    expect(fake.isInstalled()).toBe(false)
  })

  it('rejects oversized evidence before invoking an operator', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = dependencies(fake, { now: () => 9_000 })
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)
    const calls = fake.calls.length
    await writeFile(join(paths.runDir, 'owner.json'), 'x'.repeat(128 * 1024 + 1))

    const result = await runStage('install', paths, deps)

    expect(result.exitCode).toBe(1)
    expect(parsed(result).error.code).toBe('E_EVIDENCE_INVALID')
    expect(fake.calls).toHaveLength(calls)
  })

  it('redacts unexpected operator errors and rejects non-Linux execution', async () => {
    const paths = await temporaryRun()
    const leaking = fakeOperator(paths.unitPath, { throwSecret: 'preflight' })
    const failure = await runStage('preflight', paths, dependencies(leaking, { now: () => 10_000 }))
    expect(failure.output).not.toContain('secret')
    expect(parsed(failure).error.code).toBe('E_UNAVAILABLE')

    const unsupported = await runM09SystemdRebootAcceptance(
      ['preflight', '--apply', '--run-dir', paths.runDir],
      { platform: 'win32', operator: leaking.operator, now: () => 10_000 },
    )
    expect(parsed(unsupported).error.code).toBe('E_PLATFORM_UNSUPPORTED')
  })

  it('keeps the source and previous-evidence hashes in the retained chain', async () => {
    const paths = await temporaryRun()
    const fake = fakeOperator(paths.unitPath)
    const deps = dependencies(fake, { now: () => 11_000 })
    expect((await runStage('preflight', paths, deps)).exitCode).toBe(0)
    expect((await runStage('install', paths, deps)).exitCode).toBe(0)

    const owner = JSON.parse(await readFile(join(paths.runDir, 'owner.json'), 'utf8'))
    const second = JSON.parse(
      await readFile(join(paths.runDir, 'evidence', '0003-installed.json'), 'utf8'),
    )
    expect(owner.binding.source).toEqual(sourceIdentity())
    expect(second.previousSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(second.snapshot.properties).toMatchObject({
      loadState: 'loaded',
      dropInPaths: '',
      needDaemonReload: 'no',
      type: 'exec',
      mainPid: 700,
      environment: 'PATH=/usr/bin LUBAN_BOOT_RESTORE=1',
    })
  })
})
