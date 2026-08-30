import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserEvent, BrowserProfile, BrowserSession } from 'dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  aggregateLiveBrowserEvidence,
  inspectRuntimeBuildProvenance,
  inspectRuntimePlatform,
  LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
  LIVE_BROWSER_EVIDENCE_SCHEMA,
  LIVE_BROWSER_FEATURES,
  LIVE_BROWSER_FIXTURE_SHA256,
  LIVE_BROWSER_TASK_SHA256,
  LiveAcceptanceError,
  parseLiveBrowserEvidence,
  runLiveBrowserAcceptanceForTest,
  writeEvidenceFile,
  type AcceptanceBrowserService,
  type ChallengeServerHandle,
  type LiveBrowserChecks,
  type LiveBrowserEvidence,
  type LiveBrowserPlatformEvidence,
} from '../src/live-acceptance.js'
import { runLiveAcceptanceCli } from '../src/live-acceptance-cli.js'

const GIT_SHA = 'a'.repeat(40)
const RUNTIME_CONTENT = 'export {}\n'
const BUILD_TREE_SHA256 = createHash('sha256')
  .update('live-acceptance.js', 'utf8')
  .update('\0')
  .update(String(Buffer.byteLength(RUNTIME_CONTENT)), 'ascii')
  .update('\0')
  .update(RUNTIME_CONTENT, 'utf8')
  .digest('hex')
const NONCE = '0123456789abcdef0123456789abcdef'
const PROVIDER_SECRET = 'provider-secret-for-tests'
const CHROME_BINARY = Object.freeze({
  kind: 'chrome' as const,
  version: '140.0.7339.81',
  sha256: 'e'.repeat(64),
})
const CHROMIUM_BINARY = Object.freeze({
  kind: 'chromium' as const,
  version: '140.0.7339.80',
  sha256: 'f'.repeat(64),
})
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const PNG_MAGIC_WITH_JUNK = Buffer.concat([
  PNG.subarray(0, 8),
  Buffer.from('not-a-valid-png-structure'),
])
const temporaryDirectories = new Set<string>()

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...temporaryDirectories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      temporaryDirectories.delete(directory)
    }),
  )
})

interface FakeServiceOptions {
  readonly png?: boolean
  readonly progress?: boolean
  readonly nonce?: string
  readonly profile?: BrowserProfile
}

class FakeAcceptanceService implements AcceptanceBrowserService {
  readonly #artifactsDirectory: string
  readonly #nonce: string
  readonly #options: FakeServiceOptions
  readonly tasks: { readonly templateId: string; readonly goal: string }[] = []
  closed = false

  public constructor(artifactsDirectory: string, nonce: string, options: FakeServiceOptions = {}) {
    this.#artifactsDirectory = artifactsDirectory
    this.#nonce = nonce
    this.#options = options
  }

  public start(profile: BrowserProfile): Promise<BrowserSession> {
    const resolvedProfile =
      profile.kernel === 'chromium-headless'
        ? {
            kernel: 'chromium-headless' as const,
            headless: true,
            isolated: true,
            binary: CHROMIUM_BINARY,
          }
        : {
            kernel: 'chrome' as const,
            headless: false,
            isolated: true,
            binary: CHROME_BINARY,
          }
    return Promise.resolve({
      id: 'test-double-session',
      profile: this.#options.profile ?? resolvedProfile,
      startedAt: 1,
    })
  }

