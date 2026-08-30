import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

const MAX_NETSTAT_BYTES = 8 * 1024 * 1024
const WINDOWS_LISTENER = 'LISTENING'
const LINUX_LISTENER = '0A'
const IPV4_LOOPBACK = '0100007F'
const IPV6_LOOPBACK = new Set([
  '00000000000000000000000000000001',
  '00000000000000000000000001000000',
])

export interface LoopbackListenerTarget {
  readonly host: '127.0.0.1'
  readonly port: number
  readonly processId: number
  readonly workspaceRoot: string
  readonly dshEntrypoint: string
}

export interface LoopbackListenerAttestation {
  readonly kind: 'os-loopback-listener-pid'
  readonly host: '127.0.0.1'
  readonly port: number
  readonly processId: number
  readonly nodeExecutableSha256: string
  readonly dshEntrypointSha256: string
  readonly commandSha256: string
  readonly observedAt: string
}

export type LoopbackListenerAttestor = (
  target: LoopbackListenerTarget,
) => Promise<LoopbackListenerAttestation>

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535
}

function validProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function stableFileSha256(path: string): Promise<string> {
  const before = await stat(path)
  if (!before.isFile() || before.size <= 0 || before.size > 256 * 1024 * 1024) {
    throw new Error('process runtime file is invalid')
  }
  const bytes = await readFile(path)
  const after = await stat(path)
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error('process runtime file changed during inspection')
  }
  return sha256(bytes)
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function hasProfileArgument(argv: readonly string[]): boolean {
  return argv.some((value): boolean => value === '--profile' || value.startsWith('--profile='))
}

function safeNodeArgv(argv: readonly string[]): boolean {
  return (
    argv.length >= 3 &&
    argv.every((value): boolean => value !== '' && !/[\0\r\n]/u.test(value)) &&
    hasProfileArgument(argv.slice(2))
  )
}

/** Parse a Windows process command line using CommandLineToArgvW-compatible quote rules. */
export function windowsCommandLineArguments(commandLine: string): readonly string[] {
  if (commandLine === '' || /[\0\r\n]/u.test(commandLine)) return []
  const argv: string[] = []
  let cursor = 0
  while (cursor < commandLine.length) {
    while (/\s/u.test(commandLine[cursor] ?? '')) cursor += 1
    if (cursor >= commandLine.length) break
    let value = ''
    let quoted = false
    while (cursor < commandLine.length) {
      let backslashes = 0
      while (commandLine[cursor] === '\\') {
        backslashes += 1
        cursor += 1
      }
      if (commandLine[cursor] === '"') {
        value += '\\'.repeat(Math.floor(backslashes / 2))
        if (backslashes % 2 === 1) {
          value += '"'
          cursor += 1
          continue
        }
        quoted = !quoted
        cursor += 1
        continue
      }
      value += '\\'.repeat(backslashes)
      const character = commandLine[cursor]
      if (character === undefined || (!quoted && /\s/u.test(character))) break
      value += character
      cursor += 1
    }
    if (quoted) return []
    argv.push(value)
    while (/\s/u.test(commandLine[cursor] ?? '')) cursor += 1
  }
  return argv
}

function endpointParts(
  value: string,
): { readonly host: string; readonly port: number } | undefined {
  const separator = value.lastIndexOf(':')
  if (separator <= 0) return undefined
  const rawHost = value.slice(0, separator).replace(/^\[|\]$/gu, '')
  const rawPort = value.slice(separator + 1)
  if (!/^\d{1,5}$/u.test(rawPort)) return undefined
  const port = Number(rawPort)
  if (!validPort(port)) return undefined
  return { host: rawHost, port }
}

