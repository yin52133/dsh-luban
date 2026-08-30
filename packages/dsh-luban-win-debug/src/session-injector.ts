import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SnippetFile } from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import type { SessionInjection } from './types.js'

function prompt(snippet: SnippetFile): string {
  const excerpt =
    snippet.content.length <= 12_000
      ? snippet.content
      : `${snippet.content.slice(0, 6000)}\n…[truncated]…\n${snippet.content.slice(-6000)}`
  return [
    '[Luban Windows debug snippet]',
    `File: ${snippet.path}`,
    `Channel: ${snippet.endpoint.kind} · ${snippet.endpoint.label}`,
    `Endpoint metadata: ${JSON.stringify(snippet.endpoint.params)}`,
    `Window: ${new Date(snippet.timeFrom).toISOString()} — ${new Date(snippet.timeTo).toISOString()}`,
    '',
    'Excerpt:',
    '```text',
    excerpt.replaceAll('```', '``\u200b`'),
    '```',
  ].join('\n')
}

/** Inject a redacted file reference and excerpt into a live or persisted rc2 DSH session. */
export class DshSessionInjection implements SessionInjection {
  readonly #agents: AgentRegistry

  public constructor(agents: AgentRegistry) {
    this.#agents = agents
  }

  public async inject(sessionId: string, snippet: SnippetFile): Promise<void> {
    if (sessionId.trim() === '' || sessionId.length > 512) {
      throw new LubanError('E_INVALID_INPUT', 'sessionId is invalid')
    }
    const id = SessionId(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt(snippet) }],
      source: { kind: 'plugin', plugin: 'dsh-luban-win-debug' },
    })
    const live = this.#agents.get(id)
    if (live !== undefined) {
      live.followup(message)
      return
    }
    const handle = await this.#agents.resume({ resumeSessionId: id })
    try {
      handle.agent.followup(message)
      await handle.agent.whenIdle()
    } finally {
      await handle.dispose()
    }
  }
}
