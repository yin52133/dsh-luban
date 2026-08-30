import { createHash } from 'node:crypto'
import type {
  ProviderRequestIdentityAdapter,
  ProviderRequestIdentityAttestation,
  ProviderRequestIdentityQuery,
} from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'

const ADAPTER_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u
const CHALLENGE = /^[A-Za-z0-9][A-Za-z0-9_-]{31,127}$/u
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA256 = /^[a-f0-9]{64}$/u

export interface HudProviderRequestIdentityEvidence {
  readonly schemaVersion: 'dsh-luban/provider-request-identity-evidence/v1'
  readonly adapter: {
    readonly id: string
    readonly version: string
    readonly runtimeSha256: string
  }
  readonly binding: {
    readonly sessionIdSha256: string
    readonly assistantEventSeq: number
    readonly turn: number
    readonly step: number
    readonly assistantMessageIdSha256: string
    readonly provider: string
    readonly model: string
    readonly challengeSha256: string
  }
  readonly providerRequestIdSha256: string
}

export interface ResolvedHudProviderRequestIdentity {
  readonly attestation: ProviderRequestIdentityAttestation
  readonly evidence: HudProviderRequestIdentityEvidence
}

function unavailable(message: string): LubanError {
  return new LubanError('E_UNAVAILABLE', message, { retriable: true })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every((key): boolean => Object.hasOwn(value, key))
  )
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    value.trim() === value &&
    !containsControlCharacter(value)
  )
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validQuery(query: ProviderRequestIdentityQuery): boolean {
  return (
    boundedText(query.sessionId, 128) &&
    nonNegativeInteger(query.assistantEventSeq) &&
    nonNegativeInteger(query.turn) &&
    nonNegativeInteger(query.step) &&
    boundedText(query.assistantMessageId, 128) &&
    boundedText(query.provider, 128) &&
    boundedText(query.model, 128) &&
    CHALLENGE.test(query.challenge)
  )
}

function parseAttestation(
  query: ProviderRequestIdentityQuery,
  value: unknown,
): ProviderRequestIdentityAttestation {
  if (
    !validQuery(query) ||
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'adapter', 'binding', 'providerRequestId']) ||
    value.schemaVersion !== 'dsh-luban/provider-request-identity/v1' ||
    !isRecord(value.adapter) ||
    !hasExactKeys(value.adapter, ['id', 'version', 'runtimeSha256']) ||
    typeof value.adapter.id !== 'string' ||
    !ADAPTER_ID.test(value.adapter.id) ||
    !boundedText(value.adapter.version, 128) ||
    typeof value.adapter.runtimeSha256 !== 'string' ||
    !SHA256.test(value.adapter.runtimeSha256) ||
    !isRecord(value.binding) ||
    !hasExactKeys(value.binding, [
      'sessionId',
      'assistantEventSeq',
      'turn',
      'step',
      'assistantMessageId',
      'provider',
      'model',
      'challengeSha256',
    ]) ||
    value.binding.sessionId !== query.sessionId ||
    value.binding.assistantEventSeq !== query.assistantEventSeq ||
    value.binding.turn !== query.turn ||
    value.binding.step !== query.step ||
    value.binding.assistantMessageId !== query.assistantMessageId ||
    value.binding.provider !== query.provider ||
    value.binding.model !== query.model ||
    value.binding.challengeSha256 !== sha256(query.challenge) ||
    typeof value.providerRequestId !== 'string' ||
    !PROVIDER_REQUEST_ID.test(value.providerRequestId)
  ) {
    throw unavailable('Provider request identity attestation is invalid')
  }
  return Object.freeze({
    schemaVersion: 'dsh-luban/provider-request-identity/v1',
    adapter: Object.freeze({
      id: value.adapter.id,
      version: value.adapter.version,
      runtimeSha256: value.adapter.runtimeSha256,
    }),
    binding: Object.freeze({
      sessionId: query.sessionId,
      assistantEventSeq: query.assistantEventSeq,
      turn: query.turn,
      step: query.step,
      assistantMessageId: query.assistantMessageId,
      provider: query.provider,
      model: query.model,
      challengeSha256: sha256(query.challenge),
    }),
    providerRequestId: value.providerRequestId,
  })
}

/** Validate an adapter response and derive a persistence-safe, digest-only identity. */
export async function attestHudProviderRequest(
  adapter: ProviderRequestIdentityAdapter,
  query: ProviderRequestIdentityQuery,
  signal: AbortSignal,
): Promise<ResolvedHudProviderRequestIdentity> {
  if (!validQuery(query)) throw unavailable('Provider request identity query is invalid')
  let value: unknown
  try {
    signal.throwIfAborted()
    value = await adapter.attest(Object.freeze({ ...query }), signal)
    signal.throwIfAborted()
  } catch {
    throw unavailable('Provider request identity adapter is unavailable')
  }
  const attestation = parseAttestation(query, value)
  return Object.freeze({
    attestation,
    evidence: Object.freeze({
      schemaVersion: 'dsh-luban/provider-request-identity-evidence/v1',
      adapter: attestation.adapter,
      binding: Object.freeze({
        sessionIdSha256: sha256(attestation.binding.sessionId),
        assistantEventSeq: attestation.binding.assistantEventSeq,
        turn: attestation.binding.turn,
        step: attestation.binding.step,
        assistantMessageIdSha256: sha256(attestation.binding.assistantMessageId),
        provider: attestation.binding.provider,
        model: attestation.binding.model,
        challengeSha256: attestation.binding.challengeSha256,
      }),
      providerRequestIdSha256: sha256(attestation.providerRequestId),
    }),
  })
}
