import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { BrowserError } from './errors.js'
import type { LubanBrowserTemplate } from './types.js'

const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const PARAMETER = /\$\{([A-Za-z][A-Za-z0-9_]*)\}/gu
const MAX_TEMPLATE_BYTES = 256 * 1024

export class TemplateRepository {
  readonly #directories: readonly string[]

  public constructor(directories: readonly string[]) {
    this.#directories = directories
  }

  public async list(): Promise<readonly LubanBrowserTemplate[]> {
    const templates = new Map<string, LubanBrowserTemplate>()
    for (const directory of this.#directories) {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') continue
        throw new BrowserError(
          'E_BROWSER_INVALID_TASK',
          `Unable to read template directory: ${directory}`,
        )
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !/\.ya?ml$/iu.test(entry.name)) continue
        const path = join(directory, entry.name)
        const raw = await readFile(path, 'utf8')
        if (Buffer.byteLength(raw) > MAX_TEMPLATE_BYTES) {
          throw new BrowserError(
            'E_BROWSER_INVALID_TASK',
            `Browser template is too large: ${entry.name}`,
          )
        }
        let decoded: unknown
        try {
          decoded = parse(raw, { maxAliasCount: 20, uniqueKeys: true }) as unknown
        } catch {
          throw new BrowserError(
            'E_BROWSER_INVALID_TASK',
            `Invalid YAML browser template: ${entry.name}`,
          )
        }
        const template = decodeTemplate(decoded, entry.name)
        templates.set(template.id, template)
      }
    }
    return Object.freeze(
      [...templates.values()].sort((left, right) => left.id.localeCompare(right.id)),
    )
  }

  public async get(id: string): Promise<LubanBrowserTemplate | null> {
    if (!TEMPLATE_ID.test(id)) return null
    return (await this.list()).find((template) => template.id === id) ?? null
  }
}

export function renderTemplate(
  value: string,
  parameters: Readonly<Record<string, string>>,
): string {
  const used = new Set<string>()
  const rendered = value.replace(PARAMETER, (_match: string, name: string): string => {
    used.add(name)
    const replacement = parameters[name]
    if (replacement === undefined) {
      throw new BrowserError(
        'E_BROWSER_INVALID_TASK',
        `Missing browser template parameter: ${name}`,
      )
    }
    return replacement
  })
  for (const [name, parameter] of Object.entries(parameters)) {
    if (!used.has(name) && parameter.length > 16_384) {
      throw new BrowserError(
        'E_BROWSER_INVALID_TASK',
        `Browser template parameter is too large: ${name}`,
      )
    }
  }
  return rendered
}

function decodeTemplate(value: unknown, filename: string): LubanBrowserTemplate {
  if (!isRecord(value)) {
    throw new BrowserError(
      'E_BROWSER_INVALID_TASK',
      `Browser template must be an object: ${filename}`,
    )
  }
  const id = requiredString(value, 'id', filename)
  if (!TEMPLATE_ID.test(id)) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', `Invalid browser template id: ${id}`)
  }
  const title = requiredString(value, 'title', filename)
  const goal = requiredString(value, 'goal', filename)
  const startUrl = optionalString(value, 'startUrl', filename)
  const allowDomains = stringList(value.allowDomains, 'allowDomains', filename)
  const timeoutSec = boundedInteger(value.timeoutSec, 'timeoutSec', filename, 1, 3600)
  const maxSteps = boundedInteger(value.maxSteps, 'maxSteps', filename, 1, 500)
  const profile = decodeProfile(value.profile, filename)
  const outputSchema = value.outputSchema
  if (outputSchema !== undefined) assertJsonObject(outputSchema, 'outputSchema', 0)
  return Object.freeze({
    id,
    title,
    goal,
    ...(startUrl === undefined ? {} : { startUrl }),
    allowDomains,
    timeoutSec,
    maxSteps,
    profile,
    ...(outputSchema === undefined ? {} : { outputSchema: Object.freeze(outputSchema) }),
  })
}

function decodeProfile(value: unknown, filename: string): LubanBrowserTemplate['profile'] {
  if (value === undefined) return Object.freeze({ mode: 'isolated' })
  if (!isRecord(value) || (value.mode !== 'isolated' && value.mode !== 'persistent')) {
    throw new BrowserError(
      'E_BROWSER_INVALID_TASK',
      `Invalid profile in browser template: ${filename}`,
    )
  }
  const name = optionalString(value, 'name', filename)
  if (value.mode === 'persistent') {
    if (name === undefined || !TEMPLATE_ID.test(name)) {
      throw new BrowserError(
        'E_BROWSER_INVALID_TASK',
        `Persistent browser template profile requires a safe name: ${filename}`,
      )
    }
    return Object.freeze({ mode: 'persistent', name })
  }
  if (name !== undefined) {
    throw new BrowserError(
      'E_BROWSER_INVALID_TASK',
      `Isolated profile cannot have a name: ${filename}`,
    )
  }
  return Object.freeze({ mode: 'isolated' })
}

function requiredString(value: Record<string, unknown>, key: string, filename: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.trim() === '') {
    throw new BrowserError('E_BROWSER_INVALID_TASK', `${key} is required in ${filename}`)
  }
  return field.trim()
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  filename: string,
): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string' || field.trim() === '') {
    throw new BrowserError(
      'E_BROWSER_INVALID_TASK',
      `${key} must be a non-empty string in ${filename}`,
    )
  }
  return field.trim()
}

function stringList(value: unknown, key: string, filename: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', `${key} must be a string array in ${filename}`)
  }
  return Object.freeze(value.map((item: string) => item.trim()))
}

function boundedInteger(
  value: unknown,
  key: string,
  filename: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BrowserError(
      'E_BROWSER_INVALID_TASK',
      `${key} must be between ${String(minimum)} and ${String(maximum)} in ${filename}`,
    )
  }
  return value as number
}

function assertJsonObject(
  value: unknown,
  key: string,
  depth: number,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || depth > 32) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', `${key} must be a bounded JSON object`)
  }
  for (const child of Object.values(value)) {
    if (child === null || ['string', 'number', 'boolean'].includes(typeof child)) continue
    if (Array.isArray(child)) {
      for (const item of child) {
        if (isRecord(item)) assertJsonObject(item, key, depth + 1)
        else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
          throw new BrowserError('E_BROWSER_INVALID_TASK', `${key} contains a non-JSON value`)
        }
      }
      continue
    }
    assertJsonObject(child, key, depth + 1)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