  public async *run(task: {
    readonly templateId: string
    readonly goal: string
  }): AsyncIterable<BrowserEvent> {
    this.tasks.push(task)
    if (this.#options.progress !== false) {
      yield { type: 'progress', runId: 'test-double-run', step: 1, detail: 'test double' }
    }
    const directory = join(this.#artifactsDirectory, 'test-double-run')
    const screenshot = join(directory, 'step-0001.png')
    await mkdir(directory, { recursive: true })
    await writeFile(screenshot, this.#options.png === false ? PNG_MAGIC_WITH_JUNK : PNG)
    yield { type: 'screenshot', runId: 'test-double-run', path: screenshot }
    yield {
      type: 'result',
      result: {
        runId: 'test-double-run',
        status: 'ok',
        screenshots: [screenshot],
        text: 'test double output',
        structured: { nonce: this.#options.nonce ?? this.#nonce },
        steps: 1,
        durationMs: 2,
      },
    }
  }

  public close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

describe('M11 live browser acceptance runner', (): void => {
  it('evaluates the full boundary but marks injected execution as test-only', async (): Promise<void> => {
    let service: FakeAcceptanceService | undefined
    const dependencies = await testDependencies(({ config, nonce }) => {
      service = new FakeAcceptanceService(config.artifactsDir, nonce)
      return service
    })

    const evidence = await runLiveBrowserAcceptanceForTest(liveOptions(), dependencies)

    expect(evidence.execution).toBe('test-double')
    expect(evidence.verdict).toBe('test-only')
    expect(Object.values(evidence.checks).every(Boolean)).toBe(true)
    expect(evidence.platform).toMatchObject({ target: 'windows', runtimePlatform: 'win32' })
    expect(evidence.browser.profile).toEqual({
      kernel: 'chrome',
      headless: false,
      isolated: true,
    })
    expect(evidence.browser.binary).toEqual(CHROME_BINARY)
    expect(evidence.build).toEqual({
      schemaVersion: LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
      gitSha: GIT_SHA,
      dirty: false,
      treeSha256: BUILD_TREE_SHA256,
      fileCount: 1,
    })
    expect(evidence.taskSha256).toBe(LIVE_BROWSER_TASK_SHA256)
    expect(evidence.fixtureSha256).toBe(LIVE_BROWSER_FIXTURE_SHA256)
    expect(evidence.result.progressEvents).toBe(1)
    expect(evidence.result.screenshots).toHaveLength(1)
    expect(evidence.result.screenshots[0]).toMatchObject({
      bytes: PNG.length,
      pngMagic: true,
      pngStructure: true,
    })
    expect(service?.tasks).toEqual([{ templateId: 'luban-live-acceptance-v1', goal: '' }])
    expect(service?.closed).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain(PROVIDER_SECRET)
    expect(JSON.stringify(evidence)).not.toContain(NONCE)
  })

  it('rejects missing opt-in before inspecting or creating a runtime', async (): Promise<void> => {
    const createService = vi.fn((): never => {
      throw new Error('must not create a browser')
    })
    const inspectPlatform = vi.fn(() => Promise.resolve(windowsPlatform()))
    const dependencies = await testDependencies(createService, { inspectPlatform })

    await expect(
      runLiveBrowserAcceptanceForTest(
        { repositoryRoot: process.cwd(), environment: { BROWSER_USE_API_KEY: PROVIDER_SECRET } },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'E_LIVE_OPT_IN_REQUIRED' })
    expect(inspectPlatform).not.toHaveBeenCalled()
    expect(createService).not.toHaveBeenCalled()
  })

  it('rejects a missing selected provider credential before creating a runtime', async (): Promise<void> => {
    const createService = vi.fn((): never => {
      throw new Error('must not create a browser')
    })
    const dependencies = await testDependencies(createService)

    await expect(
      runLiveBrowserAcceptanceForTest(
        { repositoryRoot: process.cwd(), environment: { LUBAN_LIVE_ACCEPTANCE: '1' } },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'E_LIVE_PROVIDER_REQUIRED' })
    expect(createService).not.toHaveBeenCalled()
  })

  it('does not treat unrelated provider credentials as Browser Use credentials', async (): Promise<void> => {
    const createService = vi.fn((): never => {
      throw new Error('must not create a browser')
    })
    const dependencies = await testDependencies(createService)

    await expect(
      runLiveBrowserAcceptanceForTest(
        {
          repositoryRoot: process.cwd(),
          environment: {
            LUBAN_LIVE_ACCEPTANCE: '1',
            OPENAI_API_KEY: PROVIDER_SECRET,
          },
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'E_LIVE_PROVIDER_REQUIRED' })
    expect(createService).not.toHaveBeenCalled()
  })

  it('rejects a forged platform before creating a runtime', async (): Promise<void> => {
    const createService = vi.fn((): never => {
      throw new Error('must not create a browser')
    })
    const dependencies = await testDependencies(createService, {
      inspectPlatform: () =>
        Promise.resolve({
          target: 'ubuntu',
          runtimePlatform: 'win32',
          arch: 'x64',
          node: 'v22.0.0',
          osReleaseId: 'ubuntu',
        }),
    })

    await expect(
      runLiveBrowserAcceptanceForTest(liveOptions(), dependencies),
    ).rejects.toMatchObject({ code: 'E_LIVE_PLATFORM' })
    expect(createService).not.toHaveBeenCalled()
  })

  it('keeps missing or invalid PNG evidence fail-closed', async (): Promise<void> => {
    const dependencies = await testDependencies(
      ({ config, nonce }) => new FakeAcceptanceService(config.artifactsDir, nonce, { png: false }),
    )

    const evidence = await runLiveBrowserAcceptanceForTest(liveOptions(), dependencies)

    expect(evidence.checks.screenshotVerified).toBe(false)
    expect(evidence.result.screenshots).toEqual([])
    expect(evidence.verdict).toBe('test-only')
  })

  it('removes its temporary directory when template creation fails', async (): Promise<void> => {
    const removeTemporaryDirectory = vi.fn((path: string) =>
      rm(path, { recursive: true, force: true }),
    )
    const createService = vi.fn((): never => {
      throw new Error('must not create a browser')
    })
    const dependencies = await testDependencies(createService, {
      writeTemplate: () => Promise.reject(new Error('injected template write failure')),
      removeTemporaryDirectory,
    })

    await expect(
      runLiveBrowserAcceptanceForTest(liveOptions(), dependencies),
    ).rejects.toMatchObject({ code: 'E_LIVE_BROWSER_RUN' })
    expect(createService).not.toHaveBeenCalled()
    expect(removeTemporaryDirectory).toHaveBeenCalledOnce()
  })

  it('closes the browser runtime before removing its temporary directory', async (): Promise<void> => {
    let runtimeClosed = false
    const dependencies = await testDependencies(({ config, nonce }) => {
      const service = new FakeAcceptanceService(config.artifactsDir, nonce)
      vi.spyOn(service, 'close').mockImplementation(async (): Promise<void> => {
        await Promise.resolve()
        runtimeClosed = true
      })
      return service
    })
    const removeTemporaryDirectory = vi.fn(async (path: string): Promise<void> => {
      if (!runtimeClosed) throw new Error('runtime still open')
      await rm(path, { recursive: true, force: true })
    })

    const evidence = await runLiveBrowserAcceptanceForTest(liveOptions(), {
      ...dependencies,
      removeTemporaryDirectory,
    })

    expect(evidence.verdict).toBe('test-only')
    expect(removeTemporaryDirectory).toHaveBeenCalledOnce()
  })

  it('rejects non-Ubuntu Linux from the actual os-release boundary', async (): Promise<void> => {
    await expect(
      inspectRuntimePlatform('linux', 'x64', 'v22.0.0', () =>
        Promise.resolve('NAME=Debian\nID=debian\n'),
      ),
    ).rejects.toMatchObject({ code: 'E_LIVE_PLATFORM' })
    await expect(
      inspectRuntimePlatform('linux', 'x64', 'v22.0.0', () =>
        Promise.resolve('NAME=Ubuntu\nID="ubuntu"\n'),
      ),
    ).resolves.toMatchObject({
      target: 'ubuntu',
      runtimePlatform: 'linux',
      osReleaseId: 'ubuntu',
    })
  })

  it('rejects an actual browser identity that contradicts the resolved kernel', async (): Promise<void> => {
    const dependencies = await testDependencies(
      ({ config, nonce }) =>
        new FakeAcceptanceService(config.artifactsDir, nonce, {
          profile: {
            kernel: 'chrome',
            headless: false,
            isolated: true,
            binary: { ...CHROME_BINARY, kind: 'edge' },
          },
        }),
    )

    await expect(
      runLiveBrowserAcceptanceForTest(liveOptions(), dependencies),
    ).rejects.toMatchObject({ code: 'E_LIVE_BROWSER_PROFILE' })
  })

  it.each([
    ['dirty worktree', { sha: GIT_SHA, dirty: true }],
    ['HEAD drift', { sha: 'b'.repeat(40), dirty: false }],
  ])('rejects post-run Git %s', async (_label, changedGit): Promise<void> => {
    const inspectGit = vi
      .fn<() => Promise<{ sha: string; dirty: boolean }>>()
      .mockResolvedValueOnce({ sha: GIT_SHA, dirty: false })
      .mockResolvedValueOnce(changedGit)
    const dependencies = await testDependencies(
      ({ config, nonce }) => new FakeAcceptanceService(config.artifactsDir, nonce),
      { inspectGit },
    )

    await expect(
      runLiveBrowserAcceptanceForTest(liveOptions(), dependencies),
    ).rejects.toMatchObject({ code: 'E_LIVE_GIT_CHANGED' })
    expect(inspectGit).toHaveBeenCalledTimes(2)
  })
})

describe('M11 runtime build provenance', (): void => {
  it('accepts only a clean matching build whose runtime module is inside the repository dist', async (): Promise<void> => {
    const fixture = await provenanceFixture({ gitSha: GIT_SHA, dirty: false })

    await expect(
      inspectRuntimeBuildProvenance(fixture.root, { sha: GIT_SHA, dirty: false }, fixture.runtime),
    ).resolves.toEqual({
      schemaVersion: LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
      gitSha: GIT_SHA,
      dirty: false,
      treeSha256: BUILD_TREE_SHA256,
      fileCount: 1,
    })
  })

  it.each([
    ['stale SHA', 'b'.repeat(40), false],
    ['dirty build', GIT_SHA, true],
  ])('rejects a %s provenance record', async (_label, gitSha, dirty): Promise<void> => {
    const fixture = await provenanceFixture({ gitSha, dirty })

    await expect(
      inspectRuntimeBuildProvenance(fixture.root, { sha: GIT_SHA, dirty: false }, fixture.runtime),
    ).rejects.toMatchObject({ code: 'E_LIVE_BUILD_PROVENANCE' })
  })

  it('rejects an installed runtime module or source seam outside the repository dist', async (): Promise<void> => {
    const fixture = await provenanceFixture({ gitSha: GIT_SHA, dirty: false })
    const outsideRuntime = join(await temporaryDirectory('luban-installed-runtime-'), 'live.js')
    await writeFile(outsideRuntime, 'export {}\n')
    const sourceDirectory = join(fixture.root, 'packages', 'dsh-luban-browser', 'src')
    await mkdir(sourceDirectory, { recursive: true })
    const sourceRuntime = join(sourceDirectory, 'live-acceptance.ts')
    await writeFile(sourceRuntime, 'export {}\n')

    for (const runtime of [outsideRuntime, sourceRuntime]) {
      await expect(
        inspectRuntimeBuildProvenance(fixture.root, { sha: GIT_SHA, dirty: false }, runtime),
      ).rejects.toMatchObject({ code: 'E_LIVE_BUILD_PROVENANCE' })
    }
  })

  it('rejects a distribution file changed after provenance was written', async (): Promise<void> => {
    const fixture = await provenanceFixture({ gitSha: GIT_SHA, dirty: false })
    await writeFile(fixture.runtime, 'export const stale = true\n')

    await expect(
      inspectRuntimeBuildProvenance(fixture.root, { sha: GIT_SHA, dirty: false }, fixture.runtime),
    ).rejects.toMatchObject({ code: 'E_LIVE_BUILD_PROVENANCE' })
  })
})

describe('M11 dual-platform evidence aggregation', (): void => {
  it('accepts only matching production attestations from Windows and Ubuntu', (): void => {
    const windows = productionEvidence('windows')
    const ubuntu = productionEvidence('ubuntu')

    const aggregate = aggregateLiveBrowserEvidence([windows, ubuntu], () => new Date(1234))

    expect(aggregate).toMatchObject({
      verdict: 'pass',
      gitSha: GIT_SHA,
      taskSha256: LIVE_BROWSER_TASK_SHA256,
      fixtureSha256: LIVE_BROWSER_FIXTURE_SHA256,
    })
    expect(aggregate.inputs.windows.runId).toBe('windows-run')
    expect(aggregate.inputs.ubuntu.runId).toBe('ubuntu-run')
  })

  it('rejects task/fixture/source hash mismatches and test-double evidence', (): void => {
    const windows = productionEvidence('windows')
    const ubuntu = productionEvidence('ubuntu')
    expect(() =>
      aggregateLiveBrowserEvidence([windows, { ...ubuntu, taskSha256: 'b'.repeat(64) }]),
    ).toThrow(
      expect.objectContaining<Partial<LiveAcceptanceError>>({ code: 'E_LIVE_EVIDENCE_MISMATCH' }),
    )
    expect(() =>
      aggregateLiveBrowserEvidence([
        { ...windows, execution: 'test-double', verdict: 'test-only' },
        ubuntu,
      ]),
    ).toThrow(
      expect.objectContaining<Partial<LiveAcceptanceError>>({ code: 'E_LIVE_EVIDENCE_NOT_LIVE' }),
    )
  })

  it('rejects a forged Ubuntu platform and missing screenshot proof', (): void => {
    const windows = productionEvidence('windows')
    const ubuntu = productionEvidence('ubuntu')
    expect(() =>
      aggregateLiveBrowserEvidence([
        windows,
        {
          ...ubuntu,
          platform: { ...ubuntu.platform, runtimePlatform: 'win32' as const },
        },
      ]),
    ).toThrow(
      expect.objectContaining<Partial<LiveAcceptanceError>>({ code: 'E_LIVE_EVIDENCE_PLATFORM' }),
    )
    expect(() =>
      aggregateLiveBrowserEvidence([
        windows,
        {
          ...ubuntu,
          result: { ...ubuntu.result, screenshots: [] },
        },
      ]),
    ).toThrow(
      expect.objectContaining<Partial<LiveAcceptanceError>>({ code: 'E_LIVE_EVIDENCE_CHECK' }),
    )
  })

  it('deeply validates canonical hashes, checks, PNG proof, and verdict provenance', (): void => {
    const evidence = productionEvidence('windows')
    const screenshot = evidence.result.screenshots[0]
    if (screenshot === undefined) throw new Error('fixture screenshot is required')
    const parsed = parseLiveBrowserEvidence(structuredClone(evidence))
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.result.screenshots)).toBe(true)

    for (const invalid of [
      { ...evidence, fixtureSha256: 'f'.repeat(64) },
      { ...evidence, providerEnvironment: 'UNTRUSTED_API_KEY' },
      { ...evidence, verdict: 'test-only' },
      { ...evidence, build: { ...evidence.build, gitSha: 'b'.repeat(40) } },
      {
        ...evidence,
        browser: {
          ...evidence.browser,
          binary: { ...evidence.browser.binary, kind: 'edge' as const },
        },
      },
      { ...evidence, checks: { ...evidence.checks, unknown: true } },
      {
        ...evidence,
        result: {
          ...evidence.result,
          screenshots: [{ ...screenshot, pngStructure: false }],
        },
      },
    ]) {
      expect(() => parseLiveBrowserEvidence(invalid)).toThrow(LiveAcceptanceError)
    }
  })

  it('exposes aggregation through the CLI without running a browser', async (): Promise<void> => {
    const directory = await temporaryDirectory('luban-live-cli-')
    const windowsPath = join(directory, 'windows.json')
    const ubuntuPath = join(directory, 'ubuntu.json')
    const outputPath = join(directory, 'dual.json')
    await Promise.all([
      writeEvidenceFile(windowsPath, productionEvidence('windows')),
      writeEvidenceFile(ubuntuPath, productionEvidence('ubuntu')),
    ])
    const output: string[] = []

    const exitCode = await runLiveAcceptanceCli(
      ['aggregate', '--windows', windowsPath, '--ubuntu', ubuntuPath, '--output', outputPath],
      { cwd: directory, environment: {}, write: (value): number => output.push(value) },
    )

    expect(exitCode).toBe(0)
    expect(JSON.parse(await readFile(outputPath, 'utf8'))).toMatchObject({ verdict: 'pass' })
    expect(output.join('')).toContain('"verdict":"pass"')
  })
})

type TestDependencies = Parameters<typeof runLiveBrowserAcceptanceForTest>[1]
type TestServiceFactory = TestDependencies['createService']

async function testDependencies(
  createService: TestServiceFactory,
  overrides: Partial<TestDependencies> = {},
): Promise<TestDependencies> {
  const directory = await temporaryDirectory('luban-live-runner-')
  return {
    inspectPlatform: () => Promise.resolve(windowsPlatform()),
    inspectGit: () => Promise.resolve({ sha: GIT_SHA, dirty: false }),
    inspectBuild: () =>
      Promise.resolve({
        schemaVersion: LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
        gitSha: GIT_SHA,
        dirty: false,
        treeSha256: BUILD_TREE_SHA256,
        fileCount: 1,
      }),
    startChallenge: () => Promise.resolve(fakeChallenge()),
    createService,
    nonce: () => NONCE,
    now: () => new Date(1234),
    makeTemporaryDirectory: () => Promise.resolve(directory),
    writeTemplate: (path, contents) => writeFile(path, contents, { encoding: 'utf8', flag: 'wx' }),
    removeTemporaryDirectory: (path) => rm(path, { recursive: true, force: true }),
    ...overrides,
  }
}

function liveOptions(): {
  readonly repositoryRoot: string
  readonly environment: NodeJS.ProcessEnv
} {
  return {
    repositoryRoot: process.cwd(),
    environment: {
      LUBAN_LIVE_ACCEPTANCE: '1',
      BROWSER_USE_API_KEY: PROVIDER_SECRET,
    },
  }
}

function windowsPlatform(): LiveBrowserPlatformEvidence {
  return {
    target: 'windows',
    runtimePlatform: 'win32',
    arch: 'x64',
    node: 'v22.0.0',
  }
}

function fakeChallenge(): ChallengeServerHandle {
  return {
    url: 'http://127.0.0.1:47631/challenge',
    snapshot: () => ({ requestCount: 1, userAgent: 'test-double-browser' }),
    close: () => Promise.resolve(),
  }
}

function allChecks(): LiveBrowserChecks {
  return {
    optIn: true,
    providerCredentialPresent: true,
    gitClean: true,
    buildProvenanceAttested: true,
    platformAttested: true,
    browserProfileResolved: true,
    browserBinaryAttested: true,
    challengeFetched: true,
    resultOk: true,
    structuredNonceMatched: true,
    progressObserved: true,
    screenshotVerified: true,
    secretFree: true,
  }
}

function productionEvidence(target: 'windows' | 'ubuntu'): LiveBrowserEvidence {
  const windows = target === 'windows'
  return {
    schemaVersion: LIVE_BROWSER_EVIDENCE_SCHEMA,
    featureIds: LIVE_BROWSER_FEATURES,
    runId: `${target}-run`,
    execution: 'production',
    verdict: 'pass',
    startedAt: new Date(1).toISOString(),
    finishedAt: new Date(2).toISOString(),
    git: { sha: GIT_SHA, dirty: false },
    build: {
      schemaVersion: LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
      gitSha: GIT_SHA,
      dirty: false,
      treeSha256: BUILD_TREE_SHA256,
      fileCount: 1,
    },
    taskSha256: LIVE_BROWSER_TASK_SHA256,
    fixtureSha256: LIVE_BROWSER_FIXTURE_SHA256,
    providerEnvironment: 'BROWSER_USE_API_KEY',
    platform: windows
      ? { target, runtimePlatform: 'win32', arch: 'x64', node: 'v22.0.0' }
      : {
          target,
          runtimePlatform: 'linux',
          arch: 'x64',
          node: 'v22.0.0',
          osReleaseId: 'ubuntu',
        },
    browser: {
      profile: windows
        ? { kernel: 'chrome', headless: false, isolated: true }
        : { kernel: 'chromium-headless', headless: true, isolated: true },
      binary: windows ? CHROME_BINARY : CHROMIUM_BINARY,
      bridgeVersion: '0.1.0',
      browserUseVersion: '0.13.8',
      python: '3.12',
      challengeUserAgentSha256: 'b'.repeat(64),
    },
    challenge: {
      requestCount: 1,
      expectedNonceSha256: 'c'.repeat(64),
      observedNonceSha256: 'c'.repeat(64),
      matched: true,
    },
    result: {
      status: 'ok',
      progressEvents: 1,
      steps: 1,
      durationMs: 1,
      screenshots: [
        {
          sha256: 'd'.repeat(64),
          bytes: PNG.length,
          pngMagic: true,
          pngStructure: true,
        },
      ],
    },
    checks: allChecks(),
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

async function provenanceFixture(provenance: {
  readonly gitSha: string
  readonly dirty: boolean
}): Promise<{ readonly root: string; readonly runtime: string }> {
  const root = await temporaryDirectory('luban-build-provenance-')
  const distribution = join(root, 'packages', 'dsh-luban-browser', 'dist')
  await mkdir(distribution, { recursive: true })
  const runtime = join(distribution, 'live-acceptance.js')
  await Promise.all([
    writeFile(runtime, RUNTIME_CONTENT),
    writeFile(
      join(distribution, 'build-provenance.json'),
      JSON.stringify({
        schemaVersion: LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
        ...provenance,
        treeSha256: BUILD_TREE_SHA256,
        fileCount: 1,
      }),
    ),
  ])
  return { root, runtime }
}
