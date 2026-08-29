import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { ToolId } from './types.js'

export interface RemoteEndpointConfig {
  readonly id: string
  readonly label: string
  readonly kind: 'ssh' | 'telnet' | 'tcp-serial'
  readonly host: string
  readonly port: number
  readonly user?: string
  readonly identityFile?: string
  readonly allowedCommands: readonly string[]
}

export interface Config {
  readonly serial: {
    readonly defaultBaud: number
    readonly timestamp: boolean
    readonly pollIntervalMs: number
  }
  readonly snippet: {
    readonly dir: string
    readonly maxLines: number
    readonly maxBytes: number
  }
  readonly execution: {
    readonly timeoutMs: number
    readonly startupTimeoutMs: number
    readonly processLifetimeMs: number
    readonly maxOutputBytes: number
    readonly allowedRoots: readonly string[]
    readonly cwd?: string
  }
  readonly tools: Readonly<Record<ToolId, string>>
  readonly remote: readonly RemoteEndpointConfig[]
  readonly gdb: {
    readonly target: string
  }
  readonly desktopMcp: {
    readonly enabled: boolean
    readonly command: string
    readonly args: readonly string[]
    readonly tools: readonly string[]
  }
}

const DEFAULT_TOOLS: Readonly<Record<ToolId, string>> = Object.freeze({
  openocd: 'openocd.exe',
  jlink: 'JLink.exe',
  esptool: 'esptool.exe',
  stm32cubeprogrammer: 'STM32_Programmer_CLI.exe',
  gdb: 'arm-none-eabi-gdb.exe',
  adb: 'adb.exe',
  fastboot: 'fastboot.exe',
  ssh: 'ssh.exe',
})

const DEFAULT_CONFIG: Config = Object.freeze({
  serial: { defaultBaud: 115200, timestamp: true, pollIntervalMs: 1500 },
  snippet: { dir: '~/.dsh/luban/win-debug/snippets', maxLines: 500, maxBytes: 512 * 1024 },
  execution: {
    timeoutMs: 120_000,
    startupTimeoutMs: 10_000,
    processLifetimeMs: 8 * 60 * 60 * 1000,
    maxOutputBytes: 1024 * 1024,
    allowedRoots: [process.cwd()],
  },
  tools: DEFAULT_TOOLS,
  remote: [],
  gdb: { target: '127.0.0.1:3333' },
  desktopMcp: { enabled: false, command: '', args: [], tools: [] },
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

function record(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {}
}

function boundedInteger(
  input: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const value = input ?? fallback
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(
      `${label} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    )
  }
  return value as number
}

function text(input: unknown, fallback: string, label: string, maximum = 32_768): string {
  const value = input ?? fallback
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${label} must be a bounded string without NUL bytes`)
  }
  return value.trim()
}

function stringList(input: unknown, fallback: readonly string[], label: string): readonly string[] {
  const value = input ?? fallback
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    !value.every(
      (item): item is string =>
        typeof item === 'string' &&
        item.trim() !== '' &&
        item.length <= 4096 &&
        !item.includes('\0'),
    )
  ) {
    throw new TypeError(`${label} must contain bounded non-empty strings`)
  }
  return Object.freeze([...new Set(value.map((item): string => item.trim()))])
}

export function expandPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function toolMap(value: unknown): Readonly<Record<ToolId, string>> {
  const source = record(value)
  const output = {} as Record<ToolId, string>
  for (const id of Object.keys(DEFAULT_TOOLS) as ToolId[]) {
    output[id] = text(source[id], DEFAULT_TOOLS[id], `tools.${id}`, 4096)
  }
  return Object.freeze(output)
}

function validHost(value: string): boolean {
  return (
    value === 'localhost' ||
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(value) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value) ||
    /^\[[0-9A-Fa-f:]+\]$/u.test(value)
  )
}

function remoteEndpoints(value: unknown): readonly RemoteEndpointConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) throw new TypeError('remote must be an array')
  const seen = new Set<string>()
  return Object.freeze(
    value.map((input, index): RemoteEndpointConfig => {
      const row = record(input)
      const id = text(row.id, '', `remote[${String(index)}].id`, 128)
      const label = text(row.label, id, `remote[${String(index)}].label`, 256)
      const kind = row.kind
      const host = text(row.host, '', `remote[${String(index)}].host`, 253)
      if (id === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || seen.has(id)) {
        throw new TypeError(`remote[${String(index)}].id is invalid or duplicated`)
      }
      seen.add(id)
      if (kind !== 'ssh' && kind !== 'telnet' && kind !== 'tcp-serial') {
        throw new TypeError(`remote[${String(index)}].kind is invalid`)
      }
      if (!validHost(host)) throw new TypeError(`remote[${String(index)}].host is invalid`)
      const port = boundedInteger(
        row.port,
        kind === 'ssh' ? 22 : 23,
        `remote[${String(index)}].port`,
        1,
        65_535,
      )
      const user = text(row.user, '', `remote[${String(index)}].user`, 128)
      if (user !== '' && !/^[A-Za-z0-9._-]+$/u.test(user)) {
        throw new TypeError(`remote[${String(index)}].user is invalid`)
      }
      const identityFile = text(row.identityFile, '', `remote[${String(index)}].identityFile`, 4096)
      return Object.freeze({
        id,
        label,
        kind,
        host,
        port,
        ...(user === '' ? {} : { user }),
        ...(identityFile === '' ? {} : { identityFile: expandPath(identityFile) }),
        allowedCommands: stringList(
          row.allowedCommands,
          [],
          `remote[${String(index)}].allowedCommands`,
        ).map((command): string => {
          if (!/^[A-Za-z0-9._/-]+$/u.test(command)) {
            throw new TypeError(
              `remote[${String(index)}].allowedCommands contains an invalid command`,
            )
          }
          return command
        }),
      })
    }),
  )
}

