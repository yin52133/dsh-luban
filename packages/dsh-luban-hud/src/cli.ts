#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { renderCliHeader, sanitizeTerminalText } from './cli-render.js'
import type { HudSnapshotResponse } from './types.js'

const HELP = `luban-hud — authenticated DSH telemetry header

Usage:
  luban-hud [--json] [--url http://127.0.0.1:42600]

Authentication:
  --url defaults to LUBAN_URL or http://127.0.0.1:42600
  LUBAN_SESSION_COOKIE supplies the Cookie header; credentials are never accepted in argv
`

function snapshotResponse(value: unknown): HudSnapshotResponse {
  if (typeof value !== 'object' || value === null) throw new Error('HUD returned invalid JSON')
  const record = value as Readonly<Record<string, unknown>>
  if (
    typeof record.snapshot !== 'object' ||
    record.snapshot === null ||
    typeof record.advisory !== 'object' ||
    record.advisory === null ||
    typeof record.config !== 'object' ||
    record.config === null
  ) {
    throw new Error('HUD returned an invalid snapshot envelope')
  }
  return value as HudSnapshotResponse
}

export async function runCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      url: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.values.help === true) return HELP.trimEnd()
  const cookie = environment.LUBAN_SESSION_COOKIE
  if (cookie === undefined || cookie.trim() === '') {
    throw new Error('Set LUBAN_SESSION_COOKIE; credentials are not accepted on the command line')
  }
  const baseUrl = new URL(parsed.values.url ?? environment.LUBAN_URL ?? 'http://127.0.0.1:42600')
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('HUD URL must use http or https')
  }
  if (
    baseUrl.username !== '' ||
    baseUrl.password !== '' ||
    baseUrl.search !== '' ||
    baseUrl.hash !== ''
  ) {
    throw new Error('HUD URL must not contain credentials, a query, or a fragment')
  }
  const url = new URL('/luban-hud/snapshot', baseUrl)
  const response = await fetch(url, {
    headers: { accept: 'application/json', cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const detail = sanitizeTerminalText(await response.text(), 512)
    throw new Error(detail === '' ? `HUD request failed (${String(response.status)})` : detail)
  }
  const envelope = snapshotResponse((await response.json()) as unknown)
  return parsed.values.json === true
    ? JSON.stringify(envelope, null, 2)
    : renderCliHeader(envelope.snapshot, envelope.advisory)
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${await runCli(process.argv.slice(2))}\n`)
  } catch (error: unknown) {
    const detail = sanitizeTerminalText(error instanceof Error ? error.message : String(error), 512)
    process.stderr.write(`${detail === '' ? 'HUD CLI failed' : detail}\n`)
    process.exitCode = 1
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) void main()
