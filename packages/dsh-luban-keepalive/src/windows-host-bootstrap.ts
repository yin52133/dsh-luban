#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { uptime } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

interface BootstrapOptions {
  readonly dshEntry: string
  readonly dshHome: string
  readonly profile: 'win-debug'
  readonly acceptance?: {
    readonly runDir: string
    readonly runId: string
    readonly specSha256: string
  }
}

export interface WindowsHostBootstrapDependencies {
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly uptime?: () => number
  readonly spawn?: typeof spawn
  readonly environment?: NodeJS.ProcessEnv
}

function absolutePath(value: string | undefined, label: string): string {
  if (value === undefined || !isAbsolute(value) || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return resolve(value)
}

function parseCli(argv: readonly string[]): BootstrapOptions {
  const parsed = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'dsh-entry': { type: 'string' },
      'dsh-home': { type: 'string' },
      profile: { type: 'string' },
      'acceptance-run-dir': { type: 'string' },
      'acceptance-run-id': { type: 'string' },
      'acceptance-spec-sha256': { type: 'string' },
    },
  })
  if (parsed.values.profile !== 'win-debug') {
    throw new Error('invalid Windows host bootstrap arguments')
  }
  const acceptance = [
    parsed.values['acceptance-run-dir'],
    parsed.values['acceptance-run-id'],
    parsed.values['acceptance-spec-sha256'],
  ]
  if (
    acceptance.some((value) => value !== undefined) &&
    acceptance.some((value) => value === undefined)
  ) {
    throw new Error('acceptance bootstrap arguments must be supplied together')
  }
  const runId = acceptance[1]
  const specSha256 = acceptance[2]
  if (
    runId !== undefined &&
    (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(runId) ||
      specSha256 === undefined ||
      !/^[a-f0-9]{64}$/u.test(specSha256))
  ) {
    throw new Error('acceptance bootstrap identity is invalid')
  }
  return {
    dshEntry: absolutePath(parsed.values['dsh-entry'], 'DSH entry'),
    dshHome: absolutePath(parsed.values['dsh-home'], 'DSH home'),
    profile: 'win-debug',
    ...(acceptance[0] === undefined || runId === undefined || specSha256 === undefined
      ? {}
      : {
          acceptance: {
            runDir: absolutePath(acceptance[0], 'acceptance run directory'),
            runId,
            specSha256,
          },
        }),
  }
}

/** Copy the normal user environment used by an interactive DSH launch. */
export function createWindowsHostEnvironment(
  source: NodeJS.ProcessEnv,
  nodeExecutable: string,
): NodeJS.ProcessEnv {
  return {
    ...source,
    PATH: source.PATH ?? dirname(nodeExecutable),
  }
}

/** Launch the exact DSH entry and wait for it; this function never signs out or reboots Windows. */
export async function runWindowsHostBootstrap(
  argv: readonly string[],
  dependencies: WindowsHostBootstrapDependencies = {},
): Promise<number> {
  if ((dependencies.platform ?? process.platform) !== 'win32') return 1
  let options: BootstrapOptions
  try {
    options = parseCli(argv)
  } catch {
    return 1
  }
  const now = dependencies.now ?? Date.now
  const hostUptime = dependencies.uptime ?? uptime
  const environment = createWindowsHostEnvironment(
    dependencies.environment ?? process.env,
    process.execPath,
  )
  environment.LUBAN_BOOT_RESTORE = '1'
  environment.DSH_HOME = options.dshHome
  environment.TEMP = options.acceptance?.runDir ?? options.dshHome
  environment.TMP = options.acceptance?.runDir ?? options.dshHome
  const startedAt = now()
  environment.LUBAN_M03_HOST_STARTED_AT = String(startedAt)
  environment.LUBAN_M03_BOOT_STARTED_AT = String(Math.round(startedAt - hostUptime() * 1_000))
  if (options.acceptance !== undefined) {
    environment.LUBAN_M03_ACCEPTANCE_RUN_DIR = options.acceptance.runDir
    environment.LUBAN_M03_ACCEPTANCE_RUN_ID = options.acceptance.runId
    environment.LUBAN_M03_ACCEPTANCE_SPEC_SHA256 = options.acceptance.specSha256
  }
  return await new Promise<number>((resolveResult) => {
    const child = (dependencies.spawn ?? spawn)(
      process.execPath,
      [options.dshEntry, '--profile', options.profile, '--no-open'],
      {
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: 'inherit',
      },
    )
    child.once('error', () => resolveResult(1))
    child.once('close', (code) => resolveResult(code === 0 ? 0 : 1))
  })
}

function isMain(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) process.exitCode = await runWindowsHostBootstrap(process.argv.slice(2))
