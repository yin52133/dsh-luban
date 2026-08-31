import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  BlockAssembler,
  createMessage,
  type LlmRuntime,
  type Message,
  type ReasoningEffortId,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { BrowserError } from './errors.js'

const MODEL_PATH = '/v1/browser-use/complete'
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

export interface DshModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffortId
}

export interface DshModelAccess {
  readonly llm: Pick<LlmRuntime, 'stream'>
  readonly currentSelection: () => DshModelSelection
}

export interface DshModelGatewayEnvironment {
  readonly url: string
  readonly token: string
}

export interface BrowserModelGateway {
  start(): Promise<DshModelGatewayEnvironment>
  close(): Promise<void>
}

interface BrowserUseMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string | readonly BrowserUseContent[] | null
  readonly refusal?: string
  readonly tool_calls?: readonly BrowserUseToolCall[]
}

interface BrowserUseContent {
  readonly type: 'text' | 'refusal'
  readonly text?: string
  readonly refusal?: string
}

interface BrowserUseToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

interface BrowserUseModelRequest {
  readonly messages: readonly BrowserUseMessage[]
  readonly outputSchema?: Readonly<Record<string, unknown>>
}

/** Short-lived loopback bridge from browser-use to DSH's already configured model route. */
export class DshModelGateway implements BrowserModelGateway {
  readonly #resolveAccess: () => DshModelAccess
  #server: Server | null = null
  #access: DshModelAccess | null = null
  #environment: DshModelGatewayEnvironment | null = null
  #starting: Promise<DshModelGatewayEnvironment> | null = null

  public constructor(resolveAccess: () => DshModelAccess) {
    this.#resolveAccess = resolveAccess
  }

  public start(): Promise<DshModelGatewayEnvironment> {
    if (this.#environment !== null) return Promise.resolve(this.#environment)
    if (this.#starting !== null) return this.#starting
    const operation = this.#start()
    this.#starting = operation
    return operation.finally((): void => {
      if (this.#starting === operation) this.#starting = null
    })
  }

  async #start(): Promise<DshModelGatewayEnvironment> {
    const access = this.#resolveAccess()
    const selection = access.currentSelection()
    assertSelection(selection)
    const token = randomBytes(32).toString('hex')
    const server = createServer((request, response): void => {
      void this.#handle(request, response, token)
    })
    try {
      await listen(server)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('loopback listener did not expose a TCP address')
      }
      const environment = Object.freeze({
        url: `http://127.0.0.1:${String(address.port)}${MODEL_PATH}`,
        token,
      })
      this.#access = access
      this.#server = server
      this.#environment = environment
      return environment
    } catch {
      await closeServer(server)
      throw new BrowserError(
        'E_BROWSER_UNAVAILABLE',
        'Unable to start the local DSH model bridge',
        true,
      )
    }
  }

  public async close(): Promise<void> {
    await this.#starting?.catch((): undefined => undefined)
    const server = this.#server
    this.#server = null
    this.#access = null
    this.#environment = null
    if (server !== null) await closeServer(server)
  }

  async #handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    try {
      if (
        request.method !== 'POST' ||
        request.url !== MODEL_PATH ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        sendJson(response, 404, { error: 'not-found' })
        return
      }
      const payload = parseRequest(JSON.parse(await readBody(request)) as unknown)
      const result = await this.#complete(payload, request)
      sendJson(response, 200, result)
    } catch (error: unknown) {
      const code = error instanceof RequestError ? error.status : 502
      sendJson(response, code, { error: 'model-request-failed' })
    }
  }

  async #complete(
    request: BrowserUseModelRequest,
    incoming: IncomingMessage,
  ): Promise<Readonly<{ text: string; stopReason: string; usage?: TokenUsage }>> {
    const access = this.#access
    if (access === null) throw new Error('DSH model bridge is not started')
    const selection = access.currentSelection()
    assertSelection(selection)
    const projected = projectMessages(request.messages, selection)
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    incoming.once('aborted', abort)
    try {
      const assembler = new BlockAssembler()
      for await (const chunk of access.llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
        messages: projected.messages,
        ...(projected.system === '' ? {} : { system: projected.system }),
        signal: controller.signal,
      })) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error('DSH model call failed')
      }
      const text = assembler
        .blocks()
        .flatMap((block): string[] => (block.type === 'text' ? [block.text] : []))
        .join('')
      if (text.trim() === '') throw new Error('DSH model returned no text')
      return Object.freeze({
        text,
        stopReason: finish.kind,
        ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      })
    } finally {
      incoming.off('aborted', abort)
    }
  }
}

