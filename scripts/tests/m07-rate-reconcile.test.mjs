import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { URL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertNoSuspiciousCredentialFields,
  createM07CaptureChallenge,
  createM07GitEnvironment,
  extractProviderRateWindow,
  fetchMountedHudRateCapture,
  inspectM07GitState,
  inspectM07BuildProvenance,
  inspectM07RuntimePlatform,
  inspectM07RuntimeArtifact,
  inspectM07SourceProvenance,
  m07EvidenceKind,
  readM07BoundedFile,
  readM07BoundedResponseBody,
  readExternalRateExport,
  requiredM07BoundaryCode,
  requiresM07FunctionalBoundary,
  runM07RateReconciliation,
  runM07RateReconciliationCli,
  validateM07HudUrl,
  validateMountedHudCapture,
  writeM07RateEvidence,
} from '../acceptance/m07-rate-reconcile.mjs'

const directories = new Set()
const GIT_SHA = 'a'.repeat(40)
const DRIFTED_GIT_SHA = 'b'.repeat(40)
const WINDOW = Object.freeze({
  startUtc: '2026-08-30T00:00:00.000Z',
  endUtc: '2026-08-30T00:01:00.000Z',
})
const CHALLENGE = 'capture_challenge_0123456789abcdef'
const TRACKED_SOURCE_PATHS = Object.freeze([
  'scripts/acceptance/m07-rate-reconcile.mjs',
  'packages/dsh-luban-hud/package.json',
  'packages/dsh-luban-hud/scripts/build.mjs',
  'packages/dsh-luban-hud/tsdown.config.ts',
  'packages/dsh-luban-hud/src/build-provenance.ts',
  'packages/dsh-luban-hud/src/rate-reconcile.ts',
  'packages/dsh-luban-hud/src/rate-ledger.ts',
  'packages/dsh-luban-hud/src/provider-request-identity.ts',
  'packages/dsh-luban-hud/src/rate-window.ts',
  'packages/dsh-luban-hud/src/runtime-artifact.ts',
  'packages/dsh-luban-hud/src/dsh-telemetry.ts',
  'packages/dsh-luban-hud/src/http-api.ts',
  'packages/dsh-luban-hud/src/index.ts',
  'packages/core/src/contracts.ts',
])
const WINDOWS_PLATFORM = Object.freeze({
  target: 'windows',
  runtimePlatform: 'win32',
  arch: 'x64',
  node: 'v22.19.0',
})
const RUNTIME_ENTRYPOINT = Buffer.from('export const runtime = true\n', 'utf8')
const RUNTIME_FILE = Object.freeze({
  relativePath: 'dist/index.js',
  sha256: createHash('sha256').update(RUNTIME_ENTRYPOINT).digest('hex'),
  bytes: RUNTIME_ENTRYPOINT.length,
})
const RUNTIME_ARTIFACT = Object.freeze({
  schemaVersion: 'dsh-luban/m07-hud-runtime-artifact/v1',
  packageName: 'dsh-luban-hud',
  packageVersion: '0.1.0',
  entrypoint: 'dist/index.js',
  files: Object.freeze([RUNTIME_FILE]),
  bundleSha256: createHash('sha256')
    .update(`${RUNTIME_FILE.relativePath}\0${RUNTIME_FILE.sha256}\0${String(RUNTIME_FILE.bytes)}\n`)
    .digest('hex'),
})
const BUILD_ID = '12345678-1234-4123-8123-123456789abc'
const BUILD_MANIFEST = Object.freeze({
  schemaVersion: 'dsh-luban/hud-build-provenance/v1',
  gitHead: GIT_SHA,
  buildId: BUILD_ID,
  dirty: false,
  artifacts: Object.freeze([
    Object.freeze({ path: 'index.js', sha256: RUNTIME_FILE.sha256, bytes: RUNTIME_FILE.bytes }),
  ]),
})
const BUILD_MANIFEST_BYTES = Buffer.from(`${JSON.stringify(BUILD_MANIFEST)}\n`, 'utf8')
const BUILD_PROVENANCE = Object.freeze({
  schemaVersion: 'dsh-luban/hud-build-provenance/v1',
  gitHead: GIT_SHA,
  buildId: BUILD_ID,
  dirty: false,
  runtime: 'repo-dist',
  manifestSha256: createHash('sha256').update(BUILD_MANIFEST_BYTES).digest('hex'),
  runtimeBundleSha256: RUNTIME_ARTIFACT.bundleSha256,
})