/** Parse a zero-dependency Standard Schema config and freeze all execution policy inputs. */
export function parseConfig(input: unknown): Config {
  const root = record(input)
  const serial = record(root.serial)
  const snippet = record(root.snippet)
  const execution = record(root.execution)
  const gdb = record(root.gdb)
  const desktopMcp = record(root.desktopMcp)
  const cwdValue = text(execution.cwd, '', 'execution.cwd', 4096)
  const allowedRoots = stringList(
    execution.allowedRoots,
    DEFAULT_CONFIG.execution.allowedRoots,
    'execution.allowedRoots',
  ).map(expandPath)
  if (allowedRoots.length === 0) throw new TypeError('execution.allowedRoots must not be empty')
  const cwd = cwdValue === '' ? undefined : expandPath(cwdValue)
  if (cwd !== undefined && allowedRoots.length > 0 && !isInsideAny(cwd, allowedRoots)) {
    throw new TypeError('execution.cwd must be inside execution.allowedRoots')
  }
  const target = text(gdb.target, DEFAULT_CONFIG.gdb.target, 'gdb.target', 512)
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/u.test(target)) {
    throw new TypeError('gdb.target must be a loopback host and port')
  }
  const targetPort = Number(target.slice(target.lastIndexOf(':') + 1))
  if (!Number.isSafeInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
    throw new TypeError('gdb.target port must be between 1 and 65535')
  }
  const mcpCommand = text(desktopMcp.command, '', 'desktopMcp.command', 4096)
  const enabled = desktopMcp.enabled === true
  if (enabled && mcpCommand === '')
    throw new TypeError('desktopMcp.command is required when enabled')
  if (enabled && !isAbsolute(mcpCommand)) {
    throw new TypeError('desktopMcp.command must be an absolute allowlisted path')
  }

  return Object.freeze({
    serial: Object.freeze({
      defaultBaud: boundedInteger(
        serial.defaultBaud,
        DEFAULT_CONFIG.serial.defaultBaud,
        'serial.defaultBaud',
        50,
        12_000_000,
      ),
      timestamp:
        serial.timestamp === undefined
          ? DEFAULT_CONFIG.serial.timestamp
          : serial.timestamp === true,
      pollIntervalMs: boundedInteger(
        serial.pollIntervalMs,
        DEFAULT_CONFIG.serial.pollIntervalMs,
        'serial.pollIntervalMs',
        250,
        60_000,
      ),
    }),
    snippet: Object.freeze({
      dir: expandPath(text(snippet.dir, DEFAULT_CONFIG.snippet.dir, 'snippet.dir', 4096)),
      maxLines: boundedInteger(
        snippet.maxLines,
        DEFAULT_CONFIG.snippet.maxLines,
        'snippet.maxLines',
        1,
        10_000,
      ),
      maxBytes: boundedInteger(
        snippet.maxBytes,
        DEFAULT_CONFIG.snippet.maxBytes,
        'snippet.maxBytes',
        1024,
        16 * 1024 * 1024,
      ),
    }),
    execution: Object.freeze({
      timeoutMs: boundedInteger(
        execution.timeoutMs,
        DEFAULT_CONFIG.execution.timeoutMs,
        'execution.timeoutMs',
        100,
        60 * 60 * 1000,
      ),
      startupTimeoutMs: boundedInteger(
        execution.startupTimeoutMs,
        DEFAULT_CONFIG.execution.startupTimeoutMs,
        'execution.startupTimeoutMs',
        100,
        5 * 60 * 1000,
      ),
      processLifetimeMs: boundedInteger(
        execution.processLifetimeMs,
        DEFAULT_CONFIG.execution.processLifetimeMs,
        'execution.processLifetimeMs',
        1000,
        24 * 60 * 60 * 1000,
      ),
      maxOutputBytes: boundedInteger(
        execution.maxOutputBytes,
        DEFAULT_CONFIG.execution.maxOutputBytes,
        'execution.maxOutputBytes',
        1024,
        32 * 1024 * 1024,
      ),
      allowedRoots: Object.freeze(allowedRoots),
      ...(cwd === undefined ? {} : { cwd }),
    }),
    tools: toolMap(root.tools),
    remote: remoteEndpoints(root.remote),
    gdb: Object.freeze({ target }),
    desktopMcp: Object.freeze({
      enabled,
      command: mcpCommand,
      args: stringList(desktopMcp.args, [], 'desktopMcp.args'),
      tools: stringList(desktopMcp.tools, [], 'desktopMcp.tools'),
    }),
  })
}

function isInsideAny(path: string, roots: readonly string[]): boolean {
  const normalized = path.toLocaleLowerCase()
  return roots.some((root): boolean => {
    const candidate = resolve(root).toLocaleLowerCase()
    return (
      normalized === candidate ||
      normalized.startsWith(`${candidate}\\`) ||
      normalized.startsWith(`${candidate}/`)
    )
  })
}

export function assertAllowedPath(path: string, config: Config, label: string): string {
  if (path.includes('\0')) throw new TypeError(`${label} contains a NUL byte`)
  const absolute = isAbsolute(path)
    ? resolve(path)
    : resolve(config.execution.cwd ?? process.cwd(), path)
  if (
    config.execution.allowedRoots.length > 0 &&
    !isInsideAny(absolute, config.execution.allowedRoots)
  ) {
    throw new TypeError(`${label} is outside execution.allowedRoots`)
  }
  return absolute
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
