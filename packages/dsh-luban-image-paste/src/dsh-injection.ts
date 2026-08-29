import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as DshSessionId } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@luban/core'
import { LubanError } from '@luban/core'
import type { InjectStyle, SessionImageInjector, StoredImage } from './types.js'

function markdownTarget(path: string): string {
  return path
    .split('/')
    .map((segment): string =>
      encodeURIComponent(segment).replaceAll('(', '%28').replaceAll(')', '%29'),
    )
    .join('/')
}

export function imagePrompt(image: StoredImage, style: InjectStyle): string {
  const heading = '[Luban image attachment]'
  const checksum = `SHA-256: ${image.sha256}`
  if (style === 'markdown') {
    return [
      heading,
      `![${image.originalName}](${markdownTarget(image.relPath)})`,
      `Workspace-relative path: ${image.relPath}`,
      checksum,
      'Read the workspace-relative file when inspecting the image.',
    ].join('\n')
  }
  return [
    heading,
    `Absolute path: ${image.absPath}`,
    `Workspace-relative path: ${image.relPath}`,
    checksum,
    'Read this file when inspecting the image.',
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
 * Cold rc2 resume requires the Host-owned persistence, preset composition, and
 * ownership resolver. Reconstructing a session from an id alone can run it with
 * the wrong model, tools, or prompt, so this boundary deliberately fails closed.
 */
export class DshImageSessionInjector implements SessionImageInjector {
  readonly #agents: AgentRegistry
  readonly #workspaceRoot: string

  public constructor(agents: AgentRegistry, workspaceRoot: string) {
    this.#agents = agents
    this.#workspaceRoot = workspaceRoot
  }

  public async inject(sessionId: SessionId, image: StoredImage, style: InjectStyle): Promise<void> {
    if (sessionId.trim() === '' || sessionId.length > 512) {
      throw new LubanError('E_INVALID_INPUT', 'sessionId is invalid')
    }
    const id = DshSessionId(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: imagePrompt(image, style) }],
      source: { kind: 'plugin', plugin: 'dsh-luban-image-paste' },
    })
    const live = this.#agents.get(id)
    if (live === undefined) {
      throw new LubanError(
        'E_UNAVAILABLE',
        `DSH session ${sessionId} is not live; safe cold resume is unavailable`,
        { retriable: true },
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
    live.followup(message)
  }
}
