import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { asSessionId } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imagePrompt } from '../src/dsh-injection.js'
import {
  createVisualAcceptanceRoot,
  inspectCleanVisualAcceptanceGit,
  inspectVisualAcceptanceBuild,
  createVisualTurnTracker,
  findUnexpectedPostTurnNonceLeaks,
  findVisualNonceLeaks,
  inspectVisualAcceptancePlatform,
  isOwnedVisualAcceptanceRoot,
  MountedVisualAcceptanceService,
  observeVisualTurn,
  removeVisualAcceptanceRoot,
  runSimulatedVisualAcceptance,
  sameVisualAcceptanceGit,
  VISUAL_ACCEPTANCE_BUILD_SCHEMA,
  type VisualAcceptanceEvidence,
  visualAcceptanceInstruction,
  type VisualTurnObservation,
} from '../src/live-visual-acceptance.js'
import {
  assertVisualAcceptanceOutputBoundary,
  assertVisualAcceptanceOutputParents,
  defaultVisualAcceptanceOutput,
  runVisualAcceptanceCliForTest,
  writeVisualAcceptanceEvidence,
} from '../src/live-visual-acceptance-cli.js'
import type { StoredImage } from '../src/types.js'
import {
  renderVisualNoncePng,
  validateVisualNoncePng,
  visualNonceFromRandomBytes,
} from '../src/visual-nonce-png.js'

const roots = new Set<string>()
const NONCE = 'ABCDEFGH'
const SESSION = 'session-visual-live'
const PROVIDER = 'visual-provider'
const MODEL = 'visual-model'
const GIT_HEAD = 'a'.repeat(40)
const BUILD_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_BUILD_ID = '22222222-2222-4222-8222-222222222222'
const LOADED_BUILD = Object.freeze({ gitHead: GIT_HEAD, buildId: BUILD_ID })

function observation(responseText: string, respondingSessionId = SESSION): VisualTurnObservation {
  return {
    requestedSessionId: SESSION,
    respondingSessionId,
    responseText,
    expectedProvider: PROVIDER,
    respondingProvider: PROVIDER,
    expectedModel: MODEL,
    respondingModel: MODEL,
  }
}

function storedImage(): StoredImage {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    relPath:
      '.luban/m06-visual-acceptance/run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/20260830-visual-acceptance-1.png',
    absPath:
      'D:\\workspace\\.luban\\m06-visual-acceptance\\run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\\20260830-visual-acceptance-1.png',
    sha256: 'a'.repeat(64),
    source: 'paste',
    referencedBy: [asSessionId(SESSION)],
    createdAt: 1,
    mime: 'image/png',
    bytes: 1_024,
    originalName: 'visual-acceptance',
    compression: { status: 'disabled', originalBytes: 1_024, outputBytes: 1_024 },
  }
}

function sessionEvent(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent
}

