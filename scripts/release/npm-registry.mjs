import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { URL } from 'node:url'
import { sha256 } from './lib.mjs'

const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const MAX_METADATA_BYTES = 1_000_000

function contentLength(response) {
  const value = response.headers?.get?.('content-length')
  if (value === null || value === undefined || value === '') return undefined
  if (!/^\d+$/u.test(value)) throw new Error('Registry response has an invalid Content-Length')
  const length = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(length)) throw new Error('Registry response is too large')
  return length
}

async function boundedResponse(response, maximum) {
  const declared = contentLength(response)
  if (declared !== undefined && declared > maximum)
    throw new Error('Registry response is too large')
  if (response.body?.getReader === undefined) {
    const content = Buffer.from(await response.arrayBuffer())
    if (content.length > maximum) throw new Error('Registry response is too large')
    return content
  }

  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new Error('Registry response is too large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, length)
}

function registryPackageUrl(name, version) {
  return `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

function safeRegistryUrl(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Registry metadata has an invalid ${label} URL`)
  }
  if (
    url.origin !== REGISTRY_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== ''
  ) {
    throw new Error(`Registry ${label} URL must use the credential-free official npm registry`)
  }
  return url
}

function safeTarballUrl(value) {
  return safeRegistryUrl(value, 'tarball').href
}

function unknown(reason) {
  return { status: 'unknown', reason }
}

function conflict(reason, details = {}) {
  return { status: 'conflict', reason, ...details }
}

function parseJson(content, label) {
  try {
    return JSON.parse(content.toString('utf8'))
  } catch {
    throw new Error(`${label} is invalid JSON`)
  }
}

async function inspectNpmArtifactCore(record, options) {
  const fetcher = options.fetcher
  if (typeof fetcher !== 'function') return unknown('fetch-unavailable')
  let artifact
  try {
    artifact = await readFile(join(options.artifacts, record.file))
  } catch {
    return unknown('local-artifact-unreadable')
  }
  if (sha256(artifact) !== record.sha256) return conflict('local-sha256')

  const timeoutMs = options.timeoutMs ?? 30_000
  let metadataResponse
  try {
    metadataResponse = await fetcher(registryPackageUrl(record.name, record.version), {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return unknown('metadata-request-failed')
  }
  if (metadataResponse.status === 404) return { status: 'absent' }
  if (!metadataResponse.ok) return unknown(`metadata-http-${String(metadataResponse.status)}`)

  let metadata
  try {
    metadata = parseJson(
      await boundedResponse(metadataResponse, MAX_METADATA_BYTES),
      'Registry metadata',
    )
  } catch {
    return unknown('metadata-invalid')
  }
  if (metadata?.name !== record.name || metadata?.version !== record.version) {
    return conflict('metadata-identity')
  }

  let tarballUrl
  try {
    tarballUrl = safeTarballUrl(metadata?.dist?.tarball)
  } catch {
    return conflict('metadata-tarball-url')
  }
  let tarballResponse
  try {
    tarballResponse = await fetcher(tarballUrl, {
      headers: { accept: 'application/octet-stream' },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return unknown('tarball-request-failed')
  }
  if (!tarballResponse.ok) return unknown(`tarball-http-${String(tarballResponse.status)}`)
  let tarball
  try {
    tarball = await boundedResponse(tarballResponse, artifact.length)
  } catch {
    return conflict('tarball-size')
  }
  const registryTarballSha256 = sha256(tarball)
  if (tarball.length !== artifact.length || registryTarballSha256 !== record.sha256) {
    return conflict('tarball-sha256', { registryTarballSha256 })
  }
  return { status: 'matching', registryTarballSha256 }
}

/** Inspect public npm state using only production network and Sigstore adapters. */
export async function inspectNpmArtifact(record, options = {}) {
  const injected = ['fetcher'].filter((key) => options[key] !== undefined)
  if (injected.length > 0) {
    throw new Error(
      `Production npm inspection does not accept injected adapters: ${injected.join(', ')}`,
    )
  }
  return inspectNpmArtifactCore(record, {
    ...options,
    fetcher: globalThis.fetch,
  })
}

/** Test-only inspection with an injected registry adapter. */
export async function inspectNpmArtifactForTest(record, options = {}) {
  if (typeof options.fetcher !== 'function') {
    throw new Error('Simulated npm inspection requires an injected fetcher')
  }
  const result = await inspectNpmArtifactCore(record, options)
  return { ...result, simulated: true }
}
