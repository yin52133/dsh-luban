import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface BuildTemplateConfig {
  readonly id: string
  readonly title: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly collect: readonly string[]
}

export interface Config {
  readonly service: {
    readonly name: string
    readonly user: string
    readonly profile: 'ubuntu-server'
    readonly dshExecutable: string
  }
  readonly build: {
    readonly maxConcurrent: number
    readonly defaultTimeoutMin: number
    readonly workspaceRoots: readonly string[]
    readonly templates: readonly BuildTemplateConfig[]
  }
  readonly guard: {
    readonly diskMinGb: number
    readonly loadMax: number
    readonly checkIntervalSec: number
  }
  readonly artifacts: {
    readonly dir: string
    readonly retainRuns: number
    readonly linkTtlSec: number
  }
  readonly store: {
    readonly file: string
  }
}

const DEFAULT_TEMPLATES: readonly BuildTemplateConfig[] = Object.freeze([
  {
    id: 'pnpm-build',
    title: 'pnpm build',
    command: 'pnpm',
    args: ['--dir', '${workspace}', 'run', 'build'],
    cwd: '${workspace}',
    collect: ['dist'],
  },
  {
    id: 'cmake-build',
    title: 'CMake build',
    command: 'cmake',
    args: ['--build', '${workspace}/build'],
    cwd: '${workspace}',
    collect: ['build'],
  },
])

const DEFAULT_CONFIG: Config = Object.freeze({
  service: {
    name: 'dsh-luban',
    user: '',
    profile: 'ubuntu-server' as const,
    dshExecutable: 'dsh',
  },
  build: {
    maxConcurrent: 1,
    defaultTimeoutMin: 30,
    workspaceRoots: ['~/workspace', '~/projects'],
    templates: DEFAULT_TEMPLATES,
  },
  guard: { diskMinGb: 10, loadMax: 8, checkIntervalSec: 15 },
  artifacts: { dir: '~/builds', retainRuns: 10, linkTtlSec: 300 },
  store: { file: '~/.dsh/luban/server-mode/ledger.json' },
})

type ValidationResult<Value> =
  | { readonly value: Value }
  | {
      readonly issues: readonly {
        readonly message: string
        readonly path?: readonly PropertyKey[]
      }[]
    }

export interface StandardConfigSchema<Value> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: 'dsh-luban'
    validate(input: unknown): ValidationResult<Value>
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {}
}

function stringValue(value: unknown, fallback: string, name: string, allowEmpty = false): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '') || value.includes('\0')) {
    throw new TypeError(`${name} must be a valid string`)
  }
  return value.trim()
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

function nonNegativeNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`)
  }
  return value
}

function strings(value: unknown, fallback: readonly string[], name: string): readonly string[] {
  if (value === undefined) return [...fallback]
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (item): item is string =>
        typeof item === 'string' && item.trim() !== '' && !item.includes('\0'),
    )
  ) {
    throw new TypeError(`${name} must be a non-empty string array`)
  }
  return [...new Set(value.map((item): string => item.trim()))]
}

function templates(value: unknown): readonly BuildTemplateConfig[] {
  if (value === undefined) return DEFAULT_TEMPLATES.map((template) => ({ ...template }))
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('build.templates must be a non-empty array')
  }
  const parsed = value.map((raw, index): BuildTemplateConfig => {
    const row = record(raw)
    const id = stringValue(row.id, '', `build.templates[${String(index)}].id`)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) {
      throw new TypeError(`build.templates[${String(index)}].id is invalid`)
    }
    return {
      id,
      title: stringValue(row.title, id, `build.templates[${String(index)}].title`),
      command: stringValue(row.command, '', `build.templates[${String(index)}].command`),
      args:
        row.args === undefined
          ? []
          : stringsAllowEmpty(row.args, `build.templates[${String(index)}].args`),
      cwd: stringValue(row.cwd, '${workspace}', `build.templates[${String(index)}].cwd`),
      collect:
        row.collect === undefined
          ? []
          : stringsAllowEmpty(row.collect, `build.templates[${String(index)}].collect`),
    }
  })
  if (new Set(parsed.map((template) => template.id)).size !== parsed.length) {
    throw new TypeError('build.templates ids must be unique')
  }
  return parsed
}

function stringsAllowEmpty(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: unknown): item is string => typeof item === 'string' && !item.includes('\0'),
    )
  ) {
    throw new TypeError(`${name} must be a string array`)
  }
  return [...value]
}

export function parseConfig(input: unknown): Config {
  const root = record(input)
  const service = record(root.service)
  const build = record(root.build)
  const guard = record(root.guard)
  const artifacts = record(root.artifacts)
  const store = record(root.store)
  const profile = service.profile ?? DEFAULT_CONFIG.service.profile
  if (profile !== 'ubuntu-server') throw new TypeError('service.profile must be ubuntu-server')
  const serviceName = stringValue(service.name, DEFAULT_CONFIG.service.name, 'service.name')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$/u.test(serviceName)) {
    throw new TypeError('service.name is invalid')
  }
  return {
    service: {
      name: serviceName,
      user: stringValue(service.user, DEFAULT_CONFIG.service.user, 'service.user', true),
      profile,
      dshExecutable: stringValue(
        service.dshExecutable,
        DEFAULT_CONFIG.service.dshExecutable,
        'service.dshExecutable',
      ),
    },
    build: {
      maxConcurrent: positiveInteger(
        build.maxConcurrent,
        DEFAULT_CONFIG.build.maxConcurrent,
        'build.maxConcurrent',
      ),
      defaultTimeoutMin: positiveInteger(
        build.defaultTimeoutMin,
        DEFAULT_CONFIG.build.defaultTimeoutMin,
        'build.defaultTimeoutMin',
      ),
      workspaceRoots: strings(
        build.workspaceRoots,
        DEFAULT_CONFIG.build.workspaceRoots,
        'build.workspaceRoots',
      ),
      templates: templates(build.templates),
    },
    guard: {
      diskMinGb: nonNegativeNumber(
        guard.diskMinGb,
        DEFAULT_CONFIG.guard.diskMinGb,
        'guard.diskMinGb',
      ),
      loadMax: nonNegativeNumber(guard.loadMax, DEFAULT_CONFIG.guard.loadMax, 'guard.loadMax'),
      checkIntervalSec: positiveInteger(
        guard.checkIntervalSec,
        DEFAULT_CONFIG.guard.checkIntervalSec,
        'guard.checkIntervalSec',
      ),
    },
    artifacts: {
      dir: stringValue(artifacts.dir, DEFAULT_CONFIG.artifacts.dir, 'artifacts.dir'),
      retainRuns: positiveInteger(
        artifacts.retainRuns,
        DEFAULT_CONFIG.artifacts.retainRuns,
        'artifacts.retainRuns',
      ),
      linkTtlSec: positiveInteger(
        artifacts.linkTtlSec,
        DEFAULT_CONFIG.artifacts.linkTtlSec,
        'artifacts.linkTtlSec',
      ),
    },
    store: {
      file: stringValue(store.file, DEFAULT_CONFIG.store.file, 'store.file'),
    },
  }
}

export function resolveUserPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

export const Config: StandardConfigSchema<Config> = Object.freeze({
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-luban' as const,
    validate(input: unknown): ValidationResult<Config> {
      try {
        return { value: parseConfig(input) }
      } catch (error: unknown) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid config' }] }
      }
    },
  },
})
