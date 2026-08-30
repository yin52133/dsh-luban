import { constants } from 'node:fs'
import { link, lstat, mkdir, open, rm, unlink } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LubanError } from '@luban/core'
import type { ProcessResult, ProcessRunner } from './process-runner.js'
import { assertProcessSuccess } from './process-runner.js'

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u
const UNIT_SUFFIX = '.service'
const NO_FOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0

export type SystemdLingerState = 'enabled' | 'disabled' | 'unavailable'
export type SystemdUnitState =
  'missing' | 'exact' | 'different' | 'symlink' | 'non-regular' | 'changed'
export type SystemdEnabledState =
  'enabled' | 'disabled' | 'static' | 'masked' | 'not-found' | 'unknown'
export type SystemdActiveState =
  'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'not-found' | 'unknown'

export interface SystemdPreflight {
  readonly schemaVersion: 1
  readonly service: string
  readonly user: string
  readonly unitPath: string
  readonly linger: SystemdLingerState
  readonly unit: SystemdUnitState
  readonly ready: boolean
}

export interface SystemdStatus {
  readonly schemaVersion: 1
  readonly service: string
  readonly user: string
  readonly unitPath: string
  readonly linger: SystemdLingerState
  readonly unit: SystemdUnitState
  readonly enabled: SystemdEnabledState
  readonly active: SystemdActiveState
}

export interface SystemdInstallerOptions {
  readonly runner: ProcessRunner
  readonly serviceName: string
  readonly dshExecutable: string
  readonly timeoutMs: number
  readonly platform?: NodeJS.Platform
  readonly unitDirectory?: string
  readonly currentUser?: string
  readonly signal?: AbortSignal
}

interface FileIdentity {
  readonly device: number
  readonly inode: number
}

interface InspectedUnit {
  readonly state: SystemdUnitState
  readonly identity?: FileIdentity
}

function systemdArg(value: string): string {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new LubanError('E_INVALID_INPUT', 'systemd argument contains an invalid character')
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  )
}

