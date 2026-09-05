import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as DshSessionId } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@yin52133/dsh-luban-core'
import { LubanError } from '@yin52133/dsh-luban-core'
import type {
  ImageInjectionOptions,
  InjectStyle,
  SessionImageInjector,
  StoredImage,
} from './types.js'

function markdownTarget(path: string): string {
  return path
    .split('/')
    .map((segment): string =>
      encodeURIComponent(segment).replaceAll('(', '%28').replaceAll(')', '%29'),
    )
    .join('/')
}

function extraInstruction(options: ImageInjectionOptions | undefined): string | undefined {
  const instruction = options?.instruction?.trim()
  if (instruction === undefined || instruction === '') return undefined
  if (instruction.length > 1_000 || /[\0\r]/u.test(instruction)) {
    throw new LubanError('E_INVALID_INPUT', 'image instruction is invalid')
  }
  return instruction
}

export function imagePrompt(
  image: StoredImage,
  style: InjectStyle,
  options?: ImageInjectionOptions,
): string {
  const heading = '[Luban image attachment]'
  const checksum = `SHA-256: ${image.sha256}`
  const instruction = extraInstruction(options)
  if (style === 'markdown') {
    return [
      heading,
      `![${image.originalName}](${markdownTarget(image.relPath)})`,
      `Workspace-relative path: ${image.relPath}`,
      checksum,
      'Read the workspace-relative file when inspecting the image.',
      ...(instruction === undefined ? [] : [instruction]),
    ].join('\n')
  }
  return [
    heading,
    `Absolute path: ${image.absPath}`,
    `Workspace-relative path: ${image.relPath}`,
    checksum,
    'Read this file when inspecting the image.',
    ...(instruction === undefined ? [] : [instruction]),
  ].join('\n')
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function isTopLevelRoot(agents: AgentRegistry, agent: Agent): boolean {
  const header = agent.session.header
  if (header.origin === 'subagent') return false
  if (header.delegationDepth !== undefined && header.delegationDepth !== 0) return false
  return agents.roots().includes(agent)
}

/**
 * Deliver a durable image reference only to a verifiable live, top-level DSH agent.
 *
 * Cold resume requires the Host-owned persistence, preset composition, and
 * ownership resolver. Reconstructing a session from an id alone can run it with
 * the wrong model, tools, or prompt, so this boundary deliberately fails closed.
 */
export class DshImageSessionInjector implements SessionImageInjector {
  readonly #agents: AgentRegistry
  readonly #workspaceRoot: string
  readonly #expectedAgent: Agent | undefined

  public constructor(agents: AgentRegistry, workspaceRoot: string, expectedAgent?: Agent) {
    this.#agents = agents
    this.#workspaceRoot = workspaceRoot
    this.#expectedAgent = expectedAgent
  }

  public async inject(
    sessionId: SessionId,
    image: StoredImage,
    style: InjectStyle,
    options?: ImageInjectionOptions,
  ): Promise<void> {
    if (sessionId.trim() === '' || sessionId.length > 512) {
      throw new LubanError('E_INVALID_INPUT', 'sessionId is invalid')
    }
    const id = DshSessionId(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: imagePrompt(image, style, options) }],
      source: { kind: 'plugin', plugin: 'dsh-luban-image-paste' },
    })
    options?.onPreparedMessage?.(message.id)
    const live = this.#agents.get(id)
    if (live === undefined) {
      throw new LubanError(
        'E_UNAVAILABLE',
        `DSH session ${sessionId} is not live; safe cold resume is unavailable`,
        { retriable: true },
      )
    }
    const expectedAgent = options?.expectedAgent ?? this.#expectedAgent
    if (expectedAgent !== undefined && live !== expectedAgent) {
      throw new LubanError(
        'E_UNAVAILABLE',
        `DSH session ${sessionId} changed live agent identity`,
        {
          retriable: true,
        },
      )
    }
    if (!isTopLevelRoot(this.#agents, live)) {
      throw new LubanError(
        'E_INVALID_TRANSITION',
        `DSH session ${sessionId} is not a top-level agent root`,
      )
    }
    const sessionCwd = live.session.header.cwd
    if (sessionCwd === undefined) {
      throw new LubanError('E_INVALID_TRANSITION', `DSH session ${sessionId} has no workspace`)
    }
    let canonicalCwd: string
    try {
      canonicalCwd = await realpath(sessionCwd)
    } catch (error: unknown) {
      throw new LubanError('E_UNAVAILABLE', `DSH session ${sessionId} workspace is unavailable`, {
        retriable: true,
        cause: error,
      })
    }
    if (!samePath(canonicalCwd, this.#workspaceRoot)) {
      throw new LubanError(
        'E_INVALID_TRANSITION',
        `DSH session ${sessionId} belongs to a different workspace`,
      )
    }
    if (this.#agents.get(id) !== live) {
      throw new LubanError('E_UNAVAILABLE', `DSH session ${sessionId} is no longer live`, {
        retriable: true,
      })
    }
    if (!isTopLevelRoot(this.#agents, live)) {
      throw new LubanError(
        'E_INVALID_TRANSITION',
        `DSH session ${sessionId} is no longer a top-level agent root`,
      )
    }
    options?.signal?.throwIfAborted()
    options?.onBeforeQueueMessage?.(message.id)
    live.followup(message)
    if (options?.queueReceipt !== undefined) {
      options.queueReceipt.queued = true
      options.queueReceipt.messageId = message.id
    }
  }
}
