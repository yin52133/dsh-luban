import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { URL } from 'node:url'
import { sha256 } from './lib.mjs'

const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const MAX_METADATA_BYTES = 1_000_000
const MAX_ATTESTATION_BYTES = 4_000_000
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1'
const GITHUB_WORKFLOW_BUILD_TYPE =
  'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1'
const GITHUB_HOSTED_BUILDER = 'https://github.com/actions/runner/github-hosted'
const COMMIT_SHA = /^[a-f0-9]{40,64}$/u
let sigstoreModule

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

function safeAttestationsUrl(value, record) {
  const url = safeRegistryUrl(value, 'attestations')
  const prefix = '/-/npm/v1/attestations/'
  if (!url.pathname.startsWith(prefix)) {
    throw new Error('Registry attestations URL has an invalid path')
  }
  let identity
  try {
    identity = decodeURIComponent(url.pathname.slice(prefix.length))
  } catch {
    throw new Error('Registry attestations URL has invalid encoding')
  }
  if (identity !== `${record.name}@${record.version}`) {
    throw new Error('Registry attestations URL does not match the package identity')
  }
  return url.href
}

function unknown(reason) {
  return { status: 'unknown', reason }
}

function conflict(reason, details = {}) {
  return { status: 'conflict', reason, ...details }
}

function sha512(content) {
  return createHash('sha512').update(content).digest('hex')
}

function npmPackagePurl(record) {
  const [scope, packageName] = record.name.startsWith('@') ? record.name.split('/') : []
  const encodedName =
    packageName === undefined
      ? encodeURIComponent(record.name)
      : `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`
  return `pkg:npm/${encodedName}@${encodeURIComponent(record.version)}`
}

function parseJson(content, label) {
  try {
    return JSON.parse(content.toString('utf8'))
  } catch {
    throw new Error(`${label} is invalid JSON`)
  }
}

function decodeDsseStatement(bundle) {
  const payload = bundle?.dsseEnvelope?.payload
  const signatures = bundle?.dsseEnvelope?.signatures
  if (
    typeof payload !== 'string' ||
    payload.length === 0 ||
    payload.length > MAX_ATTESTATION_BYTES * 2 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload) ||
    !Array.isArray(signatures) ||
    signatures.length === 0
  ) {
    throw new Error('Registry provenance DSSE envelope is invalid')
  }
  return parseJson(Buffer.from(payload, 'base64'), 'Registry provenance statement')
}

function provenanceBinding(statement, record, artifact, expected) {
  if (
    statement?._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== SLSA_PROVENANCE_V1 ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1 ||
    statement.subject[0]?.name !== npmPackagePurl(record) ||
    statement.subject[0]?.digest?.sha512 !== sha512(artifact)
  ) {
    throw new Error('Registry provenance subject does not match the immutable tarball')
  }
  const build = statement.predicate?.buildDefinition
  const workflow = build?.externalParameters?.workflow
  const github = build?.internalParameters?.github
  const runDetails = statement.predicate?.runDetails
  const repositoryUrl = `https://github.com/${expected.repository}`
  const expectedUri = `git+${repositoryUrl}@${expected.ref}`
  const dependencies = Array.isArray(build?.resolvedDependencies)
    ? build.resolvedDependencies.filter(
        (candidate) =>
          candidate?.uri === expectedUri && candidate?.digest?.gitCommit === expected.workflowSha,
      )
    : []
  const expectedInvocation = `https://github.com/${expected.repository}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`
  let invocation
  try {
    invocation = new URL(runDetails?.metadata?.invocationId)
  } catch {
    throw new Error('Registry provenance has an invalid GitHub Actions invocation identity')
  }
  if (
    build?.buildType !== GITHUB_WORKFLOW_BUILD_TYPE ||
    workflow?.repository !== repositoryUrl ||
    workflow?.path !== expected.workflowPath ||
    workflow?.ref !== expected.ref ||
    github?.event_name !== expected.eventName ||
    github?.repository_id !== expected.repositoryId ||
    github?.repository_owner_id !== expected.repositoryOwnerId ||
    runDetails?.builder?.id !== GITHUB_HOSTED_BUILDER ||
    expected.runnerEnvironment !== 'github-hosted' ||
    invocation.href !== expectedInvocation ||
    dependencies.length !== 1
  ) {
    throw new Error('Registry provenance is not bound to the expected GitHub workflow commit')
  }
  return {
    verified: true,
    predicateType: SLSA_PROVENANCE_V1,
    repository: expected.repository,
    workflowPath: expected.workflowPath,
    ref: expected.ref,
    commitSha: expected.commitSha,
    workflowRef: expected.workflowRef,
    workflowSha: expected.workflowSha,
    eventName: expected.eventName,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    runnerEnvironment: expected.runnerEnvironment,
    invocationId: invocation.href,
    repositoryId: expected.repositoryId,
    repositoryOwnerId: expected.repositoryOwnerId,
    subjectSha512: statement.subject[0].digest.sha512,
  }
}

