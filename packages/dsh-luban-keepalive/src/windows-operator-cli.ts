#!/usr/bin/env node

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { LubanError } from 'dsh-luban-core'
import { NodeCommandRunner } from './command-runner.js'
import { WindowsHostTaskOperator } from './windows-host.js'
import type { WindowsHostLaunch } from './windows-task.js'

const HELP = `luban-keepalive-windows — deployment host task operator

Usage:
  luban-keepalive-windows [plan]
  luban-keepalive-windows status
  luban-keepalive-windows acceptance-status --session-id ID --worker ABSOLUTE_FILE
  luban-keepalive-windows install --apply
  luban-keepalive-windows start --apply
  luban-keepalive-windows uninstall --apply

With no command, or without --apply, all operations are read-only plans.
The host task uses current-user S4U logon and never requests a password.
`

type OperatorCommand = 'plan' | 'status' | 'acceptance-status' | 'install' | 'start' | 'uninstall'

interface ParsedCli {
  readonly command: OperatorCommand
  readonly apply: boolean
  readonly help: boolean
  readonly launch: WindowsHostLaunch
  readonly acceptanceProbe?: { readonly sessionId: string; readonly workerPath: string }
}

export interface WindowsOperatorCliDependencies {
  readonly operator?: WindowsHostTaskOperator
}

export interface WindowsOperatorCliResult {
  readonly exitCode: 0 | 1 | 2
  readonly output: string
}

function parseCli(argv: readonly string[]): ParsedCli {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      node: { type: 'string' },
      bootstrap: { type: 'string' },
      'dsh-entry': { type: 'string' },
      'dsh-home': { type: 'string' },
      profile: { type: 'string' },
      'acceptance-run-dir': { type: 'string' },
      'acceptance-run-id': { type: 'string' },
      'acceptance-spec-sha256': { type: 'string' },
      'session-id': { type: 'string' },
      worker: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.positionals.length > 1) throw new Error('too many commands')
  const raw = parsed.positionals[0] ?? 'plan'
  if (!['plan', 'status', 'acceptance-status', 'install', 'start', 'uninstall'].includes(raw)) {
    throw new Error('unknown command')
  }
  const command = raw as OperatorCommand
  const apply = parsed.values.apply === true
  if (apply && !['install', 'start', 'uninstall'].includes(command)) {
    throw new Error('--apply requires an explicit mutation command')
  }
  const acceptanceRunDir = parsed.values['acceptance-run-dir']
  const acceptanceRunId = parsed.values['acceptance-run-id']
  const acceptanceSpecSha256 = parsed.values['acceptance-spec-sha256']
  const acceptanceValues = [acceptanceRunDir, acceptanceRunId, acceptanceSpecSha256]
  if (
    acceptanceValues.some((value) => value !== undefined) &&
    acceptanceValues.some((value) => value === undefined)
  ) {
    throw new Error('acceptance launch arguments must be supplied together')
  }
  const profile = parsed.values.profile ?? 'win-debug'
  if (profile !== 'win-debug') throw new Error('invalid Windows profile')
  const dshEntry =
    parsed.values['dsh-entry'] ??
    (() => {
      const require = createRequire(import.meta.url)
      const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
      return join(dirname(dshPackage), 'lib', 'bin.js')
    })()
  const acceptance =
    acceptanceRunDir !== undefined &&
    acceptanceRunId !== undefined &&
    acceptanceSpecSha256 !== undefined
      ? {
          runDir: resolve(acceptanceRunDir),
          runId: acceptanceRunId,
          specSha256: acceptanceSpecSha256,
        }
      : undefined
  const sessionId = parsed.values['session-id']
  const workerPath = parsed.values.worker
  if ((sessionId === undefined) !== (workerPath === undefined)) {
    throw new Error('acceptance probe arguments must be supplied together')
  }
  if (
    command === 'acceptance-status' &&
    (acceptance === undefined || sessionId === undefined || workerPath === undefined)
  ) {
    throw new Error('acceptance-status requires bound acceptance probe arguments')
  }
  if (command !== 'acceptance-status' && (sessionId !== undefined || workerPath !== undefined)) {
    throw new Error('acceptance probe arguments require acceptance-status')
  }
  const launch: WindowsHostLaunch = {
    nodeExecutable: resolve(parsed.values.node ?? process.execPath),
    bootstrapPath: resolve(
      parsed.values.bootstrap ??
        fileURLToPath(new URL('./windows-host-bootstrap.js', import.meta.url)),
    ),
    dshEntry: resolve(dshEntry),
    dshHome: resolve(parsed.values['dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    profile,
    ...(acceptance === undefined ? {} : { acceptance }),
  }
  return {
    command,
    apply,
    help: parsed.values.help === true,
    launch,
    ...(sessionId === undefined || workerPath === undefined
      ? {}
      : { acceptanceProbe: { sessionId, workerPath: resolve(workerPath) } }),
  }
}

function failure(code: string, message: string): WindowsOperatorCliResult {
  return {
    exitCode: 1,
    output: JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } }),
  }
}

