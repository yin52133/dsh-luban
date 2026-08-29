import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PlanFeedbackEvent, PlanFeedbackSink } from './service.js'

/** Deliver durable approval facts through DSH's identified, model-visible inbox. */
export class DshPlanFeedbackSink implements PlanFeedbackSink {
  readonly #agents: AgentRegistry

  public constructor(agents: AgentRegistry) {
    this.#agents = agents
  }

  public deliver(event: PlanFeedbackEvent): void {
    if (event.sessionId === undefined) return
    const agent = this.#agents.get(SessionId(event.sessionId))
    if (agent === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: JSON.stringify(event) }],
      source: { kind: 'plugin', plugin: 'dsh-luban-plan' },
    })
    if (event.decision === undefined) agent.inject(message)
    else agent.followup(message)
  }
}