async function temporaryRoot(prefix = 'luban-m07-rate-test-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  directories.add(root)
  return root
}

function reconciliation(origins = 'live') {
  const live = origins === 'live'
  const zeroDelta = Object.freeze({
    hud: 1,
    provider: 1,
    absolute: 0,
    relative: 0,
    withinTolerance: true,
  })
  return Object.freeze({
    status: 'pass',
    sources: Object.freeze({
      hud: Object.freeze({ origin: live ? 'live-hud-events' : 'fixture', recordCount: 1 }),
      provider: Object.freeze({
        origin: live ? 'real-provider-export' : 'fixture',
        provider: 'provider-one',
        recordCount: 1,
      }),
    }),
    window: Object.freeze({
      startUtc: '2026-08-30T00:00:00.000Z',
      endUtc: '2026-08-30T00:01:00.000Z',
      durationMs: 60_000,
    }),
    totals: Object.freeze({
      hud: Object.freeze({
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        unknownTokens: 0,
        totalTokens: 150,
      }),
      provider: Object.freeze({
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        unknownTokens: 0,
        totalTokens: 150,
      }),
    }),
    deltas: Object.freeze({
      requestCount: zeroDelta,
      inputTokens: zeroDelta,
      outputTokens: zeroDelta,
      cacheReadTokens: zeroDelta,
      cacheWriteTokens: zeroDelta,
      unknownTokens: zeroDelta,
      totalTokens: zeroDelta,
    }),
    tolerance: Object.freeze({ requestCountRelative: 0, tokenRelative: 0.05 }),
  })
}

function liveOptions(root) {
  return {
    root,
    live: true,
    runId: 'rate-live-run',
    providerExportConfirmed: true,
    hudExport: 'external-hud.json',
    providerExport: 'external-provider.json',
  }
}

function mountedLiveOptions(root) {
  return {
    root,
    live: true,
    runId: 'rate-mounted-run',
    providerExportConfirmed: true,
    hudUrl: 'http://127.0.0.1:42600',
    providerExport: 'external-provider.json',
  }
}

function usage() {
  return {
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    unknownTokens: 0,
  }
}

function rateRecord() {
  return {
    id: 'provider-request-1',
    occurredAt: '2026-08-30T00:00:30.000Z',
    requestCount: 1,
    usage: usage(),
  }
}

function providerExport() {
  return {
    schemaVersion: 'dsh-luban/m07-provider-rate-export/v1',
    source: {
      kind: 'provider-billing-export',
      origin: 'real-provider-export',
      provider: 'provider-one',
      exportedAt: '2026-08-30T00:02:00.000Z',
    },
    window: { ...WINDOW },
    records: [rateRecord()],
  }
}

function mountedCapture(challenge = CHALLENGE) {
  const exportedAt = '2026-08-30T00:02:00.000Z'
  const challengeSha256 = createHash('sha256').update(challenge).digest('hex')
  return {
    schemaVersion: 'dsh-luban/m07-hud-rate-capture/v4',
    source: {
      kind: 'mounted-hud-capture',
      exportedAt,
      coverageStartUtc: '2026-08-29T23:59:00.000Z',
      processId: 1234,
      nodeVersion: 'v22.19.0',
      challengeSha256,
      runtimeArtifact: RUNTIME_ARTIFACT,
      build: BUILD_PROVENANCE,
    },
    export: {
      schemaVersion: 'dsh-luban/m07-hud-rate-export/v1',
      source: { kind: 'hud-event-export', origin: 'live-hud-events', exportedAt },
      window: { ...WINDOW },
      records: [rateRecord()],
    },
    captures: [
      {
        id: 'provider-request-1',
        sessionId: 'session-1',
        eventSeq: 1,
        turn: 1,
        step: 1,
        messageId: 'message-1',
        provider: 'provider-one',
        model: 'model/one',
        providerRequest: {
          schemaVersion: 'dsh-luban/provider-request-identity-evidence/v1',
          adapter: {
            id: 'provider-wire-test',
            version: '1.0.0',
            runtimeSha256: 'a'.repeat(64),
          },
          binding: {
            sessionIdSha256: createHash('sha256').update('session-1').digest('hex'),
            assistantEventSeq: 1,
            turn: 1,
            step: 1,
            assistantMessageIdSha256: createHash('sha256').update('message-1').digest('hex'),
            provider: 'provider-one',
            model: 'model/one',
            challengeSha256,
          },
          providerRequestIdSha256: createHash('sha256').update('provider-request-1').digest('hex'),
        },
      },
    ],
  }
}

