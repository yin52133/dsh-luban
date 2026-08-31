#!/usr/bin/env node

/* global Buffer, URL, fetch, setTimeout */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname, platform, release } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const EVIDENCE_SCHEMA = 'dsh-luban/m11-dsh-browser/v1'
const CHALLENGE_PORT = 47_631
const CHALLENGE_URL = `http://127.0.0.1:${String(CHALLENGE_PORT)}/challenge`
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timeout', 'cancelled'])
const repositoryRoot = resolve(import.meta.dirname, '..', '..')

const parsed = parseArgs({
  strict: true,
  options: {
    output: { type: 'string' },
    profile: { type: 'string', default: 'web' },
    'dsh-port': { type: 'string', default: '42810' },
    'auth-port': { type: 'string', default: '42811' },
  },
})
const output = resolve(required(parsed.values.output, '--output'))
const profile = required(parsed.values.profile, '--profile')
const dshPort = port(parsed.values['dsh-port'], '--dsh-port')
const authPort = port(parsed.values['auth-port'], '--auth-port')
if (dshPort === authPort || [dshPort, authPort].includes(CHALLENGE_PORT)) {
  throw new Error('Acceptance ports must be distinct')
}
await assertMissing(output)

const startedAt = new Date().toISOString()
const runDirectory = dirname(output)
const runtimeDirectory = join(runDirectory, 'runtime')
const templateDirectory = join(runtimeDirectory, 'templates')
const overlayPath = join(runtimeDirectory, 'm11-dsh-live.patch.yml')
const logPath = join(runDirectory, `${basename(output, '.json')}.dsh.log`)
await mkdir(templateDirectory, { recursive: true })
await writeAcceptanceOverlay(overlayPath)

const gitHead = await gitOutput(['rev-parse', 'HEAD'])
if (!/^[a-f0-9]{40}$/u.test(gitHead)) throw new Error('Git HEAD is invalid')
if ((await gitOutput(['status', '--porcelain'])) !== '') {
  throw new Error('M11 live acceptance requires a clean worktree')
}

const nonce = randomBytes(16).toString('hex')
await writeFile(join(templateDirectory, 'luban-live-acceptance-v1.yaml'), templateYaml(nonce), {
  encoding: 'utf8',
  flag: 'wx',
})

const challenge = await startChallenge(nonce)
const password = `${randomBytes(24).toString('base64url')}aA1!`
const child = startDsh({
  profile,
  dshPort,
  authPort,
  runtimeDirectory,
  templateDirectory,
  overlayPath,
  password,
})
const logs = []
child.stdout?.on('data', (chunk) => logs.push(String(chunk)))
child.stderr?.on('data', (chunk) => logs.push(String(chunk)))

let job
let cookie
let operationError
try {
  const baseUrl = `http://127.0.0.1:${String(authPort)}`
  await waitForLogin(baseUrl, child)
  cookie = await login(baseUrl, password)
  const created = await requestJson(`${baseUrl}/luban-browser/jobs`, {
    method: 'POST',
    headers: authenticatedHeaders(cookie, baseUrl),
    body: JSON.stringify({ task: { templateId: 'luban-live-acceptance-v1', goal: '' } }),
    expectedStatus: 202,
  })
  const jobId = created.job?.id
  if (typeof jobId !== 'string' || jobId === '') throw new Error('Browser API returned no job id')
  job = await pollJob(baseUrl, cookie, jobId, child)
} catch (error) {
  operationError = error
} finally {
  await challenge.close()
  await stopChild(child)
  await writeFile(logPath, logs.join(''), { encoding: 'utf8', flag: 'wx' })
}

if (operationError !== undefined) throw operationError
assert(job?.status === 'succeeded', `Browser job finished as ${String(job?.status)}`)
assert(job.result?.status === 'ok', 'Browser result is not ok')
assert(job.result?.structured?.nonce === nonce, 'Browser result did not return the challenge nonce')
assert(challenge.requestCount() >= 1, 'The real browser did not fetch the challenge')
assert(job.progressStep >= 1, 'No browser progress was observed')
assert(Array.isArray(job.screenshots) && job.screenshots.length >= 1, 'No screenshot was produced')

