import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generatePlugin } from '../create-plugin.mjs'
import {
  assertTargetHost,
  createThirdPartyChildEnvironment,
  dshInvocation,
  installThirdParty,
  loadVersionLock,
  resolvePackageSpecs,
} from '../install-3rd-party.mjs'
import { verifyThirdPartyProfile } from '../verify-3rd-party-install.mjs'
import { auditPackedFiles } from '../release/audit-packages.mjs'
import {
  extractChangelogSection,
  loadPolicy,
  packedManifestIssues,
  readPackedManifest,
  sha256,
} from '../release/lib.mjs'
import { releasePlan } from '../release/pack-artifacts.mjs'
import { prepareMarketEntry } from '../release/prepare-market-entry.mjs'
import { verifyArtifactManifest } from '../release/publish.mjs'
import { validateDshEngineRange, validateRepository } from '../release/validate-release.mjs'
import { createStagedDirectoryPublisher, pathIsWithin } from '../path-boundary.mjs'

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(TEST_DIR, '..', '..')
const temporaryRoots = []

async function temporaryRoot() {
  const root = await mkdtemp(join(resolve(REPOSITORY_ROOT, 'scripts'), '.m12-test-'))
  temporaryRoots.push(root)
  return root
}

async function json(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function packedManifestTarball(manifest) {
  const payload = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 'utf8')
  header.write(`${payload.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('0', 156, 'ascii')
  const padding = Buffer.alloc(Math.ceil(payload.length / 512) * 512 - payload.length)
  return gzipSync(Buffer.concat([header, payload, padding, Buffer.alloc(1024)]))
}

function registryFetcher(packages, mutate) {
  const requests = []
  let index = 0
  return {
    requests,
    fetcher: async (url, options) => {
      const record = packages[index]
      if (record === undefined) throw new Error('Unexpected registry request')
      let metadata = {
        name: record.name,
        version: record.version,
        license: record.license,
        repository: { type: 'git', url: record.repository },
        dist: { integrity: record.integrity },
        ...(record.name === 'node-pty' ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
        ...(record.name === 'dsh-better-sidebar' ? { dependencies: { 'node-pty': '^1.1.0' } } : {}),
      }
      metadata = mutate === undefined ? metadata : mutate(cloneJson(metadata), index)
      index += 1
      const body = JSON.stringify(metadata)
      requests.push({ url, options })
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(Buffer.byteLength(body)) },
        text: async () => body,
      }
    },
  }
}

function allLockedPackages(lock) {
  return [...lock.packages, ...lock.buildPackages]
}

function successfulInstallRunner(packages, buildPackages, mutate) {
  const calls = []
  const dependencies = Object.fromEntries(packages.map(({ name, version }) => [name, { version }]))
  const license = { filename: 'LICENSE', sha256: 'a'.repeat(64) }
  const report = {
    schemaVersion: 1,
    profile: 'acceptance-profile',
    installed: packages.map(({ name, version }) => ({
      name,
      version,
      bundle: true,
      license,
    })),
    build: {
      name: buildPackages[0].name,
      version: buildPackages[0].version,
      loaded: true,
      license,
    },
  }
  const outputs = [
    { status: 0, stdout: '11.24.0\n', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: JSON.stringify([{ dependencies }]), stderr: '' },
    { status: 0, stdout: packages.map(({ name }) => name).join('\n'), stderr: '' },
    { status: 0, stdout: JSON.stringify(report), stderr: '' },
  ]
  return {
    calls,
    runner: (command, args, options) => {
      const index = calls.length
      calls.push({ command, args, options })
      const output = outputs[index] ?? { status: 1, stdout: '', stderr: '' }
      return mutate === undefined ? output : mutate({ ...output }, index)
    },
  }
}

async function thirdPartyProfileFixture() {
  const lock = await loadVersionLock()
  const root = await temporaryRoot()
  const profileRoot = join(root, 'profile')
  const manifests = new Map()
  await mkdir(profileRoot, { recursive: true })
  await json(join(profileRoot, 'package.json'), {
    name: 'acceptance-profile',
    dependencies: Object.fromEntries(lock.packages.map(({ name, version }) => [name, version])),
    dsh: { profile: { bundles: lock.packages.map(({ name }) => name) } },
  })
  await writeFile(
    join(profileRoot, 'pnpm-workspace.yaml'),
    `allowBuilds:\n  node-pty@${lock.buildPackages[0].version}: true\n`,
    'utf8',
  )
  for (const record of allLockedPackages(lock)) {
    const packageRoot = join(root, 'installed', record.name.replaceAll('/', '__'))
    const manifestPath = join(packageRoot, 'package.json')
    await mkdir(packageRoot, { recursive: true })
    await json(manifestPath, {
      name: record.name,
      version: record.version,
      license: record.license,
      ...(record.name === 'node-pty' ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      ...(record.name === 'dsh-better-sidebar' ? { dependencies: { 'node-pty': '^1.1.0' } } : {}),
    })
    await writeFile(join(packageRoot, 'LICENSE'), `${record.name} MIT license\n`, 'utf8')
    manifests.set(record.name, manifestPath)
  }
  return { lock, manifests, profileRoot }
}

function runNode(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error(`${script} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('M12 plugin scaffolder', () => {
  it('defaults to a non-writing preview and refuses traversal', async () => {
    const root = await temporaryRoot()
    expect(pathIsWithin(root, join(root, '..plugins', 'sample'))).toBe(true)
    const preview = await generatePlugin({ name: 'sample', workspaceRoot: root, client: true })
    expect(preview.dryRun).toBe(true)
    expect(preview.files).toContain('src/client/index.ts')
    await expect(
      readFile(join(root, 'packages/dsh-luban-sample/package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      generatePlugin({ name: 'sample', workspaceRoot: root, output: '../outside' }),
    ).rejects.toThrow(/child of the workspace/)
  })

  it('rejects conflicting write modes without creating the requested output', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'conflicting-output')
    const result = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'scripts/create-plugin.mjs'),
        '--name',
        'sample',
        '--output',
        target,
        '--dry-run',
        '--write',
      ],
      { encoding: 'utf8', windowsHide: true },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('mutually exclusive')
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('builds a loadable rc2 lazy-CJS client and ships lifecycle tests', async () => {
    const root = await temporaryRoot()
    await writeFile(
      join(root, 'tsconfig.base.json'),
      await readFile(join(REPOSITORY_ROOT, 'tsconfig.base.json'), 'utf8'),
    )
    const result = await generatePlugin({
      name: 'sample',
      workspaceRoot: root,
      client: true,
      dryRun: false,
    })
    const packageRoot = result.target
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.exports['./client'].default).toBe('./dist/client.js')
    expect(manifest.exports['./client'].types).toBe('./dist/client/index.d.ts')

    runNode(join(REPOSITORY_ROOT, 'node_modules/tsdown/dist/run.mjs'), [], packageRoot)
    runNode(
      join(REPOSITORY_ROOT, 'node_modules/typescript/bin/tsc'),
      ['--emitDeclarationOnly', '-p', 'tsconfig.json'],
      packageRoot,
    )
    const clientTypes = join(packageRoot, 'dist/client/index.d.ts')
    expect(await readFile(clientTypes, 'utf8')).toContain('export declare function apply')
    await writeFile(
      join(packageRoot, 'client-types.probe.ts'),
      "import { apply } from 'dsh-luban-sample/client'\nvoid apply\n",
      'utf8',
    )
    runNode(
      join(REPOSITORY_ROOT, 'node_modules/typescript/bin/tsc'),
      [
        '--noEmit',
        '--ignoreConfig',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2024',
        '--strict',
        '--skipLibCheck',
        'client-types.probe.ts',
      ],
      packageRoot,
    )
    const hostProbe = runNode(
      '--input-type=module',
      [
        '--eval',
        `const plugin = await import(${JSON.stringify(manifest.name)}); process.stdout.write(JSON.stringify({ name: plugin.name, apply: typeof plugin.apply }))`,
      ],
      packageRoot,
    )
    expect(JSON.parse(hostProbe)).toEqual({ name: 'luban-sample', apply: 'function' })
    const bundle = await readFile(join(packageRoot, 'dist/client.js'), 'utf8')
    expect(bundle).toContain('window.__ModuleLoader__.load')
    expect(bundle).toContain('id: "dsh-luban-sample"')
    runNode(join(REPOSITORY_ROOT, 'node_modules/vitest/vitest.mjs'), ['run', 'tests'], packageRoot)

    const hostOnly = await generatePlugin({
      name: 'host-only',
      workspaceRoot: root,
      dryRun: false,
    })
    const hostOnlyManifest = JSON.parse(
      await readFile(join(hostOnly.target, 'package.json'), 'utf8'),
    )
    runNode(join(REPOSITORY_ROOT, 'node_modules/tsdown/dist/run.mjs'), [], hostOnly.target)
    const hostOnlyProbe = runNode(
      '--input-type=module',
      [
        '--eval',
        `const plugin = await import(${JSON.stringify(hostOnlyManifest.name)}); process.stdout.write(JSON.stringify({ name: plugin.name, apply: typeof plugin.apply }))`,
      ],
      hostOnly.target,
    )
    expect(JSON.parse(hostOnlyProbe)).toEqual({ name: 'luban-host-only', apply: 'function' })

    await expect(
      generatePlugin({ name: 'sample', workspaceRoot: root, client: true, dryRun: false }),
    ).rejects.toThrow(/overwrite/)
  }, 30_000)

  it('rejects a packages junction that would scaffold outside the workspace', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    await symlink(
      outside,
      join(root, 'packages'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(
      generatePlugin({ name: 'sample', workspaceRoot: root, dryRun: false }),
    ).rejects.toThrow(/junction|outside its configured root/u)
    await expect(access(join(outside, 'dsh-luban-sample', 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects an embedded staging junction without touching its external target', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const marker = join(outside, 'keep.txt')
    await writeFile(marker, 'keep', 'utf8')
    const publisher = await createStagedDirectoryPublisher(
      root,
      join(root, 'packages', 'dsh-luban-sample'),
      'Plugin output',
    )
    await symlink(
      outside,
      join(publisher.stagingPath, 'src'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(publisher.writeText('src/index.ts', 'unsafe')).rejects.toThrow(
      /appeared unexpectedly|junction/u,
    )
    await expect(publisher.abort()).resolves.toBe(false)
    expect(await readFile(marker, 'utf8')).toBe('keep')
    await expect(access(join(outside, 'index.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(root, 'packages', 'dsh-luban-sample'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('removes only identity-matched staging entries after a mid-generation failure', async () => {
    const root = await temporaryRoot()
    const target = join(root, 'packages', 'dsh-luban-sample')
    const publisher = await createStagedDirectoryPublisher(root, target, 'Plugin output')
    await publisher.writeText('src/index.ts', 'first')

    await expect(publisher.writeText('src/index.ts', 'duplicate')).rejects.toThrow(/overwrite/u)
    await expect(publisher.abort()).resolves.toBe(true)
    await expect(access(publisher.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('M12 install and safety plans', () => {
  it('writes create-once CLI evidence when an output path is requested', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'install-plan.json')
    const invocation = [
      join(REPOSITORY_ROOT, 'scripts/install-3rd-party.mjs'),
      '--platform',
      'windows',
      '--dry-run',
      '--output',
      output,
    ]
    const first = spawnSync(process.execPath, invocation, {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(first.status).toBe(0)
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    expect(evidence).toMatchObject({ platform: 'windows', dryRun: true })

    const second = spawnSync(process.execPath, invocation, {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(second.status).not.toBe(0)
    expect(second.stderr).toContain('EEXIST')
  })

  it('attests Ubuntu from os-release instead of accepting generic Linux', async () => {
    await expect(
      assertTargetHost('ubuntu', 'linux', async () => 'NAME=Ubuntu\nID=ubuntu\n'),
    ).resolves.toBeUndefined()
    await expect(
      assertTargetHost('ubuntu', 'linux', async () => 'NAME=Ubuntu\nID="ubuntu"\n'),
    ).resolves.toBeUndefined()
    await expect(
      assertTargetHost('ubuntu', 'linux', async () => 'NAME=Debian\nID=debian\n'),
    ).rejects.toThrow(/non-Ubuntu Linux host/u)
    await expect(
      assertTargetHost('ubuntu', 'linux', async () => 'ID=ubuntu\nID=ubuntu\n'),
    ).rejects.toThrow(/exactly one/u)
    await expect(
      assertTargetHost('ubuntu', 'linux', async () => 'ID=ubuntu\n'.repeat(10_000)),
    ).rejects.toThrow(/bounded/u)
    await expect(assertTargetHost('windows', 'win32')).resolves.toBeUndefined()
    await expect(assertTargetHost('windows', 'linux')).rejects.toThrow(/target host/u)
  })

  it('passes only an explicit non-secret environment allowlist to install children', async () => {
    const child = createThirdPartyChildEnvironment({
      targetPlatform: 'windows',
      source: {
        Path: 'C:\\Tools',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        HOME: 'C:\\Users\\operator',
        GITHUB_TOKEN: 'should-not-pass',
        NPM_TOKEN: 'should-not-pass',
        OPENAI_API_KEY: 'should-not-pass',
        NODE_OPTIONS: '--require should-not-pass.js',
        npm_config_userconfig: 'C:\\secrets\\npmrc',
        HTTPS_PROXY: 'https://user:password@example.invalid',
        LUBAN_UNREVIEWED: 'should-not-pass',
      },
      dshHome: 'C:\\isolated-dsh',
      registry: 'https://registry.npmjs.org/',
      packages: [{ name: 'example', version: '1.0.0', integrity: 'not-exported' }],
      buildPackages: [{ name: 'node-pty', version: '1.1.0', integrity: 'not-exported' }],
    })

    expect(child).toEqual({
      PATH: 'C:\\Tools',
      HOME: 'C:\\Users\\operator',
      TEMP: 'C:\\Temp',
      SystemRoot: 'C:\\Windows',
      DSH_HOME: 'C:\\isolated-dsh',
      LUBAN_THIRD_PARTY_BUILD_EXPECTED: '[{"name":"node-pty","version":"1.1.0"}]',
      LUBAN_THIRD_PARTY_EXPECTED: '[{"name":"example","version":"1.0.0"}]',
      npm_config_registry: 'https://registry.npmjs.org/',
    })
    expect(JSON.stringify(child)).not.toContain('should-not-pass')
    expect(JSON.stringify(child)).not.toContain('integrity')

    expect(() =>
      createThirdPartyChildEnvironment({
        targetPlatform: 'windows',
        source: { PATH: 'first', Path: 'second' },
        dshHome: 'C:\\isolated-dsh',
        registry: 'https://registry.npmjs.org/',
        packages: [],
        buildPackages: [],
      }),
    ).toThrow(/conflicting PATH/u)
  })

  it('resolves deterministic A-class specs and keeps installation dry by default', async () => {
    const lock = await loadVersionLock()
    expect(resolvePackageSpecs(lock)).toEqual([
      'dshmarket@1.36.0',
      'dsh-better-sidebar@0.17.1',
      '@furongjun1999/dsh-memory@0.4.0',
    ])
    expect(resolvePackageSpecs(lock, 'latest')).toEqual([
      'dshmarket@latest',
      'dsh-better-sidebar@latest',
      '@furongjun1999/dsh-memory@latest',
    ])
    let invoked = false
    let fetched = false
    const plan = await installThirdParty({
      platform: 'windows',
      fetcher: async () => {
        fetched = true
        throw new Error('dry-run must not access the registry')
      },
      runner: () => {
        invoked = true
        throw new Error('dry-run must not invoke dsh')
      },
    })
    expect(plan).toMatchObject({ profile: 'win-debug', dryRun: true })
    expect(plan.args).toEqual([
      'plugin',
      '--profile',
      'win-debug',
      'add',
      '--save-exact',
      '--allow-build=node-pty@1.1.0',
      ...plan.specs,
    ])
    expect(plan.packages).toHaveLength(3)
    expect(plan.buildPackages).toEqual([
      expect.objectContaining({ name: 'node-pty', version: '1.1.0', license: 'MIT' }),
    ])
    expect(plan.pnpmVersion).toBe('11.24.0')
    expect(plan.packages[2]).toMatchObject({
      name: '@furongjun1999/dsh-memory',
      version: '0.4.0',
      license: 'MIT',
    })
    expect(plan.supplyChain).toEqual({
      mode: 'pinned',
      verified: false,
      reason: 'dry-run does not access the registry',
    })
    expect(invoked).toBe(false)
    expect(fetched).toBe(false)
    expect(dshInvocation(plan.args, 'windows', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'dsh.cmd', ...plan.args],
    })
    expect(dshInvocation(plan.args, 'ubuntu')).toEqual({ command: 'dsh', args: plan.args })
    expect(() => dshInvocation(plan.args, 'win32')).toThrow(/windows or ubuntu/u)
  })

  it('rejects supply-chain identity and integrity tampering in the structured lock', async () => {
    const root = await temporaryRoot()
    const original = await loadVersionLock()
    const identityPath = join(root, 'identity.json')
    const identityTampered = cloneJson(original)
    identityTampered.packages[2].name = 'dsh-memory'
    await json(identityPath, identityTampered)
    await expect(loadVersionLock(identityPath)).rejects.toThrow(/identity mismatch/u)

    const repositoryPath = join(root, 'repository.json')
    const repositoryTampered = cloneJson(original)
    repositoryTampered.packages[0].repository = 'https://example.invalid/dsh-market'
    await json(repositoryPath, repositoryTampered)
    await expect(loadVersionLock(repositoryPath)).rejects.toThrow(/identity mismatch/u)

    const integrityPath = join(root, 'integrity.json')
    const integrityTampered = cloneJson(original)
    integrityTampered.packages[1].integrity = 'sha512-not-a-digest'
    await json(integrityPath, integrityTampered)
    await expect(loadVersionLock(integrityPath)).rejects.toThrow(/integrity/u)
  })

  it('binds an approved apply to the target host and child-only canonical DSH_HOME', async () => {
    const root = await temporaryRoot()
    const dshHome = resolve(root, 'acceptance-home')
    const targetPlatform = process.platform === 'win32' ? 'windows' : 'ubuntu'
    const parentDshHome = process.env.DSH_HOME
    const lock = await loadVersionLock()
    const registry = registryFetcher(allLockedPackages(lock))
    const execution = successfulInstallRunner(lock.packages, lock.buildPackages)
    vi.stubEnv('M12_SECRET_CANARY', 'must-not-reach-any-child')
    vi.stubEnv('GITHUB_TOKEN', 'must-not-reach-any-child')
    const result = await installThirdParty({
      platform: targetPlatform,
      dshHome,
      approvedBy: ' release-maintainer ',
      apply: true,
      fetcher: registry.fetcher,
      runner: execution.runner,
    })

    expect(result).toMatchObject({
      dryRun: false,
      dshHome,
      approvedBy: 'release-maintainer',
    })
    expect(execution.calls).toHaveLength(6)
    expect(execution.calls[1].command).toBe(result.invocation.command)
    expect(execution.calls[1].args).toEqual(result.invocation.args)
    expect(execution.calls[2].args).toEqual(result.invocation.args)
    expect(execution.calls[1].options).toMatchObject({
      encoding: 'utf8',
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    })
    expect(execution.calls[1].options.env.DSH_HOME).toBe(dshHome)
    expect(execution.calls[1].options.env.npm_config_registry).toBe('https://registry.npmjs.org/')
    expect(execution.calls[1].options.env.LUBAN_THIRD_PARTY_EXPECTED).not.toContain('integrity')
    expect(
      execution.calls.every(
        ({ options }) =>
          !Object.hasOwn(options.env, 'M12_SECRET_CANARY') &&
          !Object.hasOwn(options.env, 'GITHUB_TOKEN'),
      ),
    ).toBe(true)
    expect(process.env.DSH_HOME).toBe(parentDshHome)
    expect(registry.requests).toHaveLength(4)
    expect(
      registry.requests.every(({ url }) => url.startsWith('https://registry.npmjs.org/')),
    ).toBe(true)
    expect(result.supplyChain).toEqual({ mode: 'pinned', verified: true })
    expect(result.acceptance).toMatchObject({
      attempts: 2,
      configComposed: true,
      pnpmVersion: '11.24.0',
    })
  })

  it('verifies every pinned registry identity field before spawn', async () => {
    const root = await temporaryRoot()
    const dshHome = resolve(root, 'acceptance-home')
    const targetPlatform = process.platform === 'win32' ? 'windows' : 'ubuntu'
    const lock = await loadVersionLock()
    const differentIntegrity = `sha512-${Buffer.alloc(64, 0x5a).toString('base64')}`
    const cases = [
      {
        label: 'name',
        mutate: (metadata) => ({ ...metadata, name: 'substituted-package' }),
        error: /name mismatch/u,
      },
      {
        label: 'version',
        mutate: (metadata) => ({ ...metadata, version: '9.9.9' }),
        error: /version mismatch/u,
      },
      {
        label: 'license',
        mutate: (metadata) => ({ ...metadata, license: 'UNKNOWN' }),
        error: /license mismatch/u,
      },
      {
        label: 'repository',
        mutate: (metadata) => ({
          ...metadata,
          repository: { url: 'https://example.invalid/substitution.git' },
        }),
        error: /repository mismatch/u,
      },
      {
        label: 'integrity',
        mutate: (metadata) => ({ ...metadata, dist: { integrity: differentIntegrity } }),
        error: /integrity mismatch/u,
      },
    ]

    for (const testCase of cases) {
      const registry = registryFetcher(allLockedPackages(lock), (metadata, index) =>
        index === 0 ? testCase.mutate(metadata) : metadata,
      )
      let invoked = false
      await expect(
        installThirdParty({
          platform: targetPlatform,
          dshHome,
          approvedBy: 'maintainer',
          apply: true,
          fetcher: registry.fetcher,
          runner: () => {
            invoked = true
            return { status: 0 }
          },
        }),
        testCase.label,
      ).rejects.toThrow(testCase.error)
      expect(invoked, testCase.label).toBe(false)
      expect(registry.requests, testCase.label).toHaveLength(1)
    }
  })

  it('fails closed when a bundle or native-build boundary changes in the registry', async () => {
    const root = await temporaryRoot()
    const dshHome = resolve(root, 'acceptance-home')
    const targetPlatform = process.platform === 'win32' ? 'windows' : 'ubuntu'
    const lock = await loadVersionLock()
    const cases = [
      {
        label: 'bundle declaration',
        index: 0,
        mutate: (metadata) => ({ ...metadata, dsh: undefined }),
        error: /dsh\.bundle\.patch/u,
      },
      {
        label: 'native dependency',
        index: 1,
        mutate: (metadata) => ({ ...metadata, dependencies: { 'node-pty': '^2.0.0' } }),
        error: /node-pty build boundary/u,
      },
      {
        label: 'native integrity',
        index: 3,
        mutate: (metadata) => ({
          ...metadata,
          dist: { integrity: `sha512-${Buffer.alloc(64, 0x44).toString('base64')}` },
        }),
        error: /integrity mismatch/u,
      },
    ]

    for (const testCase of cases) {
      const registry = registryFetcher(allLockedPackages(lock), (metadata, index) =>
        index === testCase.index ? testCase.mutate(metadata) : metadata,
      )
      let invoked = false
      await expect(
        installThirdParty({
          platform: targetPlatform,
          dshHome,
          approvedBy: 'maintainer',
          apply: true,
          fetcher: registry.fetcher,
          runner: () => {
            invoked = true
            return { status: 0 }
          },
        }),
        testCase.label,
      ).rejects.toThrow(testCase.error)
      expect(invoked, testCase.label).toBe(false)
      expect(registry.requests, testCase.label).toHaveLength(testCase.index + 1)
    }
  })

  it('requires extra approval for latest and spawns only registry-resolved exact specs', async () => {
    const root = await temporaryRoot()
    const dshHome = resolve(root, 'acceptance-home')
    const targetPlatform = process.platform === 'win32' ? 'windows' : 'ubuntu'
    const lock = await loadVersionLock()
    let fetchedWithoutApproval = false
    await expect(
      installThirdParty({
        platform: targetPlatform,
        version: 'latest',
        dshHome,
        approvedBy: 'maintainer',
        apply: true,
        fetcher: async () => {
          fetchedWithoutApproval = true
          throw new Error('must not fetch without unpinned approval')
        },
        runner: () => {
          throw new Error('must not spawn without unpinned approval')
        },
      }),
    ).rejects.toThrow(/--approve-unpinned/u)
    expect(fetchedWithoutApproval).toBe(false)

    const versions = ['1.37.0', '0.18.0', '0.4.1']
    const registry = registryFetcher(allLockedPackages(lock), (metadata, index) =>
      index < lock.packages.length
        ? {
            ...metadata,
            version: versions[index],
            dist: { integrity: `sha512-${Buffer.alloc(64, index + 1).toString('base64')}` },
          }
        : metadata,
    )
    const resolvedPackages = lock.packages.map((record, index) => ({
      ...record,
      version: versions[index],
    }))
    const execution = successfulInstallRunner(resolvedPackages, lock.buildPackages)
    const result = await installThirdParty({
      platform: targetPlatform,
      version: 'latest',
      approveUnpinned: true,
      dshHome,
      approvedBy: 'maintainer',
      apply: true,
      fetcher: registry.fetcher,
      runner: execution.runner,
    })

    expect(result.specs).toEqual([
      'dshmarket@1.37.0',
      'dsh-better-sidebar@0.18.0',
      '@furongjun1999/dsh-memory@0.4.1',
    ])
    expect(result.specs).not.toContain(expect.stringContaining('@latest'))
    expect(result.supplyChain).toEqual({ mode: 'registry-resolved', verified: true })
    expect(execution.calls).toHaveLength(6)
    expect(execution.calls[1].args.join(' ')).not.toContain('@latest')
  })

  it('requires the reviewed pnpm and every independent post-install attestation', async () => {
    const root = await temporaryRoot()
    const dshHome = resolve(root, 'acceptance-home')
    const targetPlatform = process.platform === 'win32' ? 'windows' : 'ubuntu'
    const lock = await loadVersionLock()
    const cases = [
      {
        label: 'pnpm version',
        mutate: (output, index) => (index === 0 ? { ...output, stdout: '11.23.0\n' } : output),
        error: /pnpm 11\.24\.0 is required/u,
        calls: 1,
      },
      {
        label: 'repeat install',
        mutate: (output, index) => (index === 2 ? { ...output, status: 1 } : output),
        error: /second dsh plugin add failed/u,
        calls: 3,
      },
      {
        label: 'installed list',
        mutate: (output, index) =>
          index === 3
            ? {
                ...output,
                stdout: JSON.stringify([{ dependencies: { dshmarket: { version: '9.9.9' } } }]),
              }
            : output,
        error: /did not attest dshmarket/u,
        calls: 4,
      },
      {
        label: 'post-install verifier',
        mutate: (output, index) => (index === 5 ? { ...output, stdout: '{not-json' } : output),
        error: /invalid JSON/u,
        calls: 6,
      },
      {
        label: 'post-install verifier diagnostics',
        mutate: (output, index) =>
          index === 5 ? { ...output, status: 1, stderr: 'verifier root cause\n' } : output,
        error: /verifier root cause/u,
        calls: 6,
      },
    ]

    for (const testCase of cases) {
      const registry = registryFetcher(allLockedPackages(lock))
      const execution = successfulInstallRunner(lock.packages, lock.buildPackages, testCase.mutate)
      await expect(
        installThirdParty({
          platform: targetPlatform,
          dshHome,
          approvedBy: 'maintainer',
          apply: true,
          fetcher: registry.fetcher,
          runner: execution.runner,
        }),
        testCase.label,
      ).rejects.toThrow(testCase.error)
      expect(execution.calls, testCase.label).toHaveLength(testCase.calls)
    }
  })

  it('independently verifies the installed profile, native build, and licenses', async () => {
    const fixture = await thirdPartyProfileFixture()
    const expected = fixture.lock.packages.map(({ name, version }) => ({ name, version }))
    const buildExpected = fixture.lock.buildPackages.map(({ name, version }) => ({ name, version }))
    const dependencies = {
      loadPackage: async (name) => (name === 'node-pty' ? { spawn: () => ({}) } : {}),
      resolveManifest: async (name) => fixture.manifests.get(name),
    }
    const report = await verifyThirdPartyProfile(
      { profileRoot: fixture.profileRoot, expected, buildExpected },
      dependencies,
    )

    expect(report).toMatchObject({
      schemaVersion: 1,
      profile: 'acceptance-profile',
      build: { name: 'node-pty', version: '1.1.0', loaded: true },
    })
    expect(report.installed).toHaveLength(3)
    expect(report.installed.every(({ license }) => license.sha256.length === 64)).toBe(true)
  })

  it('locates manifests for ESM-only packages without a require export', async () => {
    const fixture = await thirdPartyProfileFixture()
    const expected = fixture.lock.packages.map(({ name, version }) => ({ name, version }))
    const buildExpected = fixture.lock.buildPackages.map(({ name, version }) => ({ name, version }))
    for (const record of allLockedPackages(fixture.lock)) {
      const sourceManifest = fixture.manifests.get(record.name)
      const packageRoot = join(fixture.profileRoot, 'node_modules', ...record.name.split('/'))
      const manifest = JSON.parse(await readFile(sourceManifest, 'utf8'))
      manifest.exports = { '.': { import: './lib/index.js' } }
      await mkdir(packageRoot, { recursive: true })
      await json(join(packageRoot, 'package.json'), manifest)
      await writeFile(join(packageRoot, 'LICENSE'), `${record.name} MIT license\n`, 'utf8')
    }

    const report = await verifyThirdPartyProfile(
      { profileRoot: fixture.profileRoot, expected, buildExpected },
      { loadPackage: async () => ({ spawn: () => ({}) }) },
    )

    expect(report.installed.map(({ name }) => name)).toEqual(expected.map(({ name }) => name))
    expect(report.build).toMatchObject({ name: 'node-pty', loaded: true })
  })

  it('rejects broad build approval, duplicate bundles, and missing license evidence', async () => {
    const fixture = await thirdPartyProfileFixture()
    const expected = fixture.lock.packages.map(({ name, version }) => ({ name, version }))
    const buildExpected = fixture.lock.buildPackages.map(({ name, version }) => ({ name, version }))
    const dependencies = {
      loadPackage: async () => ({ spawn: () => ({}) }),
      resolveManifest: async (name) => fixture.manifests.get(name),
    }
    const verify = () =>
      verifyThirdPartyProfile(
        { profileRoot: fixture.profileRoot, expected, buildExpected },
        dependencies,
      )

    await writeFile(
      join(fixture.profileRoot, 'pnpm-workspace.yaml'),
      'allowBuilds:\n  node-pty@1.1.0: true\n  node-pty: true\n',
      'utf8',
    )
    await expect(verify()).rejects.toThrow(/approve only the exact/u)

    await writeFile(
      join(fixture.profileRoot, 'pnpm-workspace.yaml'),
      'allowBuilds:\n  node-pty@1.1.0: true\n',
      'utf8',
    )
    const profile = JSON.parse(await readFile(join(fixture.profileRoot, 'package.json'), 'utf8'))
    profile.dsh.profile.bundles.push('dshmarket')
    await json(join(fixture.profileRoot, 'package.json'), profile)
    await expect(verify()).rejects.toThrow(/exactly once/u)

    profile.dsh.profile.bundles.pop()
    await json(join(fixture.profileRoot, 'package.json'), profile)
    const marketManifest = fixture.manifests.get('dshmarket')
    await rm(join(resolve(marketManifest, '..'), 'LICENSE'))
    await expect(verify()).rejects.toThrow(/no installed LICENSE/u)
  })

  it('fails before spawn on host mismatch, missing authority, or unsafe DSH_HOME', async () => {
    const root = await temporaryRoot()
    const dshHome = resolve(root, 'acceptance-home')
    const wrongTarget = process.platform === 'win32' ? 'ubuntu' : 'windows'
    let invoked = false
    const runner = () => {
      invoked = true
      return { status: 0 }
    }

    await expect(
      installThirdParty({
        platform: wrongTarget,
        dshHome,
        approvedBy: 'maintainer',
        apply: true,
        runner,
      }),
    ).rejects.toThrow(/Refusing .* installation/u)
    await expect(
      installThirdParty({
        platform: process.platform === 'win32' ? 'windows' : 'ubuntu',
        approvedBy: 'maintainer',
        apply: true,
        runner,
      }),
    ).rejects.toThrow(/--dsh-home is required/u)
    await expect(
      installThirdParty({
        platform: process.platform === 'win32' ? 'windows' : 'ubuntu',
        dshHome,
        apply: true,
        runner,
      }),
    ).rejects.toThrow(/--approved-by is required/u)
    await expect(
      installThirdParty({
        platform: process.platform === 'win32' ? 'windows' : 'ubuntu',
        dshHome: 'relative/dsh-home',
        approvedBy: 'maintainer',
        apply: true,
        runner,
      }),
    ).rejects.toThrow(/absolute path/u)
    await expect(
      installThirdParty({
        platform: process.platform === 'win32' ? 'windows' : 'ubuntu',
        dshHome: parse(dshHome).root,
        approvedBy: 'maintainer',
        apply: true,
        runner,
      }),
    ).rejects.toThrow(/filesystem root/u)
    expect(invoked).toBe(false)
  })

  it('keeps platform wrappers in preview mode and blocks incomplete apply authority', () => {
    const result =
      process.platform === 'win32'
        ? spawnSync(
            'pwsh.exe',
            [
              '-NoProfile',
              '-File',
              join(REPOSITORY_ROOT, 'scripts/install-3rd-party.ps1'),
              '-DryRun',
            ],
            { encoding: 'utf8', windowsHide: true },
          )
        : spawnSync('bash', [join(REPOSITORY_ROOT, 'scripts/install-3rd-party.sh'), '--dry-run'], {
            encoding: 'utf8',
          })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"dryRun": true')

    const blocked =
      process.platform === 'win32'
        ? spawnSync(
            'pwsh.exe',
            [
              '-NoProfile',
              '-File',
              join(REPOSITORY_ROOT, 'scripts/install-3rd-party.ps1'),
              '-Apply',
            ],
            { encoding: 'utf8', windowsHide: true },
          )
        : spawnSync('bash', [join(REPOSITORY_ROOT, 'scripts/install-3rd-party.sh'), '--apply'], {
            encoding: 'utf8',
          })
    expect(blocked.status).not.toBe(0)
    expect(`${blocked.stdout}\n${blocked.stderr}`).toMatch(/dsh-home|DshHome/u)
  }, 15_000)
})

describe('M12 release policy', () => {
  it('allows a package-specific DSH floor within the tested compatibility window', async () => {
    const policy = await loadPolicy()
    expect(validateDshEngineRange('>=0.1.1-rc.1', policy)).toBeUndefined()
    expect(validateDshEngineRange('>=0.1.1-rc.2', policy)).toBeUndefined()
    expect(validateDshEngineRange('>=0.1.1-rc.0', policy)).toMatch(/repository floor/)
    expect(validateDshEngineRange('>=0.1.1-rc.3', policy)).toMatch(/tested DSH/)
    expect(validateDshEngineRange('^0.1.1-rc.2', policy)).toMatch(/canonical/)
  })

  it('fails closed unless the tag comes from mainline and every CI-equivalent gate passes', async () => {
    const workflow = await readFile(join(REPOSITORY_ROOT, '.github/workflows/release.yml'), 'utf8')
    const validateJob = workflow.slice(0, workflow.indexOf('\n  publish:'))
    const orderedGates = [
      'git fetch --no-tags origin +refs/heads/mainline:refs/remotes/origin/mainline',
      'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/mainline',
      'astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9',
      'pnpm install --frozen-lockfile',
      'pnpm format:check',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm build',
      'pnpm test',
      'pnpm test:integration',
      'uv lock --check --project tools/browser-bridge',
      'uv run --project tools/browser-bridge --locked ruff check tools/browser-bridge/src tools/browser-bridge/tests',
      'uv run --project tools/browser-bridge --locked ruff format --check tools/browser-bridge/src tools/browser-bridge/tests',
      'uv run --project tools/browser-bridge --locked python -m unittest discover -s tools/browser-bridge/tests -v',
      'uv run --project tools/browser-bridge --locked python -m compileall -q tools/browser-bridge/src tools/browser-bridge/tests',
      'node scripts/validate-design.mjs',
      'pnpm validate:features',
      'pnpm check:architecture',
      'node scripts/release/validate-release.mjs',
      'node scripts/release/audit-packages.mjs --dry-run',
      'node scripts/install-3rd-party.mjs --platform windows --profile win-debug --dry-run',
      'node scripts/install-3rd-party.mjs --platform ubuntu --profile ubuntu-server --dry-run',
      'pack-artifacts.mjs --prepare',
    ]

    let previous = -1
    for (const gate of orderedGates) {
      const position = validateJob.indexOf(gate)
      expect(position, `${gate} must exist after the preceding release gate`).toBeGreaterThan(
        previous,
      )
      previous = position
    }

    expect(validateJob).not.toContain('continue-on-error')
    expect(validateJob).toContain('fetch-depth: 0')
    expect(validateJob).toContain("version: '0.11.8'")
    expect(validateJob).toContain('cache-dependency-glob: tools/browser-bridge/uv.lock')
    expect(workflow).not.toContain('gitleaks')
    expect(workflow).not.toContain('verify-secret-gate')
  })

  it('rejects files outside the npm payload allowlist', async () => {
    const policy = await loadPolicy()
    const manifest = {
      name: 'dsh-luban-sample',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
    }
    expect(
      auditPackedFiles(manifest, ['package.json', 'dist/index.js', 'README.md'], policy),
    ).toEqual([])
    expect(
      auditPackedFiles(manifest, ['package.json', 'dist/index.js', 'src/secret.ts'], policy),
    ).toContain('dsh-luban-sample: packed disallowed path src/secret.ts')
  })

  it('extracts exact changelog notes and enforces tag/version identity', async () => {
    const changelog =
      '# Changelog\n\n## [Unreleased]\n\nNone.\n\n## [1.2.3] - 2026-01-01\n\n- Shipped.\n\n## [1.2.2]\n\n- Old.\n'
    expect(extractChangelogSection(changelog, '1.2.3')).toContain('- Shipped.')
    const policy = await loadPolicy()
    expect(
      releasePlan('1.2.3', 'v1.2.3', [{ manifest: { name: 'x', version: '1.2.3' } }], policy).tag,
    ).toBe('v1.2.3')
    expect(() => releasePlan('1.2.3', 'v1.2.4', [], policy)).toThrow(/exactly match/)
  })

  it('validates a complete synthetic repository', async () => {
    const root = await temporaryRoot()
    const coreManifest = {
      name: 'dsh-luban-core',
      version: '1.0.0',
      description: 'Shared contracts',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      license: 'MIT',
      repository: { type: 'git', url: 'https://example.invalid/repository.git' },
      engines: { node: '^22.19.0 || >=24.0.0', dsh: '>=0.1.1-rc.1' },
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './package.json': './package.json',
      },
      files: ['dist/', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
    }
    const manifest = {
      name: 'dsh-luban-sample',
      version: '1.0.0',
      description: 'Sample',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      license: 'MIT',
      repository: { type: 'git', url: 'https://example.invalid/repository.git' },
      engines: { node: '^22.19.0 || >=24.0.0', dsh: '>=0.1.1-rc.1' },
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './cordis.patch.yml': './cordis.patch.yml',
        './package.json': './package.json',
      },
      files: ['dist/', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    await json(join(root, 'package.json'), { name: 'fixture', version: '1.0.0', private: true })
    await json(join(root, 'packages/core/package.json'), coreManifest)
    await json(join(root, 'packages/sample/package.json'), manifest)
    await writeFile(
      join(root, 'README.md'),
      '# Fixture\n\n## 项目定位\n\nWindows and Ubuntu.\n\n## 文档导航\n\nDocs.\n\n## 快速开始\n\nStart.\n\n## 许可\n\nMIT.\n',
    )
    await writeFile(
      join(root, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\nNone.\n\n## [1.0.0] - 2026-01-01\n\nInitial.\n',
    )
    await writeFile(
      join(root, 'packages/core/README.md'),
      '# Core\n\n## Compatibility\n\nDSH 0.1.1-rc.2.\n\n## License\n\nMIT.\n',
    )
    await writeFile(
      join(root, 'packages/sample/README.md'),
      '# Sample\n\n## 功能亮点\n\nOne.\n\n## 安装\n\nInstall.\n\n## 配置\n\nNone.\n\n## 演示\n\nDemo.\n\n## 兼容性\n\nDSH 0.1.1-rc.2.\n\n## 平台支持\n\nBoth.\n\n## License 与致谢\n\nMIT.\n',
    )
    const result = await validateRepository(root)
    expect(result.issues).toEqual([])
    expect(result.packages).toEqual(['dsh-luban-core', 'dsh-luban-sample'])

    await json(join(root, 'packages/core/package.json'), {
      ...coreManifest,
      name: ['@luban', 'core'].join('/'),
    })
    expect((await validateRepository(root)).issues).toContain(
      'core: package name must be dsh-luban-core',
    )
  })

  it('verifies immutable artifact hashes before any publish', async () => {
    const root = await temporaryRoot()
    const artifacts = join(root, '.release-artifacts')
    await mkdir(artifacts)
    await json(join(root, 'package.json'), { name: 'fixture', version: '1.0.0', private: true })
    const samplePayload = packedManifestTarball({ name: 'sample', version: '1.0.0' })
    const corePayload = packedManifestTarball({ name: 'dsh-luban-core', version: '1.0.0' })
    await writeFile(join(artifacts, 'sample.tgz'), samplePayload)
    await writeFile(join(artifacts, 'core.tgz'), corePayload)
    await json(join(artifacts, 'release-manifest.json'), {
      schemaVersion: 1,
      version: '1.0.0',
      tag: 'v1.0.0',
      packages: [
        {
          name: 'sample',
          version: '1.0.0',
          file: 'sample.tgz',
          sha256: sha256(samplePayload),
        },
        {
          name: 'dsh-luban-core',
          version: '1.0.0',
          file: 'core.tgz',
          sha256: sha256(corePayload),
        },
      ],
    })
    await expect(
      verifyArtifactManifest(root, artifacts, ['dsh-luban-core', 'sample']),
    ).resolves.toMatchObject({
      tag: 'v1.0.0',
      packages: [{ name: 'dsh-luban-core' }, { name: 'sample' }],
    })
    await expect(verifyArtifactManifest(root, artifacts, ['unexpected'])).rejects.toThrow(
      /do not match/,
    )
    await writeFile(join(artifacts, 'sample.tgz'), 'changed')
    await expect(verifyArtifactManifest(root, artifacts)).rejects.toThrow(/checksum/)
  })

  it('reads the packed manifest and rejects unpublished workspace dependency ranges', () => {
    const payload = packedManifestTarball({
      name: 'sample',
      version: '1.0.0',
      dependencies: { 'dsh-luban-core': 'workspace:^' },
    })
    const manifest = readPackedManifest(payload)
    expect(manifest.name).toBe('sample')
    expect(packedManifestIssues({ name: 'sample', version: '1.0.0' }, manifest)).toContain(
      'sample: packed dependencies.dsh-luban-core retains workspace:^',
    )
    expect(
      packedManifestIssues(
        { name: 'sample', version: '1.0.0' },
        { ...manifest, dependencies: { 'dsh-luban-core': '^1.0.0' } },
      ),
    ).toEqual([])
    expect(() => readPackedManifest(Buffer.from('not a tarball'))).toThrow(/gzip tarball/)
  })
})

describe('M12 manual market boundary', () => {
  async function marketFixture(overrides = {}) {
    const root = await temporaryRoot()
    await json(join(root, 'packages/dsh-luban-sample/package.json'), {
      name: 'dsh-luban-sample',
      version: '1.0.0',
      description: 'Sample plugin',
      repository: {
        type: 'git',
        url: 'git+https://github.com/yin52133/dsh-luban.git',
        directory: 'packages/dsh-luban-sample',
      },
      engines: { dsh: '>=0.1.1-rc.1' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      ...overrides,
    })
    return root
  }

  it('previews the current upstream monorepo YAML schema without writing', async () => {
    const root = await marketFixture()
    const preview = await prepareMarketEntry({
      root,
      package: 'dsh-luban-sample',
      category: 'dev',
      descriptionZh: '示例插件',
    })
    expect(preview.dryRun).toBe(true)
    expect(preview.filename).toBe('yin52133__dsh-luban--packages-dsh-luban-sample.yml')
    expect(preview.entry).toEqual({
      url: 'https://github.com/yin52133/dsh-luban/tree/mainline/packages/dsh-luban-sample',
      name: 'yin52133/dsh-luban#dsh-luban-sample',
      category: 'dev',
      description: { en: 'Sample plugin.', zh: '示例插件.' },
    })
    expect(preview.content).toBe(
      [
        'url: https://github.com/yin52133/dsh-luban/tree/mainline/packages/dsh-luban-sample',
        'name: yin52133/dsh-luban#dsh-luban-sample',
        'category: dev',
        'description:',
        '  en: "Sample plugin."',
        '  zh: "示例插件."',
        '',
      ].join('\n'),
    )
    await expect(access(join(root, preview.filename))).rejects.toThrow()
  })

  it('requires explicit named approval and the canonical output filename', async () => {
    const root = await marketFixture()
    const filename = 'yin52133__dsh-luban--packages-dsh-luban-sample.yml'
    await expect(
      prepareMarketEntry({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        approve: true,
        output: filename,
      }),
    ).rejects.toThrow(/approved-by/)
    await expect(
      prepareMarketEntry({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        approve: true,
        approvedBy: 'maintainer',
        output: 'entry.yml',
      }),
    ).rejects.toThrow(/filename/)
    const written = await prepareMarketEntry({
      root,
      package: 'dsh-luban-sample',
      category: 'dev',
      approve: true,
      approvedBy: 'maintainer',
      output: filename,
    })
    expect(written.dryRun).toBe(false)
    expect(await readFile(join(root, filename), 'utf8')).toContain('category: dev')
    await expect(
      prepareMarketEntry({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        approve: true,
        approvedBy: 'maintainer',
        output: filename,
      }),
    ).rejects.toThrow()
  })

  it('rejects entries that the upstream submission gate cannot accept', async () => {
    const root = await marketFixture()
    await expect(
      prepareMarketEntry({ root, package: 'dsh-luban-sample', category: 'developer-tools' }),
    ).rejects.toThrow(/category/)
    await expect(
      prepareMarketEntry({
        root,
        package: 'dsh-luban-sample',
        category: 'dev',
        branch: 'feature/market',
      }),
    ).rejects.toThrow(/branch/)

    const noBundle = await marketFixture({ dsh: { client: { platform: 'web' } } })
    await expect(
      prepareMarketEntry({ root: noBundle, package: 'dsh-luban-sample', category: 'dev' }),
    ).rejects.toThrow(/not an installable/u)

    const wrongHost = await marketFixture({
      repository: {
        url: 'https://example.invalid/yin52133/dsh-luban.git',
        directory: 'packages/dsh-luban-sample',
      },
    })
    await expect(
      prepareMarketEntry({ root: wrongHost, package: 'dsh-luban-sample', category: 'dev' }),
    ).rejects.toThrow(/GitHub/)

    const credentialed = await marketFixture({
      repository: {
        url: 'https://token@github.com/yin52133/dsh-luban.git',
        directory: 'packages/dsh-luban-sample',
      },
    })
    await expect(
      prepareMarketEntry({ root: credentialed, package: 'dsh-luban-sample', category: 'dev' }),
    ).rejects.toThrow(/credential-free/)

    const nonDefaultPort = await marketFixture({
      repository: {
        url: 'https://github.com:8443/yin52133/dsh-luban.git',
        directory: 'packages/dsh-luban-sample',
      },
    })
    await expect(
      prepareMarketEntry({
        root: nonDefaultPort,
        package: 'dsh-luban-sample',
        category: 'dev',
      }),
    ).rejects.toThrow(/credential-free/)

    const wrongDirectory = await marketFixture({
      repository: {
        url: 'https://github.com/yin52133/dsh-luban.git',
        directory: 'packages/another-plugin',
      },
    })
    await expect(
      prepareMarketEntry({ root: wrongDirectory, package: 'dsh-luban-sample', category: 'dev' }),
    ).rejects.toThrow(/directory/)

    const multiline = await marketFixture({ description: 'Line one\nLine two' })
    await expect(
      prepareMarketEntry({ root: multiline, package: 'dsh-luban-sample', category: 'dev' }),
    ).rejects.toThrow(/one non-empty line/)
  })
})