/** Parse only literal IPv4-loopback TCP listeners from Windows netstat output. */
export function windowsLoopbackListenerPids(output: string, port: number): ReadonlySet<number> {
  if (!validPort(port)) throw new TypeError('listener port is invalid')
  const result = new Set<number>()
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u)
    if (fields.length !== 5 || fields[0]?.toUpperCase() !== 'TCP') continue
    const local = fields[1] === undefined ? undefined : endpointParts(fields[1])
    const processId = Number(fields[4])
    if (
      local?.host === '127.0.0.1' &&
      local.port === port &&
      fields[3]?.toUpperCase() === WINDOWS_LISTENER &&
      validProcessId(processId)
    ) {
      result.add(processId)
    }
  }
  return result
}

/** Parse loopback listener socket inodes from Linux procfs tcp tables. */
export function linuxLoopbackListenerInodes(output: string, port: number): ReadonlySet<string> {
  if (!validPort(port)) throw new TypeError('listener port is invalid')
  const expectedPort = port.toString(16).toUpperCase().padStart(4, '0')
  const result = new Set<string>()
  for (const line of output.split(/\r?\n/u).slice(1)) {
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 10) continue
    const local = fields[1]?.split(':')
    const address = local?.[0]?.toUpperCase()
    const localPort = local?.[1]?.toUpperCase()
    const state = fields[3]?.toUpperCase()
    const inode = fields[9]
    if (
      localPort === expectedPort &&
      state === LINUX_LISTENER &&
      inode !== undefined &&
      /^\d+$/u.test(inode) &&
      (address === IPV4_LOOPBACK || (address !== undefined && IPV6_LOOPBACK.has(address)))
    ) {
      result.add(inode)
    }
  }
  return result
}

