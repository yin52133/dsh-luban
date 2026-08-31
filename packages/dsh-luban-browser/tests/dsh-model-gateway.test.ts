import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshModelGateway } from '../src/dsh-model-gateway.js'

const gateways = new Set<DshModelGateway>()

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...gateways].map(async (gateway): Promise<void> => {
      await gateway.close()
      gateways.delete(gateway)
    }),
  )
})

describe('DshModelGateway', (): void => {
  it('uses the current DSH model route and returns assembled text over loopback', async (): Promise<void> => {
    const calls: GenerateOptions[] = []
    const stream = vi.fn((options: GenerateOptions): AsyncIterable<StreamChunk> => {
      calls.push(options)
      return chunks()
    })
    const gateway = new DshModelGateway(() => ({
      llm: { stream },
      currentSelection: () => ({ provider: 'configured', model: 'model-a' }),
    }))
    gateways.add(gateway)
    const environment = await gateway.start()
    const response = await fetch(environment.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${environment.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'browser system' },
          { role: 'user', content: 'read the page' },
        ],
        outputSchema: {
          type: 'object',
          required: ['nonce'],
          properties: { nonce: { type: 'string' } },
        },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      text: '{"nonce":"value"}',
      stopReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 4 },
    })
    expect(stream).toHaveBeenCalledOnce()
    expect(calls[0]).toMatchObject({ provider: 'configured', model: 'model-a' })
    expect(calls[0]?.system).toContain('Return only valid JSON matching this JSON Schema')
    expect(calls[0]?.system).toContain('browser system')
    expect(calls[0]?.messages).toHaveLength(1)
    expect(calls[0]?.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'read the page' }],
      source: { kind: 'plugin', plugin: 'dsh-luban-browser' },
    })
  })

  it('does not accept requests without the ephemeral token', async (): Promise<void> => {
    const gateway = new DshModelGateway(() => ({
      llm: { stream: (): AsyncIterable<StreamChunk> => chunks() },
      currentSelection: () => ({ provider: 'configured', model: 'model-a' }),
    }))
    gateways.add(gateway)
    const environment = await gateway.start()

    const response = await fetch(environment.url, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'question' }] }),
    })

    expect(response.status).toBe(404)
  })

  it('fails before listening when DSH has no usable default model', async (): Promise<void> => {
    const gateway = new DshModelGateway(() => ({
      llm: { stream: (): AsyncIterable<StreamChunk> => chunks() },
      currentSelection: () => ({ provider: '', model: '' }),
    }))
    gateways.add(gateway)

    await expect(gateway.start()).rejects.toMatchObject({ code: 'E_BROWSER_UNAVAILABLE' })
  })
})

async function* chunks(): AsyncIterable<StreamChunk> {
  await Promise.resolve()
  yield { type: 'text-delta', index: 0, text: '{"nonce":"value"}' }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
