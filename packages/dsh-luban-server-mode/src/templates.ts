import { isAbsolute, relative, resolve } from 'node:path'
import { LubanError } from '@luban/core'
import type { BuildTemplateConfig } from './config.js'
import { resolveUserPath } from './config.js'
import type { WorkerSpec } from './worker-protocol.js'

const PLACEHOLDER = /\$\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu
const PARAMETER_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function placeholders(values: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const value of values) {
    for (const match of value.matchAll(PLACEHOLDER)) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return names
}

function interpolate(value: string, values: Readonly<Record<string, string>>): string {
  const result = value.replace(PLACEHOLDER, (_token, rawName: string): string => {
    const replacement = values[rawName]
    if (replacement === undefined)
      throw new LubanError('E_INVALID_INPUT', `missing parameter ${rawName}`)
    return replacement
  })
  if (result.includes('\0'))
    throw new LubanError('E_INVALID_INPUT', 'template produced an invalid value')
  return result
}

export interface CompileTemplateInput {
  readonly template: BuildTemplateConfig
  readonly params: Readonly<Record<string, string>>
  readonly jobId: string
  readonly artifactDirectory: string
  readonly resultFile: string
  readonly timeoutMs: number
  readonly workspaceRoots: readonly string[]
}

/** Compile a declarative template into one shell-free, workspace-confined worker spec. */
export function compileTemplate(input: CompileTemplateInput): WorkerSpec {
  if (input.template.command.includes('${')) {
    throw new LubanError('E_INVALID_INPUT', 'template executable cannot contain parameters')
  }
  const referenced = placeholders([
    ...input.template.args,
    input.template.cwd,
    ...input.template.collect,
  ])
  const supplied = Object.entries(input.params)
  for (const [name, value] of supplied) {
    if (!PARAMETER_NAME.test(name) || value.length > 4_096 || value.includes('\0')) {
      throw new LubanError('E_INVALID_INPUT', `build parameter ${name} is invalid`)
    }
    if (!referenced.has(name)) {
      throw new LubanError('E_INVALID_INPUT', `build parameter ${name} is not used by the template`)
    }
    if (name === 'jobId' || name === 'artifactDir') {
      throw new LubanError('E_INVALID_INPUT', `build parameter ${name} is reserved`)
    }
  }
  const reserved = new Set(['jobId', 'artifactDir'])
  for (const name of referenced) {
    if (!reserved.has(name) && input.params[name] === undefined) {
      throw new LubanError('E_INVALID_INPUT', `missing build parameter ${name}`)
    }
  }
  const values = {
    ...input.params,
    jobId: input.jobId,
    artifactDir: input.artifactDirectory,
  }
  const cwd = resolveUserPath(interpolate(input.template.cwd, values))
  const roots = input.workspaceRoots.map(resolveUserPath)
  if (!roots.some((root): boolean => inside(root, cwd))) {
    throw new LubanError('E_INVALID_INPUT', 'build workspace is outside configured roots')
  }
  const collect = input.template.collect.map((value): string => {
    const expanded = interpolate(value, values)
    const source = resolve(cwd, expanded)
    if (!inside(cwd, source)) {
      throw new LubanError('E_INVALID_INPUT', 'artifact source escapes the build workspace')
    }
    return source
  })
  return {
    schemaVersion: 1,
    command: input.template.command,
    args: input.template.args.map((value): string => interpolate(value, values)),
    cwd,
    timeoutMs: input.timeoutMs,
    artifactDirectory: resolve(input.artifactDirectory),
    collect,
    resultFile: resolve(input.resultFile),
  }
}
