#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { LubanError } from 'dsh-luban-core'
import { NodeCommandRunner } from './command-runner.js'
import { WindowsHostTaskOperator } from './windows-host.js'

const HELP = `luban-keepalive-windows — deployment host task operator

Usage:
  luban-keepalive-windows [plan]
  luban-keepalive-windows status
  luban-keepalive-windows install --apply
  luban-keepalive-windows uninstall --apply

With no command, or without --apply, all operations are read-only plans.
The host task uses current-user S4U logon and never requests a password.
`

type OperatorCommand = 'plan' | 'status' | 'install' | 'uninstall'

interface ParsedCli {
  readonly command: OperatorCommand
  readonly apply: boolean
  readonly help: boolean
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
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.positionals.length > 1) throw new Error('too many commands')
  const raw = parsed.positionals[0] ?? 'plan'
  if (!['plan', 'status', 'install', 'uninstall'].includes(raw)) {
    throw new Error('unknown command')
  }
  const command = raw as OperatorCommand
  const apply = parsed.values.apply === true
  if (apply && command !== 'install' && command !== 'uninstall') {
    throw new Error('--apply requires an explicit mutation command')
  }
  return { command, apply, help: parsed.values.help === true }
}

function failure(code: string, message: string): WindowsOperatorCliResult {
  return {
    exitCode: 1,
    output: JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } }),
  }
}

function resolveOperator(dependencies: WindowsOperatorCliDependencies): WindowsHostTaskOperator {
  return (
    dependencies.operator ??
    new WindowsHostTaskOperator({
      runner: new NodeCommandRunner(),
      timeoutMs: 15_000,
    })
  )
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
    const operator = resolveOperator(dependencies)
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
