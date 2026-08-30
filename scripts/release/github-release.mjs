import { Buffer } from 'node:buffer'
import { URL } from 'node:url'

const GITHUB_API_ORIGIN = 'https://api.github.com'
const MAX_GITHUB_JSON_BYTES = 2_000_000
const MAX_RELEASE_ASSETS = 1_000
const ASSETS_PER_PAGE = 100
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const COMMIT_SHA = /^[a-f0-9]{40,64}$/u

export function isGitHubRepository(value) {
  return REPOSITORY.test(value ?? '')
}

export function isCommitSha(value) {
  return COMMIT_SHA.test(value ?? '')
}

function contentLength(response) {
  const value = response.headers?.get?.('content-length')
  if (value === null || value === undefined || value === '') return undefined
  if (!/^\d+$/u.test(value)) throw new Error('GitHub response has an invalid Content-Length')
  const length = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(length)) throw new Error('GitHub response is too large')
  return length
}

export async function boundedGithubResponse(response, maximum) {
  const declared = contentLength(response)
  if (declared !== undefined && declared > maximum) throw new Error('GitHub response is too large')
  if (response.body?.getReader === undefined) {
    const content = Buffer.from(await response.arrayBuffer())
    if (content.length > maximum) throw new Error('GitHub response is too large')
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
      throw new Error('GitHub response is too large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, length)
}

function githubHeaders(token, accept = 'application/vnd.github+json') {
  return {
    accept,
    'user-agent': 'dsh-luban-release-recovery',
    'x-github-api-version': '2022-11-28',
    ...(typeof token === 'string' && token !== '' ? { authorization: `Bearer ${token}` } : {}),
  }
}

function requestOptions(repository, options = {}) {
  if (!isGitHubRepository(repository)) throw new Error('GitHub repository must be owner/name')
  const fetcher = options.fetcher ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('Global fetch is unavailable')
  return {
    fetcher,
    repository,
    timeoutMs: options.timeoutMs ?? 30_000,
    token: options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  }
}

async function githubJson(path, options, allowNotFound = false) {
  const response = await options.fetcher(`${GITHUB_API_ORIGIN}${path}`, {
    headers: githubHeaders(options.token),
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(options.timeoutMs),
  })
  if (allowNotFound && response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub read failed with HTTP ${String(response.status)}`)
  try {
    return JSON.parse(
      (await boundedGithubResponse(response, MAX_GITHUB_JSON_BYTES)).toString('utf8'),
    )
  } catch (error) {
    throw new Error('GitHub returned invalid JSON', { cause: error })
  }
}

async function resolveGithubTag(tag, options) {
  let object = (
    await githubJson(
      `/repos/${options.repository}/git/ref/tags/${encodeURIComponent(tag)}`,
      options,
    )
  )?.object
  for (let depth = 0; depth < 8; depth += 1) {
    if (object?.type === 'commit' && isCommitSha(object.sha)) return object.sha
    if (object?.type !== 'tag' || !isCommitSha(object.sha)) break
    object = (await githubJson(`/repos/${options.repository}/git/tags/${object.sha}`, options))
      ?.object
  }
  throw new Error('GitHub tag does not resolve to a bounded commit object')
}

function validateAsset(asset) {
  if (
    !Number.isSafeInteger(asset?.id) ||
    asset.id <= 0 ||
    typeof asset.name !== 'string' ||
    asset.name.trim() === '' ||
    typeof asset.url !== 'string' ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0
  ) {
    throw new Error('GitHub Release asset metadata is invalid')
  }
  return { id: asset.id, name: asset.name, size: asset.size, url: asset.url }
}

async function listReleaseAssets(releaseId, options) {
  const assets = []
  for (let page = 1; assets.length < MAX_RELEASE_ASSETS; page += 1) {
    const batch = await githubJson(
      `/repos/${options.repository}/releases/${String(releaseId)}/assets?per_page=${String(ASSETS_PER_PAGE)}&page=${String(page)}`,
      options,
    )
    if (!Array.isArray(batch)) throw new Error('GitHub Release assets response is invalid')
    assets.push(...batch.map(validateAsset))
    if (batch.length < ASSETS_PER_PAGE) break
  }
  if (assets.length >= MAX_RELEASE_ASSETS) throw new Error('GitHub Release has too many assets')
  const names = assets.map(({ name }) => name)
  if (new Set(names).size !== names.length) {
    throw new Error('GitHub Release asset names must be unique strings')
  }
  return assets
}

/** Read a tag and Release metadata, including the complete paginated asset list. */
export async function readGithubRelease(input, options = {}) {
  const request = requestOptions(input.repository, options)
  const tagCommitSha = await resolveGithubTag(input.tag, request)
  const release = await githubJson(
    `/repos/${request.repository}/releases/tags/${encodeURIComponent(input.tag)}`,
    request,
    options.allowMissing === true,
  )
  if (release === undefined) return { repository: request.repository, tagCommitSha, release: null }
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    typeof release.tag_name !== 'string' ||
    typeof release.name !== 'string' ||
    typeof release.body !== 'string' ||
    typeof release.draft !== 'boolean' ||
    typeof release.prerelease !== 'boolean'
  ) {
    throw new Error('GitHub Release response is invalid')
  }
  return {
    repository: request.repository,
    tagCommitSha,
    release: {
      id: release.id,
      tag: release.tag_name,
      title: release.name,
      body: release.body,
      draft: release.draft,
      prerelease: release.prerelease,
      assets: await listReleaseAssets(release.id, request),
    },
  }
}

function safeAssetUrl(asset, repository) {
  let url
  try {
    url = new URL(asset.url)
  } catch {
    throw new Error(`${asset.name}: GitHub asset URL is invalid`)
  }
  const prefix = `/repos/${repository}/releases/assets/`.toLowerCase()
  const pathname = url.pathname.toLowerCase()
  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    !pathname.startsWith(prefix) ||
    !/^\d+$/u.test(pathname.slice(prefix.length))
  ) {
    throw new Error(`${asset.name}: GitHub asset URL is outside the repository API`)
  }
  return url.href
}

/** Download one known Release asset through its repository-scoped API URL. */
export async function downloadGithubReleaseAsset(asset, maximum, input, options = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new Error(`${asset.name}: GitHub asset size bound is invalid`)
  }
  const request = requestOptions(input.repository, options)
  if (asset.size > maximum) throw new Error(`${asset.name}: GitHub Release asset is too large`)
  const response = await request.fetcher(safeAssetUrl(asset, request.repository), {
    headers: githubHeaders(request.token, 'application/octet-stream'),
    signal: globalThis.AbortSignal.timeout(request.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(
      `${asset.name}: GitHub asset download failed with HTTP ${String(response.status)}`,
    )
  }
  return boundedGithubResponse(response, maximum)
}
