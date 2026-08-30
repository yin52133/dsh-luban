import { mkdir, mkdtemp, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { asSessionId } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imagePrompt } from '../src/dsh-injection.js'
import {
  createVisualAcceptanceRoot,
  createVisualTurnTracker,
  findUnexpectedPostTurnNonceLeaks,
  findVisualNonceLeaks,
  inspectVisualAcceptancePlatform,
  isOwnedVisualAcceptanceRoot,
  observeVisualTurn,
  removeVisualAcceptanceRoot,
  runSimulatedVisualAcceptance,
  visualAcceptanceInstruction,
  type VisualTurnObservation,
} from '../src/live-visual-acceptance.js'
import { visualAcceptanceCliResult } from '../src/live-visual-acceptance-cli.js'
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

  it('keeps the standalone CLI plan-only and fail-closed for live requests', () => {
    expect(visualAcceptanceCliResult({ live: false, help: false })).toMatchObject({
      status: 'planned',
      acceptancePassed: false,
    })
    expect(
      visualAcceptanceCliResult({
        live: true,
        help: false,
        sessionId: SESSION,
      }),
    ).toMatchObject({
      status: 'blocked',
      evidenceKind: 'none',
      acceptancePassed: false,
      requiredEntry: 'ctx.lubanImageVisualAcceptance.run',
    })
    expect(
      visualAcceptanceCliResult({ live: true, help: false, sessionId: SESSION }),
    ).not.toHaveProperty('providerEnvName')
  })
})