function identityOf(device: number, inode: number): FileIdentity {
  return { device, inode }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function outputToken(result: ProcessResult): string {
  return result.stdout.trim().split(/\s+/u, 1)[0]?.toLowerCase() ?? ''
}

function enabledState(result: ProcessResult): SystemdEnabledState {
  const token = outputToken(result)
  if (token === 'enabled' || token === 'enabled-runtime') return 'enabled'
  if (token === 'disabled') return 'disabled'
  if (token === 'static' || token === 'indirect' || token === 'generated') return 'static'
  if (token === 'masked' || token === 'masked-runtime') return 'masked'
  if (token === 'not-found') return 'not-found'
  return 'unknown'
}

function activeState(result: ProcessResult): SystemdActiveState {
  const token = outputToken(result)
  if (
    token === 'active' ||
    token === 'inactive' ||
    token === 'failed' ||
    token === 'activating' ||
    token === 'deactivating'
  ) {
    return token
  }
  if (token === 'unknown' || token === 'not-found') return 'not-found'
  return 'unknown'
}

/** Install and inspect one current-user systemd unit without changing linger policy. */
export class UserSystemdInstaller {
  readonly #runner: ProcessRunner
  readonly #serviceName: string
  readonly #dshExecutable: string
  readonly #timeoutMs: number
  readonly #platform: NodeJS.Platform
  readonly #unitDirectory: string
  readonly #currentUser: string
  readonly #signal: AbortSignal | undefined

  public constructor(options: SystemdInstallerOptions) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$/u.test(options.serviceName)) {
      throw new LubanError('E_INVALID_INPUT', 'systemd service name is invalid')
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new LubanError('E_INVALID_INPUT', 'systemd command timeout must be positive')
    }
    const currentUser = options.currentUser ?? userInfo().username
    if (!USER_PATTERN.test(currentUser)) {
      throw new LubanError('E_INVALID_INPUT', 'current systemd user is invalid')
    }
    this.#runner = options.runner
    this.#serviceName = options.serviceName
    this.#dshExecutable = options.dshExecutable
    this.#timeoutMs = options.timeoutMs
    this.#platform = options.platform ?? process.platform
    this.#unitDirectory = resolve(options.unitDirectory ?? join(homedir(), '.config/systemd/user'))
    this.#currentUser = currentUser
    this.#signal = options.signal
  }

  public get currentUser(): string {
    return this.#currentUser
  }

  public get serviceName(): string {
    return this.#serviceName
  }

  public get unitPath(): string {
    return join(this.#unitDirectory, `${this.#serviceName}${UNIT_SUFFIX}`)
  }

  public render(profile: 'ubuntu-server'): string {
    const executable = this.#dshExecutable.includes('/')
      ? systemdArg(this.#dshExecutable)
      : `${systemdArg('/usr/bin/env')} ${systemdArg(this.#dshExecutable)}`
    return [
      '[Unit]',
      'Description=dsh-luban workbench (DSH web profile)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${executable} ${systemdArg('--profile')} ${systemdArg(profile)} ${systemdArg('--no-open')}`,
      'Environment=LUBAN_BOOT_RESTORE=1',
      'Restart=on-failure',
      'RestartSec=5',
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n')
  }

  /** Run read-only checks required before installation. */
  public async preflight(
    user: string = this.#currentUser,
    profile: 'ubuntu-server' = 'ubuntu-server',
  ): Promise<SystemdPreflight> {
    this.#assertLinux()
    this.#assertCurrentUser(user)
    const [linger, unit] = await Promise.all([
      this.#lingerState(user),
      this.#inspectUnit(this.render(profile)),
    ])
    return {
      schemaVersion: 1,
      service: `${this.#serviceName}${UNIT_SUFFIX}`,
      user,
      unitPath: this.unitPath,
      linger,
      unit: unit.state,
      ready: linger === 'enabled' && (unit.state === 'missing' || unit.state === 'exact'),
    }
  }

  /** Return a secret-free, read-only snapshot of the user unit. */
  public async status(
    user: string = this.#currentUser,
    profile: 'ubuntu-server' = 'ubuntu-server',
  ): Promise<SystemdStatus> {
    const preflight = await this.preflight(user, profile)
    const service = `${this.#serviceName}${UNIT_SUFFIX}`
    const [enabled, active] = await Promise.all([
      this.#run('systemctl', ['--user', 'is-enabled', service]),
      this.#run('systemctl', ['--user', 'is-active', service]),
    ])
    return {
      schemaVersion: 1,
      service,
      user,
      unitPath: this.unitPath,
      linger: preflight.linger,
      unit: preflight.unit,
      enabled: enabledState(enabled),
      active: activeState(active),
    }
  }

  public async install(user: string, profile: 'ubuntu-server'): Promise<void> {
    const expected = this.render(profile)
    const preflight = await this.preflight(user, profile)
    if (preflight.linger !== 'enabled') {
      throw new LubanError(
        'E_UNAVAILABLE',
        'Current-user linger must already be enabled before installing the systemd unit',
      )
    }
    this.#assertInstallable(preflight.unit)

    let created: FileIdentity | undefined
    if (preflight.unit === 'missing') {
      created = await this.#createUnit(expected)
    } else {
      const current = await this.#inspectUnit(expected)
      this.#assertInstallable(current.state)
      if (current.state !== 'exact') {
        throw new LubanError('E_IO', 'systemd unit changed during installation')
      }
    }

    let reloaded = false
    try {
      await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
      reloaded = true
      await this.#checked(
        'systemctl',
        ['--user', 'enable', '--now', `${this.#serviceName}${UNIT_SUFFIX}`],
        'enable dsh-luban service',
      )
    } catch (error: unknown) {
      if (created !== undefined) {
        if (reloaded) await this.#bestEffortDisable()
        try {
          await this.#removeOwnedUnit(created, expected)
        } catch (rollbackError: unknown) {
          throw new LubanError(
            'E_IO',
            'Unable to safely roll back the newly created systemd unit',
            {
              cause: rollbackError,
            },
          )
        }
        if (reloaded) await this.#bestEffortReload()
      }
      throw error
    }
  }

  public async uninstall(user: string = this.#currentUser): Promise<void> {
    this.#assertLinux()
    this.#assertCurrentUser(user)
    const expected = this.render('ubuntu-server')
    const unit = await this.#inspectUnit(expected)
    if (unit.state === 'missing') {
      await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
      return
    }
    this.#assertExactUnit(unit)

    const disabled = await this.#run('systemctl', [
      '--user',
      'disable',
      '--now',
      `${this.#serviceName}${UNIT_SUFFIX}`,
    ])
    if (
      disabled.exitCode !== 0 &&
      !/not loaded|not found|does not exist|不存在|未找到/iu.test(
        `${disabled.stdout}\n${disabled.stderr}`,
      )
    ) {
      assertProcessSuccess(disabled, 'disable dsh-luban service')
    }
    await this.#removeOwnedUnit(unit.identity, expected)
    await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
  }

  async #lingerState(user: string): Promise<SystemdLingerState> {
    let result: ProcessResult
    try {
      result = await this.#run('loginctl', ['show-user', user, '--property=Linger', '--value'])
    } catch {
      return 'unavailable'
    }
    if (result.exitCode !== 0) return 'unavailable'
    const value = result.stdout.trim().toLowerCase()
    if (value === 'yes') return 'enabled'
    if (value === 'no') return 'disabled'
    return 'unavailable'
  }

  async #inspectUnit(expected: string): Promise<InspectedUnit> {
    let pathStats
    try {
      pathStats = await lstat(this.unitPath)
    } catch (error: unknown) {
      if (isFileSystemError(error, 'ENOENT')) return { state: 'missing' }
      throw new LubanError('E_IO', 'Unable to inspect the systemd unit', { cause: error })
    }
    if (pathStats.isSymbolicLink()) return { state: 'symlink' }
    if (!pathStats.isFile()) return { state: 'non-regular' }

    const initialIdentity = identityOf(pathStats.dev, pathStats.ino)
    let handle
    try {
      handle = await open(this.unitPath, constants.O_RDONLY | NO_FOLLOW)
    } catch (error: unknown) {
      if (isFileSystemError(error, 'ELOOP')) return { state: 'symlink' }
      if (isFileSystemError(error, 'ENOENT')) return { state: 'changed' }
      throw new LubanError('E_IO', 'Unable to inspect the systemd unit', { cause: error })
    }
    try {
      const openedStats = await handle.stat()
      if (!openedStats.isFile()) return { state: 'non-regular' }
      const openedIdentity = identityOf(openedStats.dev, openedStats.ino)
      if (!sameIdentity(initialIdentity, openedIdentity)) return { state: 'changed' }
      const content = await handle.readFile({ encoding: 'utf8' })
      let finalStats
      try {
        finalStats = await lstat(this.unitPath)
      } catch (error: unknown) {
        if (isFileSystemError(error, 'ENOENT')) return { state: 'changed' }
        throw error
      }
      if (
        finalStats.isSymbolicLink() ||
        !finalStats.isFile() ||
        !sameIdentity(openedIdentity, identityOf(finalStats.dev, finalStats.ino))
      ) {
        return { state: 'changed' }
      }
      return {
        state: content === expected ? 'exact' : 'different',
        identity: openedIdentity,
      }
    } catch (error: unknown) {
      if (error instanceof LubanError) throw error
      throw new LubanError('E_IO', 'Unable to inspect the systemd unit', { cause: error })
    } finally {
      await handle.close()
    }
  }

  async #createUnit(content: string): Promise<FileIdentity> {
    await mkdir(dirname(this.unitPath), { recursive: true, mode: 0o700 })
    const directoryStats = await lstat(dirname(this.unitPath))
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new LubanError('E_INVALID_INPUT', 'systemd unit directory must be a regular directory')
    }

    const temporary = join(dirname(this.unitPath), `.${this.#serviceName}.${randomUUID()}.tmp`)
    let identity: FileIdentity
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
        const stats = await handle.stat()
        identity = identityOf(stats.dev, stats.ino)
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch((): void => undefined)
      throw new LubanError('E_IO', 'Unable to stage the systemd unit', { cause: error })
    }

    try {
      await link(temporary, this.unitPath)
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch((): void => undefined)
      if (isFileSystemError(error, 'EEXIST')) {
        throw new LubanError('E_INVALID_INPUT', 'systemd unit appeared during installation', {
          cause: error,
        })
      }
      throw new LubanError('E_IO', 'Unable to create the systemd unit', { cause: error })
    }

    try {
      await rm(temporary, { force: true })
    } catch (error: unknown) {
      try {
        await this.#removeOwnedUnit(identity, content)
      } catch (rollbackError: unknown) {
        throw new LubanError('E_IO', 'Unable to safely clean up the staged systemd unit', {
          cause: rollbackError,
        })
      }
      throw new LubanError('E_IO', 'Unable to clean up the staged systemd unit', { cause: error })
    }

    const created = await this.#inspectUnit(content)
    if (
      created.state !== 'exact' ||
      created.identity === undefined ||
      !sameIdentity(created.identity, identity)
    ) {
      throw new LubanError('E_IO', 'Newly created systemd unit failed identity verification')
    }
    return identity
  }

  async #removeOwnedUnit(identity: FileIdentity, expected: string): Promise<void> {
    const inspected = await this.#inspectUnit(expected)
    if (
      inspected.state !== 'exact' ||
      inspected.identity === undefined ||
      !sameIdentity(inspected.identity, identity)
    ) {
      throw new LubanError('E_IO', 'Refusing to remove a changed systemd unit')
    }

    const finalStats = await lstat(this.unitPath)
    if (
      finalStats.isSymbolicLink() ||
      !finalStats.isFile() ||
      !sameIdentity(identityOf(finalStats.dev, finalStats.ino), identity)
    ) {
      throw new LubanError('E_IO', 'Refusing to remove a changed systemd unit')
    }
    await unlink(this.unitPath)
  }

  #assertInstallable(state: SystemdUnitState): void {
    if (state === 'missing' || state === 'exact') return
    throw new LubanError(
      'E_INVALID_INPUT',
      state === 'different'
        ? 'Existing systemd unit content differs from the managed unit'
        : 'Existing systemd unit is not a safe regular file',
    )
  }

  #assertExactUnit(unit: InspectedUnit): asserts unit is InspectedUnit & {
    readonly state: 'exact'
    readonly identity: FileIdentity
  } {
    this.#assertInstallable(unit.state)
    if (unit.state !== 'exact' || unit.identity === undefined) {
      throw new LubanError('E_IO', 'Unable to verify the managed systemd unit')
    }
  }

  async #run(command: string, args: readonly string[]): Promise<ProcessResult> {
    return await this.#runner.run(command, args, {
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: 4_096,
      signal: this.#signal,
    })
  }

  async #checked(command: string, args: readonly string[], operation: string): Promise<void> {
    assertProcessSuccess(await this.#run(command, args), operation)
  }

  async #bestEffortDisable(): Promise<void> {
    try {
      await this.#run('systemctl', [
        '--user',
        'disable',
        '--now',
        `${this.#serviceName}${UNIT_SUFFIX}`,
      ])
    } catch {
      // Rollback continues so the just-created unit is not left behind.
    }
  }

  async #bestEffortReload(): Promise<void> {
    try {
      await this.#run('systemctl', ['--user', 'daemon-reload'])
    } catch {
      // The original installation error remains authoritative.
    }
  }

  #assertCurrentUser(user: string): void {
    if (!USER_PATTERN.test(user)) {
      throw new LubanError('E_INVALID_INPUT', 'systemd user is invalid')
    }
    if (user !== this.#currentUser) {
      throw new LubanError('E_INVALID_INPUT', 'systemd management is limited to the current user')
    }
  }

  #assertLinux(): void {
    if (this.#platform !== 'linux') {
      throw new LubanError('E_PLATFORM_UNSUPPORTED', 'server mode systemd support is Ubuntu-only')
    }
  }
}
