import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generatePlugin } from '../create-plugin.mjs'
import {
  dshInvocation,
  installThirdParty,
  loadVersionLock,
  resolvePackageSpecs,
} from '../install-3rd-party.mjs'
import { auditPackedFiles } from '../release/audit-packages.mjs'
import { gitleaksInvocation } from '../release/security-scan.mjs'
import { extractChangelogSection, loadPolicy, sha256 } from '../release/lib.mjs'
import { releasePlan } from '../release/pack-artifacts.mjs'
import { prepareMarketEntry } from '../release/prepare-market-entry.mjs'
import { verifyArtifactManifest } from '../release/publish.mjs'
import { validateDshEngineRange, validateRepository } from '../release/validate-release.mjs'
import { secretGatePlan } from '../release/verify-secret-gate.mjs'

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
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('M12 plugin scaffolder', () => {
  it('defaults to a non-writing preview and refuses traversal', async () => {
    const root = await temporaryRoot()
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

    runNode(join(REPOSITORY_ROOT, 'node_modules/tsdown/dist/run.mjs'), [], packageRoot)
    runNode(
      join(REPOSITORY_ROOT, 'node_modules/typescript/bin/tsc'),
      ['--emitDeclarationOnly', '-p', 'tsconfig.json'],
      packageRoot,
    )
    const bundle = await readFile(join(packageRoot, 'dist/client.js'), 'utf8')
    expect(bundle).toContain('window.__ModuleLoader__.load')
    expect(bundle).toContain('id: "dsh-luban-sample"')
    runNode(join(REPOSITORY_ROOT, 'node_modules/vitest/vitest.mjs'), ['run', 'tests'], packageRoot)

    await expect(
      generatePlugin({ name: 'sample', workspaceRoot: root, client: true, dryRun: false }),
    ).rejects.toThrow(/overwrite/)
  }, 30_000)
})

describe('M12 install and safety plans', () => {
  it('resolves deterministic A-class specs and keeps installation dry by default', async () => {
    const lock = await loadVersionLock()
    expect(resolvePackageSpecs(lock)).toEqual([
      'dshmarket@1.36.0',
      'dsh-better-sidebar@0.17.1',
      'dsh-memory@0.1.0',
    ])
    expect(resolvePackageSpecs(lock, 'latest')).toEqual([
      'dshmarket@latest',
      'dsh-better-sidebar@latest',
      'dsh-memory@latest',
    ])
    const plan = await installThirdParty({ platform: 'windows' })
    expect(plan).toMatchObject({ profile: 'win-debug', dryRun: true })
    expect(plan.args).toEqual(['plugin', '--profile', 'win-debug', 'add', ...plan.specs])
    expect(dshInvocation(plan.args, 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'dsh.cmd', ...plan.args],
    })
    expect(dshInvocation(plan.args, 'linux')).toEqual({ command: 'dsh', args: plan.args })
  })

  it('keeps platform wrappers in preview mode unless apply is explicit', () => {
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
  })

  it('builds a read-only gitleaks command', () => {
    const args = gitleaksInvocation(REPOSITORY_ROOT)
    expect(args[0]).toBe('git')
    expect(args).toContain('--redact')
    expect(args.join(' ')).toContain('.gitleaks.toml')
    expect(secretGatePlan()).toMatchObject({ expectedExitCode: 1, dryRun: true })
  })
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
      'gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e',
      'astral-sh/setup-uv@c771a70e6277c0a99b617c7a806ffedaca235ff9',
      '"$RUNNER_TEMP/gitleaks" git "$GITHUB_WORKSPACE"',
      'scripts/release/verify-secret-gate.mjs --verify --binary',
      'pnpm install --frozen-lockfile',
      'pnpm format:check',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm build',
      'pnpm test',
      'uv lock --check --project tools/browser-bridge',
      'uv run --project tools/browser-bridge --locked ruff check tools/browser-bridge/src tools/browser-bridge/tests',
      'uv run --project tools/browser-bridge --locked ruff format --check tools/browser-bridge/src tools/browser-bridge/tests',
      'uv run --project tools/browser-bridge --locked python -m unittest discover -s tools/browser-bridge/tests -v',
      'uv run --project tools/browser-bridge --locked python -m compileall -q tools/browser-bridge/src tools/browser-bridge/tests',
      'node scripts/validate-design.mjs',
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
    expect(workflow).toContain('GITLEAKS_VERSION: 8.30.1')
    expect(workflow).toContain(
      'gitleaks" git "$GITHUB_WORKSPACE" --config "$GITHUB_WORKSPACE/.gitleaks.toml"',
    )
    expect(workflow).toContain('551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb')
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
      join(root, 'packages/sample/README.md'),
      '# Sample\n\n## 功能亮点\n\nOne.\n\n## 安装\n\nInstall.\n\n## 配置\n\nNone.\n\n## 演示\n\nDemo.\n\n## 兼容性\n\nDSH 0.1.1-rc.2.\n\n## 平台支持\n\nBoth.\n\n## License 与致谢\n\nMIT.\n',
    )
    const result = await validateRepository(root)
    expect(result.issues).toEqual([])
  })

  it('verifies immutable artifact hashes before any publish', async () => {
    const root = await temporaryRoot()
    const artifacts = join(root, '.release-artifacts')
    await mkdir(artifacts)
    await json(join(root, 'package.json'), { name: 'fixture', version: '1.0.0', private: true })
    const payload = Buffer.from('immutable tarball')
    await writeFile(join(artifacts, 'sample.tgz'), payload)
    await json(join(artifacts, 'release-manifest.json'), {
      schemaVersion: 1,
      version: '1.0.0',
      tag: 'v1.0.0',
      packages: [{ name: 'sample', version: '1.0.0', file: 'sample.tgz', sha256: sha256(payload) }],
    })
    await expect(verifyArtifactManifest(root, artifacts, ['sample'])).resolves.toMatchObject({
      tag: 'v1.0.0',
    })
    await expect(verifyArtifactManifest(root, artifacts, ['unexpected'])).rejects.toThrow(
      /do not match/,
    )
    await writeFile(join(artifacts, 'sample.tgz'), 'changed')
    await expect(verifyArtifactManifest(root, artifacts)).rejects.toThrow(/checksum/)
  })
})

describe('M12 manual market boundary', () => {
  it('previews locally and requires explicit named approval before writing', async () => {
    const root = await temporaryRoot()
    await json(join(root, 'packages/sample/package.json'), {
      name: 'dsh-luban-sample',
      version: '1.0.0',
      description: 'Sample plugin',
      repository: { url: 'https://example.invalid/sample.git' },
      engines: { dsh: '>=0.1.1-rc.1' },
    })
    const preview = await prepareMarketEntry({ root, package: 'dsh-luban-sample' })
    expect(preview.dryRun).toBe(true)
    expect(preview.content).toContain('not an upstream schema declaration')
    await expect(
      prepareMarketEntry({ root, package: 'dsh-luban-sample', approve: true, output: 'entry.md' }),
    ).rejects.toThrow(/approved-by/)
    const written = await prepareMarketEntry({
      root,
      package: 'dsh-luban-sample',
      approve: true,
      approvedBy: 'maintainer',
      output: 'entry.md',
    })
    expect(written.dryRun).toBe(false)
    expect(await readFile(join(root, 'entry.md'), 'utf8')).toContain('maintainer')
  })
})