async function linuxProcessOwnsListener(processId: number, port: number): Promise<boolean> {
  const tables = await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map(async (path): Promise<string> => {
      try {
        return await readFile(path, 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }),
  )
  const inodes = new Set<string>()
  for (const table of tables) {
    for (const inode of linuxLoopbackListenerInodes(table, port)) inodes.add(inode)
  }
  if (inodes.size === 0) return false
  const descriptors = await readdir(`/proc/${String(processId)}/fd`)
  for (const descriptor of descriptors) {
    let target: string
    try {
      target = await readlink(`/proc/${String(processId)}/fd/${descriptor}`)
    } catch (error: unknown) {
      if (['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    const match = /^socket:\[(\d+)\]$/u.exec(target)
    if (match?.[1] !== undefined && inodes.has(match[1])) return true
  }
  return false
}

interface ProcessLaunchIdentity {
  readonly nodeExecutableSha256: string
  readonly dshEntrypointSha256: string
  readonly commandSha256: string
}

async function linuxProcessLaunchIdentity(
  processId: number,
  workspaceRoot: string,
  dshEntrypoint: string,
): Promise<ProcessLaunchIdentity> {
  const [rawArgv, rawEnvironment, executable, cwd, expectedEntrypoint] = await Promise.all([
    readFile(`/proc/${String(processId)}/cmdline`),
    readFile(`/proc/${String(processId)}/environ`),
    realpath(`/proc/${String(processId)}/exe`),
    realpath(`/proc/${String(processId)}/cwd`),
    realpath(dshEntrypoint),
  ])
  const argv = rawArgv
    .toString('utf8')
    .split('\0')
    .filter((value): boolean => value !== '')
  const environment = rawEnvironment.toString('utf8').split('\0')
  if (
    !safeNodeArgv(argv) ||
    basename(executable) !== 'node' ||
    environment.some((entry): boolean => entry.startsWith('NODE_OPTIONS=')) ||
    !samePath(cwd, await realpath(workspaceRoot)) ||
    argv[1] === undefined ||
    !samePath(await realpath(argv[1]), expectedEntrypoint)
  ) {
    throw new Error('listener process is not the trusted workspace DSH launch')
  }
  return Object.freeze({
    nodeExecutableSha256: await stableFileSha256(executable),
    dshEntrypointSha256: await stableFileSha256(expectedEntrypoint),
    commandSha256: sha256(JSON.stringify(argv)),
  })
}

async function windowsProcessOwnsListener(processId: number, port: number): Promise<boolean> {
  const systemRootValue = process.env.SystemRoot ?? process.env.WINDIR
  if (systemRootValue === undefined || !isAbsolute(systemRootValue)) {
    throw new Error('Windows system root is unavailable')
  }
  const systemRoot = await realpath(resolve(systemRootValue))
  const netstat = await realpath(resolve(systemRoot, 'System32', 'netstat.exe'))
  const result = spawnSync(netstat, ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: MAX_NETSTAT_BYTES,
    env: { SystemRoot: systemRoot, WINDIR: systemRoot },
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Windows TCP listener inspection failed')
  }
  return windowsLoopbackListenerPids(result.stdout, port).has(processId)
}

async function windowsProcessLaunchIdentity(
  processId: number,
  workspaceRoot: string,
  dshEntrypoint: string,
): Promise<ProcessLaunchIdentity> {
  const systemRootValue = process.env.SystemRoot ?? process.env.WINDIR
  if (systemRootValue === undefined || !isAbsolute(systemRootValue)) {
    throw new Error('Windows system root is unavailable')
  }
  const systemRoot = await realpath(resolve(systemRootValue))
  const powershell = await realpath(
    resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  )
  const command = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${String(processId)}"; if ($null -eq $p) { exit 3 }; [pscustomobject]@{ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine} | ConvertTo-Json -Compress`
  const result = spawnSync(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      cwd: await realpath(workspaceRoot),
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
    },
  )
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Windows process launch inspection failed')
  }
  const value: unknown = JSON.parse(result.stdout)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Windows process launch identity is invalid')
  }
  const record = value as Readonly<{ ExecutablePath?: unknown; CommandLine?: unknown }>
  if (typeof record.ExecutablePath !== 'string' || typeof record.CommandLine !== 'string') {
    throw new Error('Windows process launch identity is incomplete')
  }
  const executable = await realpath(record.ExecutablePath)
  const expectedEntrypoint = await realpath(dshEntrypoint)
  const argv = windowsCommandLineArguments(record.CommandLine)
  if (
    basename(executable).toLowerCase() !== 'node.exe' ||
    !safeNodeArgv(argv) ||
    argv[1] === undefined ||
    !samePath(await realpath(argv[1]), expectedEntrypoint)
  ) {
    throw new Error('listener process is not the trusted workspace DSH launch')
  }
  return Object.freeze({
    nodeExecutableSha256: await stableFileSha256(executable),
    dshEntrypointSha256: await stableFileSha256(expectedEntrypoint),
    commandSha256: sha256(JSON.stringify(argv)),
  })
}

/** Independently bind a literal-loopback port to the server-reported OS process id. */
export const attestLoopbackListener: LoopbackListenerAttestor = async (
  target,
): Promise<LoopbackListenerAttestation> => {
  if (!validPort(target.port) || !validProcessId(target.processId)) {
    throw new TypeError('loopback listener target is invalid')
  }
  const owned =
    process.platform === 'win32'
      ? await windowsProcessOwnsListener(target.processId, target.port)
      : process.platform === 'linux'
        ? await linuxProcessOwnsListener(target.processId, target.port)
        : false
  if (!owned) throw new Error('reported process does not own the loopback listener')
  const launchIdentity =
    process.platform === 'win32'
      ? await windowsProcessLaunchIdentity(
          target.processId,
          target.workspaceRoot,
          target.dshEntrypoint,
        )
      : process.platform === 'linux'
        ? await linuxProcessLaunchIdentity(
            target.processId,
            target.workspaceRoot,
            target.dshEntrypoint,
          )
        : undefined
  if (launchIdentity === undefined) throw new Error('listener process platform is unsupported')
  const stillOwned =
    process.platform === 'win32'
      ? await windowsProcessOwnsListener(target.processId, target.port)
      : await linuxProcessOwnsListener(target.processId, target.port)
  if (!stillOwned) throw new Error('loopback listener changed during process inspection')
  return Object.freeze({
    kind: 'os-loopback-listener-pid',
    host: target.host,
    port: target.port,
    processId: target.processId,
    ...launchIdentity,
    observedAt: new Date().toISOString(),
  })
}
