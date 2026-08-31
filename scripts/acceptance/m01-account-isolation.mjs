#!/usr/bin/env node

/* global URL, fetch */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname, platform, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const EVIDENCE_SCHEMA = 'dsh-luban/m01-account-isolation/v1'

const parsed = parseArgs({
  strict: true,
  options: {
    'admin-password-file': { type: 'string' },
    'base-url': { type: 'string', default: 'http://127.0.0.1:42600' },
    output: { type: 'string' },
  },
})

const passwordFile = requiredOption(parsed.values['admin-password-file'], '--admin-password-file')
const output = resolve(requiredOption(parsed.values.output, '--output'))
const baseUrl = normalizedBaseUrl(requiredOption(parsed.values['base-url'], '--base-url'))
const adminPassword = (await readFile(resolve(passwordFile), 'utf8')).trimEnd()
if (adminPassword.length < 8) throw new Error('Administrator password file is invalid')

const bobUsername = `m01-bob-${Date.now().toString(36)}`
const bobPassword = `${randomUUID()}-${randomUUID()}`
const adminCookie = await login('admin', adminPassword)
await requestJson('/luban-auth/users', {
  method: 'POST',
  headers: authenticatedHeaders(adminCookie),
  body: JSON.stringify({ user: bobUsername, password: bobPassword, role: 'operator' }),
  expectedStatus: 201,
})
const bobCookie = await login(bobUsername, bobPassword)

const adminSessionId = await createSession(adminCookie)
const bobSessionId = await createSession(bobCookie)
const [adminList, bobList, adminOwnHistory, bobOwnHistory, adminForeignHistory, bobForeignHistory] =
  await Promise.all([
    rpc(adminCookie, 'session.list', {}),
    rpc(bobCookie, 'session.list', {}),
    rpc(adminCookie, 'session.history', { sessionId: adminSessionId }),
    rpc(bobCookie, 'session.history', { sessionId: bobSessionId }),
    rpc(adminCookie, 'session.history', { sessionId: bobSessionId }),
    rpc(bobCookie, 'session.history', { sessionId: adminSessionId }),
  ])

const adminSessionIds = sessionIds(adminList)
const bobSessionIds = sessionIds(bobList)
assert(adminSessionIds.includes(adminSessionId), 'Administrator cannot list its own session')
assert(!adminSessionIds.includes(bobSessionId), 'Administrator can list Bob session')
assert(bobSessionIds.includes(bobSessionId), 'Bob cannot list its own session')
assert(!bobSessionIds.includes(adminSessionId), 'Bob can list administrator session')
assertRpcOk(adminOwnHistory, 'Administrator cannot read its own session')
assertRpcOk(bobOwnHistory, 'Bob cannot read its own session')
assertScopeDenied(adminForeignHistory, bobSessionId)
assertScopeDenied(bobForeignHistory, adminSessionId)

const { stdout: gitHeadOutput } = await executeFile('git', ['rev-parse', 'HEAD'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
})
const gitHead = gitHeadOutput.trim().toLowerCase()
if (!/^[a-f0-9]{40}$/u.test(gitHead)) throw new Error('Git HEAD is invalid')

const evidence = Object.freeze({
  schemaVersion: EVIDENCE_SCHEMA,
  feature: 'M01-F008',
  gitHead,
  testedAt: new Date().toISOString(),
  host: hostname(),
  platform: `${platform()} ${release()}`,
  baseUrl,
  accounts: Object.freeze({ alice: 'admin', bob: bobUsername }),
  sessions: Object.freeze({ alice: adminSessionId, bob: bobSessionId }),
  checks: Object.freeze({
    aliceCreatedNativeSession: true,
    bobCreatedNativeSession: true,
    aliceListContainsOnlyOwnCreatedSession: true,
    bobListContainsOnlyOwnCreatedSession: true,
    aliceOwnHistoryAllowed: true,
    bobOwnHistoryAllowed: true,
    aliceCannotReadBobHistory: true,
    bobCannotReadAliceHistory: true,
  }),
})

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
})
process.stdout.write(
  `${JSON.stringify({ schemaVersion: EVIDENCE_SCHEMA, ok: true, output, gitHead })}\n`,
)

async function login(user, password) {
  const response = await fetch(`${baseUrl}/luban-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ user, password }),
  })
  if (response.status !== 200) throw new Error(`Login failed with HTTP ${response.status}`)
  await response.body?.cancel()
  const header = response.headers.get('set-cookie')
  if (header === null) throw new Error('Login response did not set authentication cookies')
  const cookie = header
    .split(/,\s*(?=luban_(?:session|csrf)=)/u)
    .map((value) => value.split(';', 1)[0])
    .join('; ')
  if (!cookie.includes('luban_session=') || !cookie.includes('luban_csrf=')) {
    throw new Error('Login response cookies are incomplete')
  }
  return cookie
}

async function createSession(cookie) {
  const response = await rpc(cookie, 'session.create', {})
  assertRpcOk(response, 'Native DSH session.create failed')
  const sessionId = response.result?.value?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('Native DSH session.create returned no sessionId')
  }
  return sessionId
}

async function rpc(cookie, method, payload) {
  const rpcId = randomUUID()
  const response = await requestJson(`/api/${method}`, {
    method: 'POST',
    headers: authenticatedHeaders(cookie),
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    expectedStatus: 200,
  })
  if (response.type !== 'server-response' || response.rpcId !== rpcId) {
    throw new Error(`Native DSH ${method} returned an invalid RPC envelope`)
  }
  return response
}

async function requestJson(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  })
  if (response.status !== options.expectedStatus) {
    await response.body?.cancel()
    throw new Error(`${path} returned HTTP ${response.status}`)
  }
  return response.json()
}

function authenticatedHeaders(cookie) {
  return { cookie, 'content-type': 'application/json', origin: baseUrl }
}

function sessionIds(response) {
  const items = response.result?.value?.items
  if (!Array.isArray(items)) throw new Error('Native DSH session.list returned invalid items')
  return items.flatMap((item) =>
    typeof item === 'object' && item !== null && typeof item.sessionId === 'string'
      ? [item.sessionId]
      : [],
  )
}

function assertRpcOk(response, message) {
  assert(response.result?.ok === true, message)
}

function assertScopeDenied(response, sessionId) {
  assert(response.result?.ok === false, `Cross-account history was allowed for ${sessionId}`)
  assert(
    response.result?.error?.code === 'session-not-found',
    `Cross-account history returned the wrong denial for ${sessionId}`,
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function requiredOption(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

function normalizedBaseUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search !== '') {
    throw new Error('--base-url must be an HTTP(S) origin')
  }
  return url.origin
}
