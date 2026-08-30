import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertNoSuspiciousCredentialFields,
  inspectM07GitState,
  inspectM07RuntimePlatform,
  inspectM07SourceProvenance,
  readM07BoundedFile,
  readExternalRateExport,
  requiresTrustedM07Capture,
  runM07RateReconciliation,
  runM07RateReconciliationCli,
  writeM07RateEvidence,
} from '../acceptance/m07-rate-reconcile.mjs'

const directories = new Set()
const GIT_SHA = 'a'.repeat(40)
const DRIFTED_GIT_SHA = 'b'.repeat(40)
const WINDOWS_PLATFORM = Object.freeze({
  target: 'windows',
  runtimePlatform: 'win32',
  arch: 'x64',
  node: 'v22.19.0',
})
const SOURCE_PROVENANCE = Object.freeze({
  relativePath: 'packages/dsh-luban-hud/src/rate-reconcile.ts',
  gitBlob: 'e'.repeat(40),
  sha256: 'f'.repeat(64),
  bytes: 1024,
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
    inspectGit: async () => ({ sha: GIT_SHA, clean: true }),
    inspectSource: async () => SOURCE_PROVENANCE,
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
      git: {
        before: { sha: GIT_SHA, clean: true },
        after: { sha: GIT_SHA, clean: true },
      },
      source: {
        before: SOURCE_PROVENANCE,
        after: SOURCE_PROVENANCE,
      },
      inputs: {
        hud: { sha256: 'c'.repeat(64), origin: 'live-hud-events' },
        provider: { sha256: 'd'.repeat(64), origin: 'real-provider-export' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('external-hud.json')
    expect(JSON.stringify(result)).not.toContain('external-provider.json')
  })

  it('rejects fixture provenance even when an injected reconciler reports pass', async () => {
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

  it('fails closed on a dirty tree before reading either export', async () => {
    const root = await temporaryRoot()
    const readInput = vi.fn()
    const inspectGit = vi
      .fn()
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: false })
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: false })
    const result = await runM07RateReconciliation(
      liveOptions(root),
      passingDependencies({ inspectGit, readInput }),
    )

    expect(readInput).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'blocked',
      acceptancePassed: false,
      git: {
        before: { sha: GIT_SHA, clean: false },
        after: { sha: GIT_SHA, clean: false },
      },
      error: { code: 'E_RATE_GIT_DIRTY' },
    })
  })

  it('fails closed when Git HEAD changes after reconciliation', async () => {
    const root = await temporaryRoot()
    const inspectGit = vi
      .fn()
      .mockResolvedValueOnce({ sha: GIT_SHA, clean: true })
      .mockResolvedValueOnce({ sha: DRIFTED_GIT_SHA, clean: true })
    const result = await runM07RateReconciliation(
      liveOptions(root),
      passingDependencies({ inspectGit }),
    )

    expect(result).toMatchObject({
      status: 'fail',
      acceptancePassed: false,
      git: {
        before: { sha: GIT_SHA, clean: true },
        after: { sha: DRIFTED_GIT_SHA, clean: true },
      },
      error: { code: 'E_RATE_GIT_HEAD_DRIFT' },
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

  it('accepts only Windows or Ubuntu platform attestations', async () => {
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

  it('binds the executed reconciliation source to its tracked HEAD blob', async () => {
    const repository = await temporaryRoot('luban-m07-source-')
    const sourcePath = join(repository, 'packages', 'dsh-luban-hud', 'src', 'rate-reconcile.ts')
    await mkdir(join(repository, 'packages', 'dsh-luban-hud', 'src'), { recursive: true })
    await writeFile(sourcePath, 'export const source = true\n', 'utf8')
    const blob = 'e'.repeat(40)
    const invokeGit = vi.fn().mockReturnValue(`${blob}\n`)

    await expect(inspectM07SourceProvenance(repository, invokeGit)).resolves.toMatchObject({
      relativePath: 'packages/dsh-luban-hud/src/rate-reconcile.ts',
      gitBlob: blob,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(invokeGit).toHaveBeenCalledTimes(2)

    invokeGit.mockReturnValueOnce(`${blob}\n`).mockReturnValueOnce(`${'d'.repeat(40)}\n`)
    await expect(inspectM07SourceProvenance(repository, invokeGit)).rejects.toMatchObject({
      code: 'E_RATE_SOURCE_PROVENANCE',
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

  it('never treats operator-provided exports as direct live acceptance', () => {
    expect(requiresTrustedM07Capture('production', 'pass', true)).toBe(true)
    expect(requiresTrustedM07Capture('test-double', 'pass', true)).toBe(false)
    expect(requiresTrustedM07Capture('production', 'fail', true)).toBe(false)
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
  })
})
