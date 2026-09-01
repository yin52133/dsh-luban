import { homedir } from 'node:os'
import { isAbsolute, normalize, resolve } from 'node:path'
import { standardConfigSchema } from 'dsh-luban-core'

export type { StandardConfigSchema } from 'dsh-luban-core'

export interface Config {
  readonly plansDir: string
  readonly stateFile: string
  readonly requireApprovalFor: readonly string[]
  readonly autoApproveFor: readonly string[]
  readonly template: 'bundled-default'
}

const DEFAULT_CONFIG: Config = Object.freeze({
  plansDir: 'docs/plans',
  stateFile: '~/.dsh/luban/plan/plans.json',
  requireApprovalFor: ['edit', 'bash', 'write'],
  autoApproveFor: [],
  template: 'bundled-default',
})

function objectValue(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {}
}

function stringList(input: unknown, fallback: readonly string[]): readonly string[] {
  if (
    !Array.isArray(input) ||
    !input.every((value): value is string => typeof value === 'string')
  ) {
    return fallback
  }
  return [...new Set(input.map((value): string => value.trim()).filter(Boolean))]
}

function safeRelativeDirectory(value: unknown): string {
  const candidate =
    typeof value === 'string' && value.trim() !== ''
      ? normalize(value.trim())
      : DEFAULT_CONFIG.plansDir
  if (candidate === '.' || isAbsolute(candidate) || candidate.split(/[\\/]/u)[0] === '..') {
    throw new TypeError('plansDir must stay inside each workspace')
  }
  return candidate.replaceAll('\\', '/')
}

export function expandHomePath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  return resolve(value)
}

export function parseConfig(input: unknown): Config {
  const root = objectValue(input)
  const stateFile =
    typeof root.stateFile === 'string' && root.stateFile.trim() !== ''
      ? root.stateFile.trim()
      : DEFAULT_CONFIG.stateFile
  if (root.template !== undefined && root.template !== 'bundled-default') {
    throw new TypeError('template must be bundled-default')
  }
  return {
    plansDir: safeRelativeDirectory(root.plansDir),
    stateFile: expandHomePath(stateFile),
    requireApprovalFor: stringList(root.requireApprovalFor, DEFAULT_CONFIG.requireApprovalFor),
    autoApproveFor: stringList(root.autoApproveFor, DEFAULT_CONFIG.autoApproveFor),
    template: 'bundled-default',
  }
}

export const Config = standardConfigSchema(parseConfig)
