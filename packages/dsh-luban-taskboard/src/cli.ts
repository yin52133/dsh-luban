#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface ClientOptions {
  readonly baseUrl: string
  readonly cookie: string
  readonly csrfToken?: string
}

interface ParsedOptions {
  readonly values: Record<string, string | boolean | (string | boolean)[] | undefined>
  readonly positionals: string[]
}

const HELP = `taskctl — dsh-luban-taskboard CLI

Usage:
  taskctl list [--status todo] [--hostScope ubuntu] [--tag auto-ok]
  taskctl add --title <text> --hostScope <win|ubuntu|any> --priority <P0..P3> [options]
  taskctl claim --session <id> [--workspace <path>] [--tag <tag>]
  taskctl update --id <task> --version <n> [--title <text>] [--acceptance <text>]
  taskctl transition --id <task> --version <n> --to <status> [--note <text>]
  taskctl done --id <task> --version <n> [--note <text>]

Authentication:
  --url defaults to LUBAN_URL or http://127.0.0.1:42600
  LUBAN_SESSION_COOKIE supplies the Cookie header without exposing it in argv
  LUBAN_CSRF_TOKEN supplies the mutation token
`

function valuesOf(argv: readonly string[]): ParsedOptions {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      url: { type: 'string' },
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', multiple: true },
      hostScope: { type: 'string' },
      workspace: { type: 'string' },
      priority: { type: 'string' },
      acceptance: { type: 'string' },
      tag: { type: 'string', multiple: true },
      session: { type: 'string' },
      version: { type: 'string' },
      to: { type: 'string' },
      note: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  return { values: parsed.values, positionals: parsed.positionals }
}

function one(values: ParsedOptions['values'], name: string): string | undefined {
  const value = values[name]
  if (Array.isArray(value))
    return typeof value.at(-1) === 'string' ? (value.at(-1) as string) : undefined
  return typeof value === 'string' ? value : undefined
}

function many(values: ParsedOptions['values'], name: string): readonly string[] {
  const value = values[name]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

function required(values: ParsedOptions['values'], name: string): string {
  const value = one(values, name)
  if (value === undefined || value === '') throw new Error(`--${name} is required`)
  return value
}

function version(values: ParsedOptions['values']): number {
  const parsed = Number.parseInt(required(values, 'version'), 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error('--version must be a positive integer')
  return parsed
}

function clientOptions(values: ParsedOptions['values']): ClientOptions {
  const baseUrl = (one(values, 'url') ?? process.env.LUBAN_URL ?? 'http://127.0.0.1:42600').replace(
    /\/+$/u,
    '',
  )
  const cookie = process.env.LUBAN_SESSION_COOKIE
  if (cookie === undefined || cookie.trim() === '') {
    throw new Error('Set LUBAN_SESSION_COOKIE; credentials are not accepted on the command line')
  }
  const csrfToken = process.env.LUBAN_CSRF_TOKEN
  return { baseUrl, cookie, ...(csrfToken === undefined ? {} : { csrfToken }) }
}

async function request(
  client: ClientOptions,
  method: string,
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const response = await fetch(`${client.baseUrl}/luban-taskboard${path}`, {
    method,
    headers: {
      accept: 'application/json',
      cookie: client.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(client.csrfToken === undefined ? {} : { 'x-luban-csrf': client.csrfToken }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const value = text === '' ? null : (JSON.parse(text) as unknown)
  if (!response.ok) {
    const detail = typeof value === 'object' && value !== null ? JSON.stringify(value) : text
    throw new Error(`HTTP ${String(response.status)}: ${detail}`)
  }
  return value
}

export async function run(argv: readonly string[]): Promise<unknown> {
  const parsed = valuesOf(argv)
  const command = parsed.positionals[0]
  if (command === undefined || command === 'help' || parsed.values.help === true) return HELP
  const client = clientOptions(parsed.values)
  if (command === 'list') {
    const query = new URLSearchParams()
    for (const status of many(parsed.values, 'status')) query.append('status', status)
    for (const tag of many(parsed.values, 'tag')) query.append('tag', tag)
    const hostScope = one(parsed.values, 'hostScope')
    const workspace = one(parsed.values, 'workspace')
    if (hostScope !== undefined) query.set('hostScope', hostScope)
    if (workspace !== undefined) query.set('workspace', workspace)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    return request(client, 'GET', `/tasks${suffix}`)
  }
  if (command === 'add') {
    return request(client, 'POST', '/tasks', {
      title: required(parsed.values, 'title'),
      hostScope: required(parsed.values, 'hostScope'),
      priority: required(parsed.values, 'priority'),
      ...(one(parsed.values, 'description') === undefined
        ? {}
        : { description: one(parsed.values, 'description') }),
      ...(one(parsed.values, 'workspace') === undefined
        ? {}
        : { workspace: one(parsed.values, 'workspace') }),
      ...(one(parsed.values, 'acceptance') === undefined
        ? {}
        : { acceptance: one(parsed.values, 'acceptance') }),
      ...(many(parsed.values, 'tag').length === 0 ? {} : { tags: many(parsed.values, 'tag') }),
    })
  }
  if (command === 'claim') {
    return request(client, 'POST', '/claim', {
      sessionId: required(parsed.values, 'session'),
      ...(one(parsed.values, 'workspace') === undefined
        ? {}
        : { workspace: one(parsed.values, 'workspace') }),
      ...(many(parsed.values, 'tag').length === 0 ? {} : { tags: many(parsed.values, 'tag') }),
    })
  }
  if (command === 'update') {
    return request(client, 'PATCH', `/tasks/${encodeURIComponent(required(parsed.values, 'id'))}`, {
      expectedVersion: version(parsed.values),
      ...(one(parsed.values, 'title') === undefined ? {} : { title: one(parsed.values, 'title') }),
      ...(one(parsed.values, 'description') === undefined
        ? {}
        : { description: one(parsed.values, 'description') }),
      ...(one(parsed.values, 'workspace') === undefined
        ? {}
        : { workspace: one(parsed.values, 'workspace') }),
      ...(one(parsed.values, 'priority') === undefined
        ? {}
        : { priority: one(parsed.values, 'priority') }),
      ...(one(parsed.values, 'acceptance') === undefined
        ? {}
        : { acceptance: one(parsed.values, 'acceptance') }),
      ...(many(parsed.values, 'tag').length === 0 ? {} : { tags: many(parsed.values, 'tag') }),
    })
  }
  if (command === 'transition' || command === 'done') {
    return request(
      client,
      'POST',
      `/tasks/${encodeURIComponent(required(parsed.values, 'id'))}/transition`,
      {
        expectedVersion: version(parsed.values),
        to: command === 'done' ? 'done' : required(parsed.values, 'to'),
        ...(one(parsed.values, 'note') === undefined ? {} : { note: one(parsed.values, 'note') }),
      },
    )
  }
  throw new Error(`Unknown command: ${command}`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  run(process.argv.slice(2)).then(
    (value): void => {
      process.stdout.write(
        typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`,
      )
    },
    (error: unknown): void => {
      process.stderr.write(`${error instanceof Error ? error.message : 'taskctl failed'}\n`)
      process.exitCode = 1
    },
  )
}