function mountedInput() {
  const capture = mountedCapture()
  const providerRequest = capture.captures[0].providerRequest
  return Object.freeze({
    sha256: 'c'.repeat(64),
    bytes: 512,
    value: capture.export,
    capture: Object.freeze({
      schemaVersion: capture.schemaVersion,
      sourceKind: capture.source.kind,
      coverageStartUtc: capture.source.coverageStartUtc,
      exportedAt: capture.source.exportedAt,
      challengeSha256: capture.source.challengeSha256,
      runtimeArtifact: capture.source.runtimeArtifact,
      build: capture.source.build,
      providerRequestIdentity: Object.freeze({
        adapter: Object.freeze({ ...providerRequest.adapter }),
        count: 1,
        bindingsSha256: createHash('sha256')
          .update(providerRequest.providerRequestIdSha256)
          .digest('hex'),
      }),
    }),
  })
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function gitBlob(raw, algorithm = 'sha1') {
  const bytes = Buffer.from(raw)
  return createHash(algorithm)
    .update(Buffer.from(`blob ${String(bytes.length)}\0`, 'utf8'))
    .update(bytes)
    .digest('hex')
}

function input(label, value = { schemaVersion: `${label}-schema` }) {
  return Object.freeze({
    canonicalPath: `C:\\external\\${label}.json`,
    sha256: label === 'HUD' ? 'c'.repeat(64) : 'd'.repeat(64),
    bytes: 128,
    value,
  })
}

function passingDependencies(overrides = {}) {
  return {
    inspectPlatform: async () => WINDOWS_PLATFORM,
    readInput: async (_root, _path, label) => input(label),
    reconcile: async () => reconciliation(),
    ...overrides,
  }
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

describe('M07 rate reconciliation acceptance runner', () => {
  it('defaults to a read-only plan without inspecting inputs or Git', async () => {
    const root = await temporaryRoot()
    const inspectGit = vi.fn()
    const readInput = vi.fn()
    const result = await runM07RateReconciliation(
      { root, runId: 'rate-plan-run' },
      { inspectGit, readInput },
    )

    expect(result).toMatchObject({
      featureId: 'M07-F004',
      requestedMode: 'plan',
      writes: 'none',
      status: 'planned',
      evidenceKind: 'none',
      acceptancePassed: false,
    })
    expect(inspectGit).not.toHaveBeenCalled()
    expect(readInput).not.toHaveBeenCalled()
  })

  it('never promotes injected reconciliation data to live evidence', async () => {
    const root = await temporaryRoot()
    const result = await runM07RateReconciliation(liveOptions(root), passingDependencies())

    expect(result).toMatchObject({
      execution: 'test-double',
      evidenceKind: 'simulated',
      status: 'simulated',
      acceptancePassed: false,
      git: null,
      source: null,
      inputs: {
        hud: { sha256: 'c'.repeat(64), origin: 'live-hud-events' },
        provider: { sha256: 'd'.repeat(64), origin: 'real-provider-export' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('external-hud.json')
    expect(JSON.stringify(result)).not.toContain('external-provider.json')
  })

  it('reads the provider window before requesting mounted HUD capture and stays simulated', async () => {
    const root = await temporaryRoot()
    const order = []
    const readInput = vi.fn(async (_repository, _path, label) => {
      order.push(`${label}-read`)
      return input(label, providerExport())
    })
    const extractWindow = vi.fn((value) => {
      order.push('provider-window')
      return extractProviderRateWindow(value)
    })
    const createChallenge = vi.fn(() => {
      order.push('challenge')
      return CHALLENGE
    })
    const fetchHudCapture = vi.fn(async (_url, window, challenge) => {
      order.push('hud-fetch')
      expect(window).toEqual(WINDOW)
      expect(challenge).toBe(CHALLENGE)
      return mountedInput()
    })
    const result = await runM07RateReconciliation(
      mountedLiveOptions(root),
      passingDependencies({
        readInput,
        extractProviderWindow: extractWindow,
        createChallenge,
        fetchHudCapture,
      }),
    )

    expect(order).toEqual(['provider-read', 'provider-window', 'challenge', 'hud-fetch'])
    expect(readInput).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      execution: 'test-double',
      evidenceKind: 'simulated',
      status: 'simulated',
      acceptancePassed: false,
      inputs: {
        hud: {
          transport: 'authenticated-loopback-http',
          capture: {
            sourceKind: 'mounted-hud-capture',
            challengeSha256: createHash('sha256').update(CHALLENGE).digest('hex'),
          },
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain(CHALLENGE)
    expect(JSON.stringify(result)).not.toContain('http://127.0.0.1')
  })

  it('rejects fixture origins even when an injected reconciler reports pass', async () => {
    const root = await temporaryRoot()
    const result = await runM07RateReconciliation(
      liveOptions(root),
      passingDependencies({ reconcile: async () => reconciliation('fixture') }),
    )

    expect(result).toMatchObject({
      execution: 'test-double',
      evidenceKind: 'simulated',
      status: 'fail',
      acceptancePassed: false,
      error: { code: 'E_RATE_LIVE_SOURCE' },
    })
  })

  it('rejects suspicious credential fields before reconciliation', async () => {
    const root = await temporaryRoot()
    const reconcile = vi.fn()
    const result = await runM07RateReconciliation(
      liveOptions(root),
      passingDependencies({
        reconcile,
        readInput: async (_repository, _path, label) =>
          input(label, label === 'HUD' ? { apiKey: 'not-evidence' } : {}),
      }),
    )

    expect(reconcile).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'fail',
      acceptancePassed: false,
      error: { code: 'E_RATE_SECRET_FIELD' },
    })
    expect(() => assertNoSuspiciousCredentialFields({ inputTokens: 1 })).not.toThrow()
  })

  it('recognizes only Windows or Ubuntu target environments', async () => {
    await expect(inspectM07RuntimePlatform('win32', 'x64', 'v22.19.0')).resolves.toEqual(
      WINDOWS_PLATFORM,
    )
    await expect(
      inspectM07RuntimePlatform('linux', 'x64', 'v22.19.0', async () => 'ID=debian\n'),
    ).rejects.toMatchObject({ code: 'E_RATE_PLATFORM' })
  })

  it('fails a Git inspection when HEAD changes around status', () => {
    const invokeGit = vi
      .fn()
      .mockReturnValueOnce(`${GIT_SHA}\n`)
      .mockReturnValueOnce('')
      .mockReturnValueOnce(`${DRIFTED_GIT_SHA}\n`)

    expect(() => inspectM07GitState('repository', invokeGit)).toThrowError(
      expect.objectContaining({ code: 'E_RATE_GIT_HEAD_DRIFT' }),
    )
  })

  it('builds a minimal Git environment without cookies, tokens, or ambient config', () => {
    const environment = createM07GitEnvironment({
      Path: 'C:\\safe-bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      LUBAN_SESSION_COOKIE: 'luban_session=must-not-reach-git',
      GH_TOKEN: 'must-not-reach-git',
      NODE_AUTH_TOKEN: 'must-not-reach-git',
      AWS_SECRET_ACCESS_KEY: 'must-not-reach-git',
      GIT_CONFIG_GLOBAL: 'C:\\attacker.gitconfig',
      HOME: 'C:\\ambient-home',
    })

    expect(environment).toMatchObject({
      Path: 'C:\\safe-bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(Object.keys(environment)).not.toContain('LUBAN_SESSION_COOKIE')
    expect(Object.keys(environment)).not.toContain('GH_TOKEN')
    expect(Object.keys(environment)).not.toContain('NODE_AUTH_TOKEN')
    expect(Object.keys(environment)).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(environment.GIT_CONFIG_GLOBAL).not.toBe('C:\\attacker.gitconfig')
    if (process.platform === 'win32') expect(environment.GIT_CONFIG_GLOBAL).toBe('NUL')
    expect(environment).not.toHaveProperty('HOME')
    expect(JSON.stringify(environment)).not.toContain('must-not-reach-git')
  })

  it('binds the runner, reconciler, mounted ledger, collector, HTTP route, and mount to HEAD', async () => {
    const repository = await temporaryRoot('luban-m07-source-')
    const blobs = new Map()
    for (const relativePath of TRACKED_SOURCE_PATHS) {
      const sourcePath = join(repository, ...relativePath.split('/'))
      await mkdir(dirname(sourcePath), { recursive: true })
      const raw =
        relativePath === 'packages/dsh-luban-hud/package.json'
          ? `${JSON.stringify({
              name: 'dsh-luban-hud',
              version: '0.1.0',
              type: 'module',
              main: './dist/index.js',
              exports: { '.': { default: './dist/index.js' } },
            })}\n`
          : `export const source = ${JSON.stringify(relativePath)}\n`
      await writeFile(sourcePath, raw, 'utf8')
      blobs.set(relativePath, gitBlob(raw))
    }
    const runtimePath = join(repository, 'packages', 'dsh-luban-hud', 'dist', 'index.js')
    await mkdir(dirname(runtimePath), { recursive: true })
    await writeFile(runtimePath, RUNTIME_ENTRYPOINT)
    await writeFile(join(dirname(runtimePath), 'build-provenance.json'), BUILD_MANIFEST_BYTES)
    const invokeGit = vi.fn((_root, args) => {
      const relativePath = String(args[1]).slice('HEAD:'.length)
      return `${blobs.get(relativePath)}\n`
    })

    await expect(inspectM07SourceProvenance(repository, GIT_SHA, invokeGit)).resolves.toMatchObject(
      {
        bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        files: TRACKED_SOURCE_PATHS.map((relativePath) => ({
          relativePath,
          gitBlob: blobs.get(relativePath),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          bytes: expect.any(Number),
        })),
        runtimeArtifact: RUNTIME_ARTIFACT,
        build: BUILD_PROVENANCE,
      },
    )
    expect(invokeGit).toHaveBeenCalledTimes(TRACKED_SOURCE_PATHS.length)

    const driftedGit = vi.fn((_root, args) => {
      const relativePath = String(args[1]).slice('HEAD:'.length)
      return relativePath === TRACKED_SOURCE_PATHS[2]
        ? `${'d'.repeat(40)}\n`
        : `${blobs.get(relativePath)}\n`
    })
    await expect(inspectM07SourceProvenance(repository, GIT_SHA, driftedGit)).rejects.toMatchObject(
      {
        code: 'E_RATE_SOURCE_PROVENANCE',
      },
    )

    await expect(inspectM07RuntimeArtifact(repository)).resolves.toEqual(RUNTIME_ARTIFACT)
    await expect(inspectM07BuildProvenance(repository, GIT_SHA, RUNTIME_ARTIFACT)).resolves.toEqual(
      BUILD_PROVENANCE,
    )
    await writeFile(runtimePath, 'import("./dynamic.js")\n', 'utf8')
    await expect(inspectM07RuntimeArtifact(repository)).rejects.toMatchObject({
      code: 'E_RATE_RUNTIME_PROVENANCE',
    })
  })

  it('bounds file-handle reads even if a source keeps growing', async () => {
    const handle = {
      read: vi.fn(async (buffer, _offset, length) => {
        buffer.fill(0x61, 0, length)
        return { bytesRead: length }
      }),
    }

    await expect(readM07BoundedFile(handle, 'HUD', 128)).rejects.toMatchObject({
      code: 'E_RATE_INPUT_SIZE',
    })
    expect(handle.read).toHaveBeenCalledTimes(1)
    expect(handle.read.mock.calls[0]?.[2]).toBe(129)
  })

  it('accepts only credential-free loopback HTTP HUD URLs and creates bounded challenges', () => {
    expect(validateM07HudUrl('http://127.0.0.1:42600').href).toBe(
      'http://127.0.0.1:42600/luban-hud/rate-capture',
    )
    expect(validateM07HudUrl('http://[::1]:42600').href).toBe(
      'http://[::1]:42600/luban-hud/rate-capture',
    )
    for (const rejected of [
      'https://127.0.0.1:42600',
      'http://localhost:42600/luban-hud/rate-capture',
      'http://example.com:42600',
      'http://user:password@127.0.0.1:42600',
      'http://127.0.0.1:42600/other',
      'http://127.0.0.1:42600?cookie=secret',
      'http://127.0.0.1:42600/#fragment',
    ]) {
      expect(() => validateM07HudUrl(rejected)).toThrowError(
        expect.objectContaining({ code: 'E_RATE_HUD_URL' }),
      )
    }

    const deterministic = createM07CaptureChallenge(() => Buffer.alloc(32, 0xab))
    expect(deterministic).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{31,127}$/u)
    expect(createM07CaptureChallenge()).not.toBe(createM07CaptureChallenge())
    expect(() => createM07CaptureChallenge(() => Buffer.alloc(31))).toThrowError(
      expect.objectContaining({ code: 'E_RATE_HUD_CHALLENGE' }),
    )
  })

  it('fetches the exact mounted window with an environment-only cookie and no secret evidence', async () => {
    const cookie = 'luban_session=DO_NOT_PERSIST_THIS_COOKIE'
    const fetchImpl = vi.fn(async (url, init) => {
      const requestUrl = new URL(url)
      expect(requestUrl.pathname).toBe('/luban-hud/rate-capture')
      expect(requestUrl.searchParams.get('startUtc')).toBe(WINDOW.startUtc)
      expect(requestUrl.searchParams.get('endUtc')).toBe(WINDOW.endUtc)
      expect(requestUrl.searchParams.get('challenge')).toBe(CHALLENGE)
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', cookie },
      })
      return new globalThis.Response(JSON.stringify(mountedCapture()), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    })

    const result = await fetchMountedHudRateCapture('http://127.0.0.1:42600', WINDOW, CHALLENGE, {
      fetchImpl,
      environment: { LUBAN_SESSION_COOKIE: cookie },
      expectedRuntimeArtifact: RUNTIME_ARTIFACT,
      expectedBuild: BUILD_PROVENANCE,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      value: {
        schemaVersion: 'dsh-luban/m07-hud-rate-export/v1',
        source: { origin: 'live-hud-events' },
        window: WINDOW,
      },
      capture: {
        schemaVersion: 'dsh-luban/m07-hud-rate-capture/v4',
        sourceKind: 'mounted-hud-capture',
        challengeSha256: createHash('sha256').update(CHALLENGE).digest('hex'),
        providerRequestIdentity: {
          adapter: { id: 'provider-wire-test', version: '1.0.0' },
          count: 1,
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain(cookie)
    expect(JSON.stringify(result)).not.toContain(CHALLENGE)
    expect(JSON.stringify(result)).not.toContain('http://127.0.0.1')
  })

  it('fails closed on missing cookies, timeout, redirects, and oversized HUD responses', async () => {
    const neverCalled = vi.fn()
    await expect(
      fetchMountedHudRateCapture('http://127.0.0.1:42600', WINDOW, CHALLENGE, {
        fetchImpl: neverCalled,
        environment: {},
        expectedRuntimeArtifact: RUNTIME_ARTIFACT,
        expectedBuild: BUILD_PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: 'E_RATE_HUD_COOKIE' })
    expect(neverCalled).not.toHaveBeenCalled()

    const timeoutFetch = vi.fn(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    await expect(
      fetchMountedHudRateCapture('http://127.0.0.1:42600', WINDOW, CHALLENGE, {
        fetchImpl: timeoutFetch,
        environment: { LUBAN_SESSION_COOKIE: 'luban_session=timeout-secret' },
        expectedRuntimeArtifact: RUNTIME_ARTIFACT,
        expectedBuild: BUILD_PROVENANCE,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'E_RATE_HUD_TIMEOUT' })

    const redirectFetch = vi.fn(
      async () =>
        new globalThis.Response(null, {
          status: 302,
          headers: { location: 'http://example.com/capture' },
        }),
    )
    await expect(
      fetchMountedHudRateCapture('http://127.0.0.1:42600', WINDOW, CHALLENGE, {
        fetchImpl: redirectFetch,
        environment: { LUBAN_SESSION_COOKIE: 'luban_session=redirect-secret' },
        expectedRuntimeArtifact: RUNTIME_ARTIFACT,
        expectedBuild: BUILD_PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: 'E_RATE_HUD_STATUS' })

    const oversizedFetch = vi.fn(
      async () =>
        new globalThis.Response('x'.repeat(129), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(
      fetchMountedHudRateCapture('http://127.0.0.1:42600', WINDOW, CHALLENGE, {
        fetchImpl: oversizedFetch,
        environment: { LUBAN_SESSION_COOKIE: 'luban_session=size-secret' },
        expectedRuntimeArtifact: RUNTIME_ARTIFACT,
        expectedBuild: BUILD_PROVENANCE,
        maxBytes: 128,
      }),
    ).rejects.toMatchObject({ code: 'E_RATE_HUD_RESPONSE_SIZE' })

    const reflectedCookie = 'luban_session=reflected-secret'
    const reflectedCapture = mountedCapture()
    reflectedCapture.captures[0].model = reflectedCookie
    const reflectedFetch = vi.fn(
      async () =>
        new globalThis.Response(JSON.stringify(reflectedCapture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    await expect(
      fetchMountedHudRateCapture('http://127.0.0.1:42600', WINDOW, CHALLENGE, {
        fetchImpl: reflectedFetch,
        environment: { LUBAN_SESSION_COOKIE: reflectedCookie },
        expectedRuntimeArtifact: RUNTIME_ARTIFACT,
        expectedBuild: BUILD_PROVENANCE,
      }),
    ).rejects.toMatchObject({ code: 'E_RATE_SECRET_FIELD' })
  })

  it('validates provider windows, capture coverage, and provider request identities', () => {
    expect(extractProviderRateWindow(providerExport())).toEqual(WINDOW)
    const fixtureProvider = providerExport()
    fixtureProvider.source.origin = 'fixture'
    expect(() => extractProviderRateWindow(fixtureProvider)).toThrowError(
      expect.objectContaining({ code: 'E_RATE_PROVIDER_SCHEMA' }),
    )

    expect(
      validateMountedHudCapture(
        mountedCapture(),
        WINDOW,
        CHALLENGE,
        RUNTIME_ARTIFACT,
        BUILD_PROVENANCE,
      ),
    ).toMatchObject({
      value: { source: { origin: 'live-hud-events' }, window: WINDOW },
      capture: { sourceKind: 'mounted-hud-capture' },
    })
    const mutations = [
      (capture) => {
        capture.schemaVersion = 'wrong-schema'
      },
      (capture) => {
        capture.source.kind = 'operator-file'
      },
      (capture) => {
        capture.source.challengeSha256 = '0'.repeat(64)
      },
      (capture) => {
        capture.export.source.origin = 'fixture'
      },
      (capture) => {
        capture.export.window.endUtc = '2026-08-30T00:05:00.000Z'
      },
      (capture) => {
        capture.captures[0].providerRequest.binding.step = 2
      },
      (capture) => {
        capture.captures[0].providerRequest.providerRequestIdSha256 = '0'.repeat(64)
      },
      (capture) => {
        capture.captures[0].providerRequest.binding.challengeSha256 = '0'.repeat(64)
      },
      (capture) => {
        capture.captures[0].providerRequest.extra = true
      },
    ]
    for (const mutate of mutations) {
      const capture = clone(mountedCapture())
      mutate(capture)
      expect(() =>
        validateMountedHudCapture(capture, WINDOW, CHALLENGE, RUNTIME_ARTIFACT, BUILD_PROVENANCE),
      ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^E_RATE_HUD_/u) }))
    }

    const incompleteCoverage = clone(mountedCapture())
    incompleteCoverage.source.coverageStartUtc = '2026-08-30T00:00:00.001Z'
    expect(() =>
      validateMountedHudCapture(
        incompleteCoverage,
        WINDOW,
        CHALLENGE,
        RUNTIME_ARTIFACT,
        BUILD_PROVENANCE,
      ),
    ).toThrowError(expect.objectContaining({ code: 'E_RATE_HUD_COVERAGE', blocked: true }))

    const credentialLeak = clone(mountedCapture())
    credentialLeak.captures[0].accessToken = 'must-not-be-accepted'
    expect(() =>
      validateMountedHudCapture(
        credentialLeak,
        WINDOW,
        CHALLENGE,
        RUNTIME_ARTIFACT,
        BUILD_PROVENANCE,
      ),
    ).toThrowError(expect.objectContaining({ code: 'E_RATE_SECRET_FIELD' }))
  })

  it('bounds response streams even if a mounted endpoint keeps sending bytes', async () => {
    const releaseLock = vi.fn()
    const cancel = vi.fn(async () => undefined)
    const body = {
      getReader: () => ({
        read: vi.fn(async () => ({ done: false, value: new Uint8Array(129) })),
        cancel,
        releaseLock,
      }),
    }
    await expect(readM07BoundedResponseBody(body, 128)).rejects.toMatchObject({
      code: 'E_RATE_HUD_RESPONSE_SIZE',
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledOnce()
  })

  it('never treats operator-provided exports as direct live acceptance', () => {
    expect(requiresM07FunctionalBoundary('production', 'pass', true)).toBe(true)
    expect(requiresM07FunctionalBoundary('test-double', 'pass', true)).toBe(false)
    expect(requiresM07FunctionalBoundary('production', 'fail', true)).toBe(false)
    expect(requiredM07BoundaryCode('production', 'external', 'pass', true)).toBe(
      'E_RATE_MOUNTED_CAPTURE_REQUIRED',
    )
    expect(requiredM07BoundaryCode('production', 'mounted', 'pass', true)).toBeNull()
    expect(requiredM07BoundaryCode('test-double', 'mounted', 'pass', true)).toBeNull()
    expect(m07EvidenceKind('production', 'external')).toBe('operator-provided-external-exports')
    expect(m07EvidenceKind('production', 'mounted')).toBe('mounted-hud-provider-reconciled')
    expect(m07EvidenceKind('test-double', 'mounted')).toBe('simulated')
  })

  it('keeps exports and evidence outside the repository and never overwrites artifacts', async () => {
    const repository = await temporaryRoot('luban-m07-repository-')
    const evidenceDirectory = await temporaryRoot('luban-m07-evidence-')
    const inputPath = join(repository, 'hud.json')
    await writeFile(inputPath, '{}', 'utf8')
    await expect(readExternalRateExport(repository, inputPath, 'HUD')).rejects.toMatchObject({
      code: 'E_RATE_INPUT_PROVENANCE',
    })

    const evidence = { schemaVersion: 'test', status: 'simulated' }
    await expect(
      writeM07RateEvidence(join(repository, 'evidence.json'), evidence, { root: repository }),
    ).rejects.toMatchObject({ code: 'E_RATE_OUTPUT_PROVENANCE' })

    const evidencePath = join(evidenceDirectory, 'evidence.json')
    await expect(
      writeM07RateEvidence(evidencePath, evidence, { root: repository }),
    ).resolves.toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    await expect(
      writeM07RateEvidence(evidencePath, evidence, { root: repository }),
    ).rejects.toMatchObject({ code: 'E_RATE_OUTPUT_EXISTS' })
    await expect(readFile(evidencePath, 'utf8')).resolves.not.toContain('external-hud.json')
  })

  it('exposes the default plan through the CLI', async () => {
    const log = vi.fn()
    await expect(runM07RateReconciliationCli([], log)).resolves.toBe(0)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toContain('"status": "planned"')
    await expect(
      runM07RateReconciliationCli(['--output', 'must-not-write.json'], log),
    ).rejects.toThrow('--output is only valid with --live')
    await expect(
      runM07RateReconciliationCli(
        [
          '--live',
          '--hud-export',
          'hud.json',
          '--hud-url',
          'http://127.0.0.1:42600',
          '--provider-export',
          'provider.json',
          '--output',
          'evidence.json',
        ],
        log,
      ),
    ).rejects.toThrow('--hud-export and --hud-url are mutually exclusive')
    await expect(
      runM07RateReconciliationCli(['--cookie', 'must-never-enter-argv'], log),
    ).rejects.toThrow('Unknown option: --cookie')
  })
})