function validateExpectedProvenance(expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error('Expected npm provenance context is required')
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(expected.repository ?? '')) {
    throw new Error('Expected npm provenance repository must be owner/name')
  }
  if (expected.workflowPath !== '.github/workflows/release.yml') {
    throw new Error('Expected npm provenance workflow path is invalid')
  }
  if (typeof expected.ref !== 'string' || !expected.ref.startsWith('refs/tags/v')) {
    throw new Error('Expected npm provenance ref must be a version tag')
  }
  if (!COMMIT_SHA.test(expected.commitSha ?? '')) {
    throw new Error('Expected npm provenance commit SHA is invalid')
  }
  if (!/^[1-9]\d*$/u.test(expected.repositoryId ?? '')) {
    throw new Error('Expected npm provenance repository ID is invalid')
  }
  if (!/^[1-9]\d*$/u.test(expected.repositoryOwnerId ?? '')) {
    throw new Error('Expected npm provenance repository owner ID is invalid')
  }
  if (
    expected.eventName !== 'push' ||
    !/^[1-9]\d*$/u.test(expected.runId ?? '') ||
    !/^[1-9]\d*$/u.test(expected.runAttempt ?? '') ||
    expected.runnerEnvironment !== 'github-hosted'
  ) {
    throw new Error('Expected npm provenance workflow attempt is invalid')
  }
  if (
    expected.workflowRef !== `${expected.repository}/${expected.workflowPath}@${expected.ref}` ||
    expected.workflowSha !== expected.commitSha
  ) {
    throw new Error('Expected npm provenance workflow authority is invalid')
  }
}

async function loadNpmBundledSigstore() {
  if (sigstoreModule !== undefined) return sigstoreModule
  const executableDirectory = dirname(process.execPath)
  const candidates = [
    join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const npmCli of candidates) {
    try {
      await access(npmCli)
      const require = createRequire(npmCli)
      const candidate = require('sigstore')
      if (typeof candidate?.verify === 'function') {
        sigstoreModule = candidate
        return candidate
      }
    } catch {
      // Continue to the next trusted Node/npm installation layout.
    }
  }
  const error = new Error(
    "The Node.js installation does not expose npm's bundled Sigstore verifier",
  )
  error.code = 'E_SIGSTORE_UNAVAILABLE'
  throw error
}

/** Verify the exact registry-returned bundle with npm's bundled official Sigstore library. */
export async function verifyExactSigstoreBundle(bundle, options = {}) {
  validateExpectedProvenance(options.provenance)
  const sigstore = await loadNpmBundledSigstore()
  await sigstore.verify(bundle, {
    certificateIdentityURI: `https://github.com/${options.provenance.workflowRef}`,
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    retry: 0,
    timeout: options.timeoutMs ?? 60_000,
  })
  return true
}

async function inspectProvenance(metadata, record, artifact, expected, options) {
  try {
    validateExpectedProvenance(expected)
  } catch {
    return conflict('provenance-expectation')
  }
  if (metadata?.dist?.attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1) {
    return conflict('provenance-missing')
  }
  let attestationsUrl
  try {
    attestationsUrl = safeAttestationsUrl(metadata.dist.attestations.url, record)
  } catch {
    return conflict('provenance-url')
  }
  let response
  try {
    response = await options.fetcher(attestationsUrl, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(options.timeoutMs),
    })
  } catch {
    return unknown('provenance-request-failed')
  }
  if (!response.ok) {
    return response.status === 404
      ? conflict('provenance-missing')
      : unknown(`provenance-http-${String(response.status)}`)
  }
  let payload
  try {
    payload = parseJson(
      await boundedResponse(response, MAX_ATTESTATION_BYTES),
      'Registry attestations',
    )
  } catch {
    return conflict('provenance-invalid')
  }
  const matching = Array.isArray(payload?.attestations)
    ? payload.attestations.filter((candidate) => candidate?.predicateType === SLSA_PROVENANCE_V1)
    : []
  if (matching.length !== 1) return conflict('provenance-ambiguous')
  const bundle = matching[0].bundle
  let bundleSha256
  let provenance
  try {
    bundleSha256 = sha256(Buffer.from(JSON.stringify(bundle)))
    provenance = provenanceBinding(decodeDsseStatement(bundle), record, artifact, expected)
  } catch {
    return conflict('provenance-binding')
  }
  let signatureVerified
  try {
    signatureVerified = await options.verifyBundle(bundle, {
      provenance: expected,
      timeoutMs: options.signatureTimeoutMs,
    })
  } catch {
    return unknown('provenance-verification-failed')
  }
  if (signatureVerified !== true) return conflict('provenance-signature')
  return {
    status: 'matching',
    trusted: true,
    provenance: { ...provenance, bundleSha256 },
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
  if (options.provenance === undefined) {
    return { status: 'matching', trusted: false, registryTarballSha256 }
  }
  const provenance = await inspectProvenance(metadata, record, artifact, options.provenance, {
    fetcher,
    timeoutMs,
    signatureTimeoutMs: options.signatureTimeoutMs,
    verifyBundle: options.verifyBundle,
  })
  return { ...provenance, registryTarballSha256 }
}

/** Inspect public npm state using only production network and Sigstore adapters. */
export async function inspectNpmArtifact(record, options = {}) {
  const injected = ['fetcher', 'verifyBundle', 'verifySignatures'].filter(
    (key) => options[key] !== undefined,
  )
  if (injected.length > 0) {
    throw new Error(
      `Production npm inspection does not accept injected adapters: ${injected.join(', ')}`,
    )
  }
  return inspectNpmArtifactCore(record, {
    ...options,
    fetcher: globalThis.fetch,
    verifyBundle: verifyExactSigstoreBundle,
  })
}

/** Test-only inspection: injected adapters are isolated and can never produce trusted evidence. */
export async function inspectNpmArtifactForTest(record, options = {}) {
  if (typeof options.fetcher !== 'function') {
    throw new Error('Simulated npm inspection requires an injected fetcher')
  }
  const result = await inspectNpmArtifactCore(record, {
    ...options,
    verifyBundle: options.verifyBundle ?? (async () => false),
  })
  return {
    ...result,
    simulated: true,
    trusted: false,
    wouldTrust: result.trusted === true,
  }
}