function projectMessages(
  messages: readonly BrowserUseMessage[],
  selection: DshModelSelection,
): Readonly<{ system: string; messages: Message[] }> {
  const system: string[] = []
  const projected: Message[] = []
  for (const message of messages) {
    const text = messageText(message)
    if (message.role === 'system') {
      system.push(text)
      continue
    }
    projected.push(
      createMessage({
        role: message.role,
        content: [{ type: 'text', text }],
        source:
          message.role === 'assistant'
            ? { kind: 'model', provider: selection.provider, model: selection.model }
            : { kind: 'plugin', plugin: 'dsh-luban-browser' },
      }),
    )
  }
  return Object.freeze({ system: system.join('\n\n'), messages: projected })
}

function messageText(message: BrowserUseMessage): string {
  const parts: string[] = []
  if (typeof message.content === 'string') parts.push(message.content)
  else if (message.content !== null) {
    for (const part of message.content) {
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      else if (part.type === 'refusal' && typeof part.refusal === 'string') parts.push(part.refusal)
      else throw new RequestError(400)
    }
  }
  if (typeof message.refusal === 'string') parts.push(message.refusal)
  for (const call of message.tool_calls ?? []) {
    parts.push(`Tool call ${call.function.name}: ${call.function.arguments}`)
  }
  const text = parts.join('\n')
  if (text.length > MAX_REQUEST_BYTES) throw new RequestError(413)
  return text
}

function parseRequest(value: unknown): BrowserUseModelRequest {
  if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length === 0) {
    throw new RequestError(400)
  }
  const messages = value.messages.map(parseMessage)
  const outputSchema = value.outputSchema
  if (outputSchema !== undefined && !isRecord(outputSchema)) throw new RequestError(400)
  if (outputSchema !== undefined) {
    const schema = JSON.stringify(outputSchema)
    messages.unshift({
      role: 'system',
      content: `Return only valid JSON matching this JSON Schema exactly. Do not use Markdown fences.\n${schema}`,
    })
  }
  return Object.freeze({
    messages: Object.freeze(messages),
    ...(outputSchema === undefined ? {} : { outputSchema: Object.freeze({ ...outputSchema }) }),
  })
}

function parseMessage(value: unknown): BrowserUseMessage {
  if (
    !isRecord(value) ||
    !['system', 'user', 'assistant'].includes(String(value.role)) ||
    !(typeof value.content === 'string' || value.content === null || Array.isArray(value.content))
  ) {
    throw new RequestError(400)
  }
  const content =
    typeof value.content === 'string' || value.content === null
      ? value.content
      : value.content.map(parseContent)
  const toolCalls = value.tool_calls
  if (toolCalls !== undefined && !Array.isArray(toolCalls)) throw new RequestError(400)
  return Object.freeze({
    role: value.role as BrowserUseMessage['role'],
    content,
    ...(typeof value.refusal === 'string' ? { refusal: value.refusal } : {}),
    ...(toolCalls === undefined ? {} : { tool_calls: Object.freeze(toolCalls.map(parseToolCall)) }),
  })
}

function parseContent(value: unknown): BrowserUseContent {
  if (!isRecord(value) || !['text', 'refusal'].includes(String(value.type))) {
    throw new RequestError(400)
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return Object.freeze({ type: 'text', text: value.text })
  }
  if (value.type === 'refusal' && typeof value.refusal === 'string') {
    return Object.freeze({ type: 'refusal', refusal: value.refusal })
  }
  throw new RequestError(400)
}

function parseToolCall(value: unknown): BrowserUseToolCall {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.type !== 'function' ||
    !isRecord(value.function) ||
    typeof value.function.name !== 'string' ||
    typeof value.function.arguments !== 'string'
  ) {
    throw new RequestError(400)
  }
  return Object.freeze({
    id: value.id,
    type: 'function',
    function: Object.freeze({ name: value.function.name, arguments: value.function.arguments }),
  })
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw new RequestError(400)
    }
    const bytes = Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_REQUEST_BYTES) throw new RequestError(413)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function assertSelection(selection: DshModelSelection): void {
  if (selection.provider.trim() === '' || selection.model.trim() === '') {
    throw new BrowserError(
      'E_BROWSER_UNAVAILABLE',
      'DSH default model is not configured for browser automation',
      true,
    )
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject): void => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, (): void => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve): void => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close((): void => resolve())
    server.closeAllConnections()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class RequestError extends Error {
  public constructor(public readonly status: number) {
    super('Invalid model bridge request')
  }
}
