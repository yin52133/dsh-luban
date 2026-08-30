#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { LubanError } from 'dsh-luban-core'
import { NodeProcessRunner } from './process-runner.js'
import { UserSystemdInstaller } from './systemd.js'

const HELP = `luban-server-mode — current-user systemd operator

Usage:
  luban-server-mode [plan] [--user USER]
  luban-server-mode preflight [--user USER]
  luban-server-mode status [--user USER]
  luban-server-mode install --apply [--user USER]
  luban-server-mode uninstall --apply [--user USER]

Safety:
  With no command, or without --apply, install/uninstall are read-only plans.
  Linger policy is never changed; installation requires loginctl Linger=yes.
  Preflight resolves and identity-locks dsh, Node, PATH, and the effective unit.
  Install verifies permanent enablement, active/running, Type=exec, and positive MainPID.
`

type OperatorCommand = 'plan' | 'preflight' | 'status' | 'install' | 'uninstall'
type ExitCode = 0 | 1 | 2

interface ParsedCli {
  readonly command: OperatorCommand
  readonly apply: boolean
  readonly user?: string
  readonly help: boolean
}

export interface OperatorCliDependencies {
  readonly installer?: UserSystemdInstaller
}

export interface OperatorCliResult {
  readonly exitCode: ExitCode
  readonly output: string
}

function parseCli(argv: readonly string[]): ParsedCli {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      user: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.positionals.length > 1) throw new Error('too many commands')
  const rawCommand = parsed.positionals[0] ?? 'plan'
  if (!['plan', 'preflight', 'status', 'install', 'uninstall'].includes(rawCommand)) {
    throw new Error('unknown command')
  }
  if (parsed.values.user?.trim() === '') {
    throw new Error('user must not be empty')
  }
  const command = rawCommand as OperatorCommand
  const apply = parsed.values.apply === true
  if (apply && command !== 'install' && command !== 'uninstall') {
    throw new Error('--apply requires an explicit install or uninstall command')
  }
  return {
    command,
    apply,
    help: parsed.values.help === true,
    ...(parsed.values.user === undefined ? {} : { user: parsed.values.user }),
  }
}

function failure(code: string, message: string): OperatorCliResult {
  return {
    exitCode: 1,
    output: JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: { code, message },
    }),
  }
}

function installerFor(dependencies: OperatorCliDependencies): UserSystemdInstaller {
  return (
    dependencies.installer ??
    new UserSystemdInstaller({
      runner: new NodeProcessRunner(),
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 15_000,
    })
  )
}

/** Execute one operator command and return a single secret-free structured envelope. */
export async function runOperatorCli(
  argv: readonly string[],
  dependencies: OperatorCliDependencies = {},
): Promise<OperatorCliResult> {
  let parsed: ParsedCli
  try {
    parsed = parseCli(argv)
  } catch {
    return failure('E_INVALID_INPUT', 'Invalid server-mode operator arguments')
  }
  if (parsed.help) return { exitCode: 0, output: HELP.trimEnd() }

  try {
    const installer = installerFor(dependencies)
    const user = parsed.user ?? installer.currentUser
    if (parsed.command === 'plan' || (parsed.command === 'install' && !parsed.apply)) {
      const preflight = await installer.preflight(user)
      return {
        exitCode: preflight.ready ? 0 : 2,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: preflight.ready,
          command: parsed.command,
          mode: 'plan',
          action: 'install',
          preflight,
        }),
      }
    }
    if (parsed.command === 'preflight') {
      const preflight = await installer.preflight(user)
      return {
        exitCode: preflight.ready ? 0 : 2,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: preflight.ready,
          command: parsed.command,
          mode: 'read-only',
          preflight,
        }),
      }
    }
    if (parsed.command === 'status' || (parsed.command === 'uninstall' && !parsed.apply)) {
      const status = await installer.status(user)
      return {
        exitCode: 0,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          command: parsed.command,
          mode: parsed.command === 'status' ? 'read-only' : 'plan',
          ...(parsed.command === 'uninstall' ? { action: 'uninstall' } : {}),
          status,
        }),
      }
    }
    if (parsed.command === 'install') {
      await installer.install(user, 'ubuntu-server')
      return {
        exitCode: 0,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          command: parsed.command,
          mode: 'apply',
          service: `${installer.serviceName}.service`,
          user,
          applied: true,
        }),
      }
    }

    await installer.uninstall(user)
    return {
      exitCode: 0,
      output: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        command: parsed.command,
        mode: 'apply',
        service: `${installer.serviceName}.service`,
        user,
        applied: true,
      }),
    }
  } catch (error: unknown) {
    return error instanceof LubanError
      ? failure(error.code, error.message)
      : failure('E_UNAVAILABLE', 'Server-mode operator command failed')
  }
}

function isMain(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  const result = await runOperatorCli(process.argv.slice(2))
  process.stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}