function assistantEvent(
  seq: number,
  step: number,
  provider: string,
  model: string,
  text: string,
): SessionEvent {
  return sessionEvent('assistant/message', seq, {
    turn: 4,
    step,
    message: {
      id: `assistant-${String(step)}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider, model },
    },
  })
}

function completedVisualTurn(
  options: {
    readonly firstText?: string
    readonly secondProvider?: string
    readonly secondModel?: string
    readonly appendSecondHeader?: boolean
  } = {},
): readonly SessionEvent[] {
  const secondProvider = options.secondProvider ?? PROVIDER
  const secondModel = options.secondModel ?? MODEL
  const events: SessionEvent[] = [
    sessionEvent('turn/start', 1, { turn: 4 }),
    sessionEvent('user/message', 2, {
      id: 'visual-user',
      role: 'user',
      content: [{ type: 'text', text: `Inspect ${storedImage().relPath}` }],
      source: { kind: 'plugin', plugin: 'dsh-luban-image-paste' },
    }),
    sessionEvent('step/start', 3, { turn: 4, step: 1 }),
    sessionEvent('request/header', 4, {
      header: { config: { provider: PROVIDER, model: MODEL } },
      reason: 'initial',
    }),
    assistantEvent(5, 1, PROVIDER, MODEL, options.firstText ?? 'Opening the image tool.'),
    sessionEvent('step/end', 6, { turn: 4, step: 1 }),
    sessionEvent('step/start', 7, { turn: 4, step: 2 }),
  ]
  if (options.appendSecondHeader === true) {
    events.push(
      sessionEvent('request/header', 8, {
        header: { config: { provider: secondProvider, model: secondModel } },
        reason: 'config-change',
      }),
    )
  }
  const finalSequence = options.appendSecondHeader === true ? 9 : 8
  events.push(
    assistantEvent(finalSequence, 2, secondProvider, secondModel, NONCE),
    sessionEvent('step/end', finalSequence + 1, { turn: 4, step: 2 }),
    sessionEvent('turn/end', finalSequence + 2, {
      turn: 4,
      reason: { kind: 'completed' },
    }),
  )
  return events
}

function visualAgent(events: readonly SessionEvent[]): Agent {
  return {
    id: SESSION,
    session: { id: SESSION, events },
  } as unknown as Agent
}

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root): Promise<void> => {
      await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
      roots.delete(root)
    }),
  )
  vi.restoreAllMocks()
})

describe('M06 live visual acceptance', () => {
  it('returns session-bound blocked evidence for a concurrent live run', async () => {
    const workspace = await temporaryRoot('luban-m06-concurrent-')
    const service = new MountedVisualAcceptanceService(
      { agents: { get: (): undefined => undefined } } as unknown as Context,
      workspace,
    )

    const first = service.run({ live: true, sessionId: SESSION })
    const concurrent = await service.run({ live: true, sessionId: SESSION })

    expect(concurrent).toMatchObject({
      execution: 'production',
      evidenceKind: 'live',
      status: 'blocked',
      acceptancePassed: false,
      session: { requestedId: SESSION },
      checks: [{ id: 'exclusive-run', status: 'blocked' }],
    })
    await first
  })

  it('keeps the nonce in PNG pixels and hashes it out of prompts and evidence', async () => {
    const generated = visualNonceFromRandomBytes(Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7))
    expect(generated).toHaveLength(8)
    const png = renderVisualNoncePng(NONCE)
    expect(validateVisualNoncePng(png)).toMatchObject({ width: 612, height: 132 })
    expect(Buffer.from(png).includes(Buffer.from(NONCE, 'ascii'))).toBe(false)

    const image = storedImage()
    const prompt = imagePrompt(image, 'path', { instruction: visualAcceptanceInstruction })
    expect(
      findVisualNonceLeaks(NONCE, {
        prompt,
        filename: image.originalName,
        relativePath: image.relPath,
        absolutePath: image.absPath,
        sessionText: prompt,
      }),
    ).toEqual([])

    const result = await runSimulatedVisualAcceptance({
      nonce: NONCE,
      png,
      sessionId: SESSION,
      provider: PROVIDER,
      model: MODEL,
      execute: ({ simulationNonce }) => Promise.resolve(observation(simulationNonce)),
    })
    expect(result).toMatchObject({
      evidenceKind: 'simulated',
      status: 'simulated',
      acceptancePassed: false,
      simulatedOutcome: 'pass',
    })
    expect(JSON.stringify(result)).not.toContain(NONCE)
  })

  it('allows nonce readback only in model-authored output for the observed turn', () => {
    const assistant = {
      type: 'assistant/message',
      seq: 11,
      data: { turn: 4, step: 2, message: { content: [{ type: 'text', text: NONCE }] } },
    } as unknown as SessionEvent
    const injectedInput = {
      type: 'user/message',
      seq: 12,
      data: { content: [{ type: 'text', text: NONCE }] },
    } as unknown as SessionEvent

    expect(findUnexpectedPostTurnNonceLeaks(NONCE, [assistant], 10, 4, 2)).toEqual([])
    expect(findUnexpectedPostTurnNonceLeaks(NONCE, [assistant, injectedInput], 10, 4, 2)).toEqual([
      'user/message:12',
    ])
  })

  it('accepts a two-step visual turn only when every assistant keeps one effective route', () => {
    const observed = observeVisualTurn(
      visualAgent(completedVisualTurn()),
      0,
      storedImage(),
      4,
      NONCE,
    )
    expect(observed).toMatchObject({
      turn: 4,
      step: 2,
      route: { provider: PROVIDER, model: MODEL },
      observation: { responseText: NONCE },
    })

    expect(() =>
      observeVisualTurn(
        visualAgent(
          completedVisualTurn({
            secondProvider: 'rerouted-provider',
            secondModel: 'rerouted-model',
            appendSecondHeader: true,
          }),
        ),
        0,
        storedImage(),
        4,
        NONCE,
      ),
    ).toThrow(/crossed provider or model routes/u)
    expect(() =>
      observeVisualTurn(
        visualAgent(completedVisualTurn({ firstText: NONCE })),
        0,
        storedImage(),
        4,
        NONCE,
      ),
    ).toThrow(/before the final assistant response/u)
  })

  it('settles the exact claimed message even when pre-step rejects before user/message', async () => {
    const context = new Context()
    const events: SessionEvent[] = []
    const agent = visualAgent(events)
    const tracker = createVisualTurnTracker(context, agent)
    const message = createUserMessage({
      content: [{ type: 'text', text: 'visual acceptance' }],
      source: { kind: 'plugin', plugin: 'dsh-luban-image-paste' },
    })
    tracker.bind(message.id)
    context.emit('agent/inbox/claimed', { agent, message, turn: 9 })
    const ended = sessionEvent('turn/end', 1, {
      turn: 9,
      reason: { kind: 'blocked' },
    })
    events.push(ended)
    context.emit('session/event', agent.session, ended)

    await expect(tracker.wait(10_000)).resolves.toEqual({ turn: 9, reason: 'blocked' })
    tracker.dispose()
  })

  it('fails a simulated observation from the wrong session', async () => {
    const result = await runSimulatedVisualAcceptance({
      nonce: NONCE,
      png: renderVisualNoncePng(NONCE),
      sessionId: SESSION,
      provider: PROVIDER,
      model: MODEL,
      execute: ({ simulationNonce }) =>
        Promise.resolve(observation(simulationNonce, 'session-wrong')),
    })
    expect(result).toMatchObject({ acceptancePassed: false, simulatedOutcome: 'fail' })
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: 'visual-observation',
        status: 'fail',
        actual: 'wrong-session',
      }),
    )
  })

  it('fails a wrong nonce and never promotes injected execution to live evidence', async () => {
    const execute = vi.fn(() => Promise.resolve(observation('WRONG234')))
    const result = await runSimulatedVisualAcceptance({
      nonce: NONCE,
      png: renderVisualNoncePng(NONCE),
      sessionId: SESSION,
      provider: PROVIDER,
      model: MODEL,
      execute,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      evidenceKind: 'simulated',
      status: 'simulated',
      acceptancePassed: false,
      simulatedOutcome: 'fail',
    })
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'visual-observation', actual: 'wrong-nonce' }),
    )
  })

  it('rejects an invalid PNG before any simulated turn executes', async () => {
    const png = renderVisualNoncePng(NONCE)
    png[png.length - 1] = (png[png.length - 1] ?? 0) ^ 0xff
    const execute = vi.fn(() => Promise.resolve(observation(NONCE)))
    const result = await runSimulatedVisualAcceptance({
      nonce: NONCE,
      png,
      sessionId: SESSION,
      provider: PROVIDER,
      model: MODEL,
      execute,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ acceptancePassed: false, simulatedOutcome: 'fail' })
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: 'simulated-execution', status: 'fail' }),
    )
  })

  it('cleans only an absolute directly owned acceptance root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'luban-m06-visual-live-'))
    roots.add(workspace)
    const owned = join(
      workspace,
      '.luban',
      'm06-visual-acceptance',
      'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )
    const outside = join(workspace, '.luban', 'm06-visual-acceptance-other', 'run-keep')
    await mkdir(owned, { recursive: true })
    await writeFile(join(owned, 'fixture'), 'owned', 'utf8')
    await mkdir(outside, { recursive: true })

    expect(isOwnedVisualAcceptanceRoot(workspace, owned)).toBe(true)
    expect(isOwnedVisualAcceptanceRoot(workspace, 'run-relative')).toBe(false)
    expect(isOwnedVisualAcceptanceRoot(workspace, outside)).toBe(false)
    await expect(removeVisualAcceptanceRoot(workspace, outside)).rejects.toThrow(/unowned/u)
    await expect(stat(outside)).resolves.toBeDefined()
    await removeVisualAcceptanceRoot(workspace, owned)
    await expect(stat(owned)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a linked owner before creating or deleting an external run', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'luban-m06-visual-link-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'luban-m06-visual-link-outside-'))
    roots.add(workspace)
    roots.add(outside)
    const luban = join(workspace, '.luban')
    const owner = join(luban, 'm06-visual-acceptance')
    await mkdir(luban)
    await symlink(outside, owner, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      createVisualAcceptanceRoot(workspace, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).rejects.toThrow(/plain directory|link|junction/u)
    await expect(readdir(outside)).resolves.toEqual([])
  })

  it('attests only Windows or Ubuntu live platforms', async () => {
    await expect(inspectVisualAcceptancePlatform('win32', 'x64', 'v22.0.0')).resolves.toMatchObject(
      { target: 'windows', runtimePlatform: 'win32' },
    )
    await expect(
      inspectVisualAcceptancePlatform('linux', 'x64', 'v22.0.0', () =>
        Promise.resolve('NAME=Ubuntu\nID="ubuntu"\n'),
      ),
    ).resolves.toMatchObject({ target: 'ubuntu', osReleaseId: 'ubuntu' })
    await expect(
      inspectVisualAcceptancePlatform('linux', 'x64', 'v22.0.0', () =>
        Promise.resolve('NAME=Debian\nID=debian\n'),
      ),
    ).rejects.toThrow(/ID=ubuntu/u)
    await expect(inspectVisualAcceptancePlatform('darwin', 'arm64', 'v22.0.0')).rejects.toThrow(
      /Windows and Ubuntu/u,
    )
  })

  it('prints help without creating evidence or using transport', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-help-')
    const output: string[] = []
    const fetcher = vi.fn<typeof fetch>()

    const result = await runVisualAcceptanceCliForTest(['--help'], {
      cwd,
      fetch: fetcher,
      write: (value): void => {
        output.push(value)
      },
    })

    expect(result.exitCode).toBe(0)
    expect(output.join('')).toContain('--live')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(readdir(cwd)).resolves.toEqual([])
  })

  it('keeps the operator CLI plan-only unless --live is explicit', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-plan-')
    const fetcher = vi.fn<typeof fetch>()
    const result = await runVisualAcceptanceCliForTest([], { cwd, fetch: fetcher })

    expect(result).toMatchObject({
      exitCode: 0,
      evidence: {
        execution: 'operator-plan',
        evidenceKind: 'none',
        status: 'planned',
        acceptancePassed: false,
      },
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(result.evidencePath ?? '', 'utf8'))).toMatchObject({
      status: 'planned',
    })
  })

  it('calls the authenticated mounted endpoint only with --live and downgrades injected transport', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-live-')
    const calls: { readonly url: string; readonly init?: RequestInit }[] = []
    const fetcher = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        calls.push({ url, ...(init === undefined ? {} : { init }) })
        return Promise.resolve(Response.json({ evidence: productionEvidence() }))
      },
    )
    const result = await runVisualAcceptanceCliForTest(
      ['--live', '--session', SESSION, '--timeout-ms', '10000'],
      {
        cwd,
        fetch: fetcher,
        environment: {
          LUBAN_SESSION_COOKIE: 'luban_session=secret-cookie',
          LUBAN_CSRF_TOKEN: 'csrf-secret-token',
        },
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:42600/luban-image-paste/visual-acceptance')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('cookie')).toBe('luban_session=secret-cookie')
    expect(headers.get('x-luban-csrf')).toBe('csrf-secret-token')
    expect(calls[0]?.init?.body).toBe(
      JSON.stringify({ live: true, sessionId: SESSION, timeoutMs: 10_000 }),
    )
    expect(result.evidence).toMatchObject({
      execution: 'test-double',
      evidenceKind: 'simulated',
      status: 'simulated',
      acceptancePassed: false,
      simulatedOutcome: 'pass',
    })
    expect(result.exitCode).toBe(1)
    const serialized = await readFile(result.evidencePath ?? '', 'utf8')
    expect(serialized).not.toContain('secret-cookie')
    expect(serialized).not.toContain('csrf-secret-token')
  })

  it('never overwrites an existing evidence output', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-output-')
    const output = join(cwd, 'evidence.json')
    await writeFile(output, 'keep-me', 'utf8')

    const result = await runVisualAcceptanceCliForTest(['--output', output], { cwd })

    expect(result.exitCode).toBe(1)
    expect(await readFile(output, 'utf8')).toBe('keep-me')
  })

  it('rejects an existing explicit live output before using transport', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-live-output-')
    const output = join(cwd, 'evidence.json')
    const fetcher = vi.fn<typeof fetch>()
    await writeFile(output, 'keep-me', 'utf8')

    const result = await runVisualAcceptanceCliForTest(
      ['--live', '--session', SESSION, '--output', output],
      {
        cwd,
        fetch: fetcher,
        environment: {
          LUBAN_SESSION_COOKIE: 'luban_session=secret-cookie',
          LUBAN_CSRF_TOKEN: 'csrf-secret-token',
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readFile(output, 'utf8')).toBe('keep-me')
  })

  it('never sends acceptance credentials to a non-loopback base URL', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-remote-')
    const fetcher = vi.fn<typeof fetch>()
    const result = await runVisualAcceptanceCliForTest(
      ['--live', '--session', SESSION, '--base-url', 'https://example.com/luban-image-paste'],
      {
        cwd,
        fetch: fetcher,
        environment: {
          LUBAN_SESSION_COOKIE: 'luban_session=secret-cookie',
          LUBAN_CSRF_TOKEN: 'csrf-secret-token',
        },
      },
    )

    expect(result.exitCode).toBe(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.evidencePath).toBeUndefined()
  })

  it('rejects self-consistent evidence for a different requested session', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-wrong-session-')
    const otherSession = 'session-other'
    const forged = {
      ...productionEvidence(),
      session: {
        requestedId: otherSession,
        respondingId: otherSession,
        agentId: otherSession,
        turn: 4,
      },
    }

    const result = await runVisualAcceptanceCliForTest(['--live', '--session', SESSION], {
      cwd,
      environment: {
        LUBAN_SESSION_COOKIE: 'luban_session=secret-cookie',
        LUBAN_CSRF_TOKEN: 'csrf-secret-token',
      },
      fetch: () => Promise.resolve(Response.json({ evidence: forged })),
    })

    expect(result.exitCode).toBe(1)
    expect(result.evidencePath).toBeUndefined()
  })

  it('preserves an unsupported-platform blocked outcome without accepting production', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-blocked-')
    const blocked: VisualAcceptanceEvidence = {
      ...productionEvidence(),
      status: 'blocked',
      acceptancePassed: false,
      platform: {
        target: 'other',
        runtimePlatform: 'darwin',
        arch: 'arm64',
        node: 'v22.0.0',
      },
      cleanup: 'not-needed',
      error: 'live visual acceptance supports only Windows and Ubuntu',
    }

    const result = await runVisualAcceptanceCliForTest(['--live', '--session', SESSION], {
      cwd,
      environment: {
        LUBAN_SESSION_COOKIE: 'luban_session=secret-cookie',
        LUBAN_CSRF_TOKEN: 'csrf-secret-token',
      },
      fetch: () => Promise.resolve(Response.json({ evidence: blocked })),
    })

    expect(result).toMatchObject({
      exitCode: 2,
      evidence: {
        execution: 'test-double',
        evidenceKind: 'simulated',
        acceptancePassed: false,
        simulatedOutcome: 'fail',
      },
    })
  })

  it('does not write or print provider response bodies or unknown evidence fields', async () => {
    const cwd = await temporaryRoot('luban-m06-cli-secret-')
    const output: string[] = []
    const forged = { ...productionEvidence(), providerRawResponse: 'provider-secret-response' }
    const result = await runVisualAcceptanceCliForTest(['--live', '--session', SESSION], {
      cwd,
      environment: {
        LUBAN_SESSION_COOKIE: 'luban_session=secret-cookie',
        LUBAN_CSRF_TOKEN: 'csrf-secret-token',
      },
      fetch: () => Promise.resolve(Response.json({ evidence: forged })),
      write: (value): void => {
        output.push(value)
      },
    })

    expect(result.exitCode).toBe(1)
    expect(result.evidencePath).toBeUndefined()
    expect(output.join('')).not.toContain('provider-secret-response')
    expect(output.join('')).not.toContain('secret-cookie')
    expect(output.join('')).not.toContain('csrf-secret-token')
  })
})

describe('M06 plugin and Git provenance', () => {
  it('confines live evidence output to the ignored acceptance directory', async () => {
    const repository = await temporaryRoot('luban-m06-output-boundary-')
    const ignored = join(repository, '.luban', 'acceptance', 'evidence.json')
    const tracked = join(repository, 'evidence.json')
    const gitInternal = join(repository, '.git', 'evidence.json')
    const external = resolve(repository, '..', 'external-evidence.json')

    expect(
      assertVisualAcceptanceOutputBoundary(
        repository,
        ignored,
        (_root, target): boolean => target === ignored,
      ),
    ).toBe(resolve(ignored))
    expect(() =>
      assertVisualAcceptanceOutputBoundary(repository, tracked, (): boolean => false),
    ).toThrow(/ignored .luban\/acceptance/u)
    expect(() =>
      assertVisualAcceptanceOutputBoundary(repository, gitInternal, (): boolean => true),
    ).toThrow(/ignored .luban\/acceptance/u)
    expect(() =>
      assertVisualAcceptanceOutputBoundary(repository, external, (): boolean => true),
    ).toThrow(/ignored .luban\/acceptance/u)

    expect(
      defaultVisualAcceptanceOutput(
        join(repository, 'packages', 'child'),
        productionEvidence(),
        repository,
      ),
    ).toBe(
      join(repository, '.luban', 'acceptance', `m06-windows-${productionEvidence().runId}.json`),
    )
  })

  it('rejects a symlinked live evidence parent', async () => {
    const repository = await temporaryRoot('luban-m06-output-link-')
    const outside = await temporaryRoot('luban-m06-output-link-target-')
    await mkdir(join(repository, '.luban'), { recursive: true })
    await symlink(
      outside,
      join(repository, '.luban', 'acceptance'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(
      assertVisualAcceptanceOutputParents(
        repository,
        join(repository, '.luban', 'acceptance', 'evidence.json'),
      ),
    ).rejects.toThrow(/not a real directory/u)
  })

  it('invalidates a newly written pass if the post-write Git check fails', async () => {
    const repository = await temporaryRoot('luban-m06-output-invalidate-')
    const output = join(repository, 'evidence.json')

    await expect(
      writeVisualAcceptanceEvidence(output, productionEvidence(), [], (): void => {
        throw new Error('Git changed')
      }),
    ).rejects.toThrow(/Git changed/u)
    await expect(readFile(output, 'utf8')).resolves.not.toContain('"acceptancePassed":true')
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({
      acceptancePassed: false,
    })
  })

  it('accepts only the current clean repo build loaded from package dist', async () => {
    const fixture = await buildFixture({ gitHead: GIT_HEAD, dirty: false })

    await expect(
      inspectVisualAcceptanceBuild(
        fixture.root,
        { head: GIT_HEAD, clean: true },
        fixture.runtime,
        LOADED_BUILD,
      ),
    ).resolves.toEqual({
      schemaVersion: VISUAL_ACCEPTANCE_BUILD_SCHEMA,
      gitHead: GIT_HEAD,
      buildId: BUILD_ID,
      dirty: false,
      runtime: 'repo-dist',
      runtimeArtifact: {
        path: 'index.js',
        bytes: 10,
        sha256: createHash('sha256').update('export {}\n').digest('hex'),
      },
    })
  })

  it.each([
    ['stale build', 'b'.repeat(40), false],
    ['dirty build', GIT_HEAD, true],
  ])('rejects a %s provenance file', async (_label, gitHead, dirty) => {
    const fixture = await buildFixture({ gitHead, dirty })

    await expect(
      inspectVisualAcceptanceBuild(
        fixture.root,
        { head: GIT_HEAD, clean: true },
        fixture.runtime,
        LOADED_BUILD,
      ),
    ).rejects.toThrow(/clean build/u)
  })

  it('rejects runtime modules outside repo dist, including source execution', async () => {
    const fixture = await buildFixture({ gitHead: GIT_HEAD, dirty: false })
    const outside = join(await temporaryRoot('luban-m06-installed-'), 'index.js')
    await writeFile(outside, 'export {}\n')
    const sourceDirectory = join(fixture.root, 'packages', 'dsh-luban-image-paste', 'src')
    await mkdir(sourceDirectory, { recursive: true })
    const source = join(sourceDirectory, 'live-visual-acceptance.ts')
    await writeFile(source, 'export {}\n')

    for (const runtime of [outside, source]) {
      await expect(
        inspectVisualAcceptanceBuild(
          fixture.root,
          { head: GIT_HEAD, clean: true },
          runtime,
          LOADED_BUILD,
        ),
      ).rejects.toThrow(/clean build/u)
    }
  })

  it('rejects a dist runtime whose bytes changed after provenance was recorded', async () => {
    const fixture = await buildFixture({ gitHead: GIT_HEAD, dirty: false })
    await writeFile(fixture.runtime, 'export const tampered = true\n')

    await expect(
      inspectVisualAcceptanceBuild(
        fixture.root,
        { head: GIT_HEAD, clean: true },
        fixture.runtime,
        LOADED_BUILD,
      ),
    ).rejects.toThrow(/clean build/u)
  })

  it('rejects a stale loaded build after a same-HEAD disk rebuild', async () => {
    const fixture = await buildFixture({ gitHead: GIT_HEAD, dirty: false })

    await expect(
      inspectVisualAcceptanceBuild(fixture.root, { head: GIT_HEAD, clean: true }, fixture.runtime, {
        gitHead: GIT_HEAD,
        buildId: OTHER_BUILD_ID,
      }),
    ).rejects.toThrow(/clean build/u)
  })

  it('requires an explicit loaded identity for a custom runtime fixture', async () => {
    const fixture = await buildFixture({ gitHead: GIT_HEAD, dirty: false })

    await expect(
      inspectVisualAcceptanceBuild(fixture.root, { head: GIT_HEAD, clean: true }, fixture.runtime),
    ).rejects.toThrow(/clean build/u)
  })

  it('rejects oversized and incomplete build manifests', async () => {
    const oversized = await buildFixture({ gitHead: GIT_HEAD, dirty: false })
    const oversizedPath = join(
      oversized.root,
      'packages',
      'dsh-luban-image-paste',
      'dist',
      'build-provenance.json',
    )
    const oversizedManifest = JSON.parse(await readFile(oversizedPath, 'utf8')) as {
      artifacts: { bytes: number }[]
    }
    if (oversizedManifest.artifacts[0] === undefined) throw new Error('missing fixture artifact')
    oversizedManifest.artifacts[0].bytes = 64 * 1024 * 1024 + 1
    await writeFile(oversizedPath, JSON.stringify(oversizedManifest))
    await expect(
      inspectVisualAcceptanceBuild(
        oversized.root,
        { head: GIT_HEAD, clean: true },
        oversized.runtime,
        LOADED_BUILD,
      ),
    ).rejects.toThrow(/clean build/u)

    const incomplete = await buildFixture({ gitHead: GIT_HEAD, dirty: false })
    await writeFile(
      join(incomplete.root, 'packages', 'dsh-luban-image-paste', 'dist', 'unlisted.js'),
      'export {}\n',
    )
    await expect(
      inspectVisualAcceptanceBuild(
        incomplete.root,
        { head: GIT_HEAD, clean: true },
        incomplete.runtime,
        LOADED_BUILD,
      ),
    ).rejects.toThrow(/clean build/u)
  })

  it('rejects dirty trees and HEAD drift and compares post-run identity', () => {
    expect(() =>
      inspectCleanVisualAcceptanceGit('unused', sequenceGit([GIT_HEAD, ' M file', GIT_HEAD])),
    ).toThrow(/not clean/u)
    expect(() =>
      inspectCleanVisualAcceptanceGit('unused', sequenceGit([GIT_HEAD, '', 'b'.repeat(40)])),
    ).toThrow(/changed/u)
    expect(
      sameVisualAcceptanceGit(
        { head: GIT_HEAD, clean: true },
        { head: 'b'.repeat(40), clean: true },
      ),
    ).toBe(false)
  })
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.add(root)
  return root
}

async function buildFixture(provenance: {
  readonly gitHead: string
  readonly dirty: boolean
}): Promise<{ readonly root: string; readonly runtime: string }> {
  const root = await temporaryRoot('luban-m06-build-')
  const distribution = join(root, 'packages', 'dsh-luban-image-paste', 'dist')
  await mkdir(distribution, { recursive: true })
  const runtime = join(distribution, 'index.js')
  const runtimeContents = 'export {}\n'
  await Promise.all([
    writeFile(runtime, runtimeContents),
    writeFile(
      join(distribution, 'build-provenance.json'),
      JSON.stringify({
        schemaVersion: VISUAL_ACCEPTANCE_BUILD_SCHEMA,
        buildId: BUILD_ID,
        ...provenance,
        artifacts: [
          {
            path: 'index.js',
            bytes: Buffer.byteLength(runtimeContents),
            sha256: createHash('sha256').update(runtimeContents).digest('hex'),
          },
        ],
      }),
    ),
  ])
  return { root, runtime }
}

function sequenceGit(outputs: readonly string[]): (args: readonly string[]) => string {
  let index = 0
  return (): string => outputs[index++] ?? ''
}

function productionEvidence(): VisualAcceptanceEvidence {
  return {
    schemaVersion: 2,
    featureId: 'M06-F003',
    runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    execution: 'production',
    evidenceKind: 'live',
    status: 'pass',
    acceptancePassed: true,
    nonceSha256: 'b'.repeat(64),
    session: { requestedId: SESSION, respondingId: SESSION, agentId: SESSION, turn: 4 },
    agent: { provider: PROVIDER, model: MODEL },
    image: {
      mime: 'image/png',
      valid: true,
      width: 612,
      height: 132,
      bytes: 1_024,
      sha256: 'c'.repeat(64),
    },
    git: { clean: true, head: GIT_HEAD },
    build: {
      schemaVersion: VISUAL_ACCEPTANCE_BUILD_SCHEMA,
      gitHead: GIT_HEAD,
      buildId: BUILD_ID,
      dirty: false,
      runtime: 'repo-dist',
      runtimeArtifact: { path: 'index.js', sha256: 'e'.repeat(64), bytes: 1_024 },
    },
    platform: { target: 'windows', runtimePlatform: 'win32', arch: 'x64', node: 'v22.0.0' },
    response: { matched: true, sha256: 'd'.repeat(64), bytes: 8 },
    checks: [
      'target-platform',
      'git-clean',
      'plugin-build-provenance',
      'live-agent-session',
      'png-valid',
      'production-image-landing',
      'nonce-not-seeded',
      'exact-message-turn',
      'same-session-response',
      'same-provider-model-response',
      'visual-nonce-readback',
      'visual-model-route',
      'nonce-output-boundary',
      'cleanup',
      'git-clean-after',
    ].map((id) => ({ id, status: 'pass' as const, actual: 'pass' })),
    cleanup: 'pass',
    startedAt: new Date(1).toISOString(),
    finishedAt: new Date(2).toISOString(),
  }
}