function resolveOperator(
  dependencies: WindowsOperatorCliDependencies,
  parsed: ParsedCli,
): WindowsHostTaskOperator {
  if (dependencies.operator !== undefined) return dependencies.operator
  return new WindowsHostTaskOperator({
    runner: new NodeCommandRunner(),
    timeoutMs: 15_000,
    launch: parsed.launch,
  })
}

/** Execute one host-operator command with a single secret-free structured result. */
export async function runWindowsOperatorCli(
  argv: readonly string[],
  dependencies: WindowsOperatorCliDependencies = {},
): Promise<WindowsOperatorCliResult> {
  let parsed: ParsedCli
  try {
    parsed = parseCli(argv)
  } catch {
    return failure('E_INVALID_INPUT', 'Invalid Windows keepalive operator arguments')
  }
  if (parsed.help) return { exitCode: 0, output: HELP.trimEnd() }

  try {
    const operator = resolveOperator(dependencies, parsed)
    if (parsed.command === 'plan' || (parsed.command === 'install' && !parsed.apply)) {
      const plan = await operator.plan('install')
      return {
        exitCode: plan.ready ? 0 : 2,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: plan.ready,
          command: parsed.command,
          mode: 'plan',
          plan,
        }),
      }
    }
    if (parsed.command === 'start' && !parsed.apply) {
      const status = await operator.status()
      const ready = status.state === 'exact'
      return {
        exitCode: ready ? 0 : 2,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: ready,
          command: parsed.command,
          mode: 'plan',
          plan: { ...status, action: 'start', mutationRequired: status.running !== true, ready },
        }),
      }
    }
    if (parsed.command === 'status') {
      const status = await operator.status()
      return {
        exitCode: 0,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          command: parsed.command,
          mode: 'read-only',
          status,
        }),
      }
    }
    if (parsed.command === 'acceptance-status') {
      const acceptance = parsed.launch.acceptance
      const probe = parsed.acceptanceProbe
      if (acceptance === undefined || probe === undefined) {
        throw new Error('acceptance probe is incomplete')
      }
      const [host, child] = await Promise.all([
        operator.status(),
        operator.childStatus({
          id: probe.sessionId,
          command: parsed.launch.nodeExecutable,
          args: [
            probe.workerPath,
            '--run-dir',
            acceptance.runDir,
            '--run-id',
            acceptance.runId,
            '--spec-sha256',
            acceptance.specSha256,
          ],
        }),
      ])
      return {
        exitCode: 0,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          command: parsed.command,
          mode: 'read-only',
          status: { host, child },
        }),
      }
    }
    if (parsed.command === 'uninstall' && !parsed.apply) {
      const plan = await operator.plan('uninstall')
      return {
        exitCode: plan.ready ? 0 : 2,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: plan.ready,
          command: parsed.command,
          mode: 'plan',
          plan,
        }),
      }
    }
    if (parsed.command === 'install') {
      await operator.install()
    } else if (parsed.command === 'start') {
      await operator.start()
    } else {
      await operator.uninstall()
    }
    return {
      exitCode: 0,
      output: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        command: parsed.command,
        mode: 'apply',
        taskName: '\\dsh-luban-host',
        user: operator.currentUser,
        applied: true,
      }),
    }
  } catch (error: unknown) {
    return error instanceof LubanError
      ? failure(error.code, error.message)
      : failure('E_UNAVAILABLE', 'Windows keepalive operator command failed')
  }
}

function isMain(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  const result = await runWindowsOperatorCli(process.argv.slice(2))
  process.stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}