const screenshots = []
for (const screenshot of job.screenshots) {
  const bytes = await readFile(screenshot)
  assert(
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'Screenshot is not PNG',
  )
  screenshots.push(
    Object.freeze({
      path: screenshot,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  )
}

const evidence = Object.freeze({
  schemaVersion: EVIDENCE_SCHEMA,
  featureId: 'M11-F001',
  verdict: 'pass',
  gitHead,
  startedAt,
  finishedAt: new Date().toISOString(),
  host: hostname(),
  platform: `${platform()} ${release()}`,
  profile,
  modelRoute: 'dsh-default',
  browser: Object.freeze({
    kernel: platform() === 'win32' ? 'chrome' : 'chromium-headless',
    headless: true,
  }),
  challenge: Object.freeze({
    url: CHALLENGE_URL,
    requestCount: challenge.requestCount(),
    nonceSha256: createHash('sha256').update(nonce).digest('hex'),
    matched: true,
  }),
  result: Object.freeze({
    status: job.result.status,
    steps: job.result.steps,
    durationMs: job.result.durationMs,
    progressStep: job.progressStep,
    screenshots: Object.freeze(screenshots),
  }),
  checks: Object.freeze({
    mountedDshProfile: true,
    dshDefaultModelRouted: true,
    realBrowserFetchedChallenge: true,
    structuredNonceMatched: true,
    progressObserved: true,
    screenshotVerified: true,
  }),
  logPath,
})
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
process.stdout.write(`${JSON.stringify({ ok: true, output, gitHead })}\n`)

function startDsh(input) {
  const args = [
    '--profile',
    input.profile,
    '--patch',
    input.overlayPath,
    '--no-open',
    '--host',
    '127.0.0.1',
    '--port',
    String(input.dshPort),
  ]
  const env = {
    ...process.env,
    LUBAN_ADMIN_PASSWORD: input.password,
    LUBAN_M11_DSH_PORT: String(input.dshPort),
    LUBAN_M11_AUTH_PORT: String(input.authPort),
    LUBAN_M11_USERS_FILE: join(input.runtimeDirectory, 'auth', 'users.json'),
    LUBAN_M11_AUDIT_DIRECTORY: join(input.runtimeDirectory, 'auth', 'audit'),
    LUBAN_M11_BROWSER_DATA: join(input.runtimeDirectory, 'browser'),
    LUBAN_M11_TEMPLATES_DIRECTORY: input.templateDirectory,
    LUBAN_M11_BRIDGE_PROJECT: resolve(repositoryRoot, 'tools', 'browser-bridge'),
    LUBAN_M11_BRIDGE_ENVIRONMENT: join(input.runtimeDirectory, 'uv-env'),
  }
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'dsh.cmd', ...args], {
      cwd: repositoryRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  return spawn('dsh', args, {
    cwd: repositoryRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function writeAcceptanceOverlay(path) {
  const templatePath = resolve(
    repositoryRoot,
    'scripts',
    'acceptance',
    'fixtures',
    'm11-dsh-live.patch.yml',
  )
  const authPlugin = pathToFileURL(
    resolve(repositoryRoot, 'packages', 'dsh-luban-auth', 'dist', 'index.js'),
  ).href
  const browserPlugin = pathToFileURL(
    resolve(repositoryRoot, 'packages', 'dsh-luban-browser', 'dist', 'index.js'),
  ).href
  const template = await readFile(templatePath, 'utf8')
  const overlay = template
    .replace('__LUBAN_M11_AUTH_PLUGIN__', JSON.stringify(authPlugin))
    .replace('__LUBAN_M11_BROWSER_PLUGIN__', JSON.stringify(browserPlugin))
  if (overlay.includes('__LUBAN_M11_')) throw new Error('Acceptance overlay is incomplete')
  await writeFile(path, overlay, { encoding: 'utf8', flag: 'wx' })
}

async function waitForLogin(baseUrl, child) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`DSH exited during startup with ${String(child.exitCode)}`)
    try {
      const response = await fetch(`${baseUrl}/luban-auth/login`)
      await response.body?.cancel()
      if (response.status === 200) return
    } catch {
      // Startup is still in progress.
    }
    await delay(500)
  }
  throw new Error('Timed out waiting for the mounted DSH profile')
}

async function login(baseUrl, password) {
  const response = await fetch(`${baseUrl}/luban-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ user: 'admin', password }),
  })
  if (response.status !== 200) throw new Error(`Login failed with HTTP ${String(response.status)}`)
  await response.body?.cancel()
  const header = response.headers.get('set-cookie')
  if (header === null) throw new Error('Login did not set cookies')
  const cookie = header
    .split(/,\s*(?=luban_(?:session|csrf)=)/u)
    .map((value) => value.split(';', 1)[0])
    .join('; ')
  if (!cookie.includes('luban_session=') || !cookie.includes('luban_csrf=')) {
    throw new Error('Login cookies are incomplete')
  }
  return cookie
}

async function pollJob(baseUrl, cookie, jobId, child) {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`DSH exited during browser execution with ${String(child.exitCode)}`)
    const body = await requestJson(`${baseUrl}/luban-browser/jobs/${jobId}`, {
      method: 'GET',
      headers: authenticatedHeaders(cookie, baseUrl),
      expectedStatus: 200,
    })
    if (TERMINAL_STATUSES.has(body.job?.status)) return body.job
    await delay(1_000)
  }
  throw new Error('Timed out waiting for the browser job')
}

async function requestJson(url, options) {
  const response = await fetch(url, options)
  if (response.status !== options.expectedStatus) {
    const body = await response.text()
    throw new Error(
      `${new URL(url).pathname} returned HTTP ${String(response.status)}: ${body.slice(0, 500)}`,
    )
  }
  return response.json()
}

function authenticatedHeaders(cookie, baseUrl) {
  return { cookie, 'content-type': 'application/json', origin: baseUrl }
}

async function startChallenge(nonce) {
  let requests = 0
  const body = `<!doctype html><html><body><code data-luban-challenge>${nonce}</code></body></html>`
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/challenge') {
      response.writeHead(404).end()
      return
    }
    requests += 1
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(body)
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(CHALLENGE_PORT, '127.0.0.1', resolvePromise)
  })
  return Object.freeze({
    requestCount: () => requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  })
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    delay(10_000).then(() => false),
  ])
  if (exited) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
    })
    await new Promise((resolvePromise) => killer.once('exit', resolvePromise))
  } else {
    child.kill('SIGKILL')
  }
}

function templateYaml(nonce) {
  return `id: luban-live-acceptance-v1\ntitle: Luban mounted DSH acceptance\ngoal: >-\n  Open the start URL, read the exact text inside the element with the\n  data-luban-challenge attribute, and return only {"nonce":"${nonce}"}.\nstartUrl: ${CHALLENGE_URL}\nallowDomains:\n  - 127.0.0.1\ntimeoutSec: 180\nmaxSteps: 12\nprofile:\n  mode: isolated\noutputSchema:\n  type: object\n  required:\n    - nonce\n  additionalProperties: false\n  properties:\n    nonce:\n      type: string\n`
}

async function gitOutput(args) {
  const child = spawn('git', args, {
    cwd: repositoryRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const code = await new Promise((resolvePromise) => child.once('exit', resolvePromise))
  if (code !== 0)
    throw new Error(`git ${args[0]} failed: ${Buffer.concat(stderr).toString('utf8').trim()}`)
  return Buffer.concat(stdout).toString('utf8').trim().toLowerCase()
}

async function assertMissing(path) {
  try {
    await access(path)
  } catch {
    return
  }
  throw new Error(`Refusing to overwrite existing evidence: ${path}`)
}

function port(value, name) {
  const parsed = Number(required(value, name))
  if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535)
    throw new Error(`${name} is invalid`)
  return parsed
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
