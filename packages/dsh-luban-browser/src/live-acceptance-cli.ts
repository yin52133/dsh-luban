#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  aggregateLiveBrowserEvidence,
  failedCliEnvelope,
  readLiveBrowserEvidence,
  runLiveBrowserAcceptance,
  writeEvidenceFile,
  type DualLiveBrowserEvidence,
  type LiveBrowserEvidence,
} from './live-acceptance.js'

interface CliIo {
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  write(value: string): void
}

interface ParsedRun {
  readonly command: 'run'
  readonly output?: string
}

interface ParsedAggregate {
  readonly command: 'aggregate'
  readonly windows: string
  readonly ubuntu: string
  readonly output?: string
}

type ParsedCli = ParsedRun | ParsedAggregate

export async function runLiveAcceptanceCli(
  args: readonly string[],
  io: CliIo = {
    cwd: process.cwd(),
    environment: process.env,
    write: (value): void => {
      process.stdout.write(value)
    },
  },
): Promise<number> {
  try {
    const parsed = parseCli(args)
    if (parsed.command === 'run') {
      const evidence = await runLiveBrowserAcceptance({
        repositoryRoot: io.cwd,
        environment: io.environment,
      })
      const output = parsed.output ?? defaultRunOutput(io.cwd, evidence)
      const target = await writeEvidenceFile(output, evidence, secretValues(io.environment))
      emit(io, evidence, target)
      return evidence.verdict === 'pass' ? 0 : 1
    }

    const [windows, ubuntu] = await Promise.all([
      readLiveBrowserEvidence(parsed.windows),
      readLiveBrowserEvidence(parsed.ubuntu),
    ])
    const evidence = aggregateLiveBrowserEvidence([windows, ubuntu])
    const output = parsed.output ?? defaultAggregateOutput(io.cwd, evidence)
    const target = await writeEvidenceFile(output, evidence, secretValues(io.environment))
    emit(io, evidence, target)
    return 0
  } catch (error: unknown) {
    io.write(`${JSON.stringify(failedCliEnvelope(error))}\n`)
    return 1
  }
}

function parseCli(args: readonly string[]): ParsedCli {
  const command = args[0] === 'aggregate' ? 'aggregate' : 'run'
  const values = command === 'aggregate' ? args.slice(1) : args[0] === 'run' ? args.slice(1) : args
  const options = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]
    const value = values[index + 1]
    if (
      flag === undefined ||
      value === undefined ||
      !['--output', '--windows', '--ubuntu'].includes(flag) ||
      options.has(flag)
    ) {
      throw new Error('Invalid live acceptance CLI arguments')
    }
    options.set(flag, value)
  }
  if (command === 'run') {
    if (options.has('--windows') || options.has('--ubuntu')) {
      throw new Error('Invalid live acceptance CLI arguments')
    }
    const output = options.get('--output')
    return output === undefined ? { command } : { command, output }
  }
  const windows = options.get('--windows')
  const ubuntu = options.get('--ubuntu')
  if (windows === undefined || ubuntu === undefined) {
    throw new Error('Invalid live acceptance CLI arguments')
  }
  const output = options.get('--output')
  return output === undefined ? { command, windows, ubuntu } : { command, windows, ubuntu, output }
}

function defaultRunOutput(cwd: string, evidence: LiveBrowserEvidence): string {
  return resolve(
    cwd,
    '.luban',
    'acceptance',
    `m11-${evidence.platform.target}-${evidence.runId}.json`,
  )
}

function defaultAggregateOutput(cwd: string, evidence: DualLiveBrowserEvidence): string {
  return resolve(cwd, '.luban', 'acceptance', `m11-dual-${evidence.gitSha.slice(0, 12)}.json`)
}

function emit(
  io: CliIo,
  evidence: LiveBrowserEvidence | DualLiveBrowserEvidence,
  path: string,
): void {
  io.write(
    `${JSON.stringify({
      schemaVersion: evidence.schemaVersion,
      verdict: evidence.verdict,
      evidencePath: path,
    })}\n`,
  )
}

function secretValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment).flatMap(([name, value]): string[] =>
    value !== undefined && /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/u.test(name) && value.length >= 8
      ? [value]
      : [],
  )
}

function isMain(): boolean {
  const path = process.argv[1]
  return path !== undefined && import.meta.url === pathToFileURL(resolve(path)).href
}

if (isMain()) {
  process.exitCode = await runLiveAcceptanceCli(process.argv.slice(2))
}
