#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

interface CliOptions {
  readonly live: boolean
  readonly sessionId?: string
  readonly help: boolean
}

function parseArguments(argv: readonly string[]): CliOptions {
  let live = false
  let help = false
  let sessionId: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--'))
        throw new Error(`${String(argument)} requires a value`)
      index += 1
      return next
    }
    if (argument === '--live') live = true
    else if (argument === '--session') sessionId = value()
    else if (argument === '--help') help = true
    else throw new Error(`Unknown option: ${String(argument)}`)
  }
  return {
    live,
    help,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function usage(): string {
  return `Usage: luban-img-visual-acceptance [--live --session <id>]

This standalone command never constructs or fakes a DSH provider turn. The live
acceptance API must run inside the mounted dsh-luban-image-paste Cordis plugin:

  await ctx.lubanImageVisualAcceptance.run({
    live: true,
    sessionId: '<live top-level rc2 session>'
  })`
}

export function visualAcceptanceCliResult(options: CliOptions): Readonly<Record<string, unknown>> {
  if (!options.live) {
    return {
      schemaVersion: 1,
      featureId: 'M06-F003',
      evidenceKind: 'none',
      status: 'planned',
      acceptancePassed: false,
      requiredEntry: 'ctx.lubanImageVisualAcceptance.run',
      reason: 'live execution requires an already-mounted Cordis AgentRegistry and LLM runtime',
    }
  }
  return {
    schemaVersion: 1,
    featureId: 'M06-F003',
    evidenceKind: 'none',
    status: 'blocked',
    acceptancePassed: false,
    ...(options.sessionId === undefined ? {} : { requestedSessionId: options.sessionId }),
    requiredEntry: 'ctx.lubanImageVisualAcceptance.run',
    reason:
      'standalone CLI cannot safely access the mounted live Agent/session/provider composition',
  }
}

function main(): void {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  const result = visualAcceptanceCliResult(options)
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'blocked') process.exitCode = 2
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error: unknown) {
    console.error(
      `luban-img-visual-acceptance: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
    process.exitCode = 1
  }
}
