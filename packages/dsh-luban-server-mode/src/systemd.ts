import { constants, realpathSync } from 'node:fs'
import { access, link, lstat, mkdir, open, realpath, rm, unlink } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LubanError } from '@luban/core'
import type { ProcessResult, ProcessRunner } from './process-runner.js'
import { assertProcessSuccess } from './process-runner.js'

const USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u
const UNIT_SUFFIX = '.service'
const NO_FOLLOW = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0
const MAX_PATH_DIRECTORIES = 256
const MAX_FIXED_PATH_LENGTH = 8_192
const SHOW_PROPERTIES = [
  'Id',
  'LoadState',
  'FragmentPath',
  'DropInPaths',
  'NeedDaemonReload',
  'UnitFileState',
  'ActiveState',
  'SubState',
  'MainPID',
  'Type',
] as const

type ShowProperty = (typeof SHOW_PROPERTIES)[number]

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

interface ExecutableIdentity extends FileIdentity {
  readonly size: number
  readonly ctimeMs: number
}

interface ResolvedExecutable {
  readonly path: string
  readonly identity: ExecutableIdentity
}

interface ResolvedLaunch {
  readonly dsh: ResolvedExecutable
  readonly node: ResolvedExecutable
  readonly fixedPath: string
}

type EffectiveSystemdUnitState = SystemdUnitState | 'foreign' | 'stale'
type InternalSystemdEnabledState = SystemdEnabledState | 'enabled-runtime'

interface SystemdSnapshot {
  readonly id: string
  readonly loadState: string
  readonly fragmentPath: string
  readonly dropInPaths: string
  readonly needDaemonReload: string
  readonly enabled: InternalSystemdEnabledState
  readonly active: SystemdActiveState
  readonly subState: string
  readonly mainPid: number | null
  readonly type: string
}

interface InspectedUnit {
  readonly state: SystemdUnitState
  readonly identity?: FileIdentity
}

interface PreparedUnit {
  readonly launch: ResolvedLaunch
  readonly expected: string
  readonly local: InspectedUnit
  readonly snapshot?: SystemdSnapshot
  readonly effectiveUnit: EffectiveSystemdUnitState
  readonly preflight: SystemdPreflight
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function systemdArg(value: string): string {
  if (containsControlCharacter(value) || /[%$]/u.test(value)) {
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

function executableIdentityOf(
  device: number,
  inode: number,
  size: number,
  ctimeMs: number,
): ExecutableIdentity {
  return { device, inode, size, ctimeMs }
}

function sameExecutable(left: ResolvedExecutable, right: ResolvedExecutable): boolean {
  return (
    left.path === right.path &&
    sameIdentity(left.identity, right.identity) &&
    left.identity.size === right.identity.size &&
    left.identity.ctimeMs === right.identity.ctimeMs
  )
}

function enabledState(value: string): InternalSystemdEnabledState {
  if (value === 'enabled' || value === 'enabled-runtime' || value === 'disabled') return value
  if (value === 'static' || value === 'indirect' || value === 'generated') return 'static'
  if (value === 'masked' || value === 'masked-runtime') return 'masked'
  if (value === '' || value === 'not-found') return 'not-found'
  return 'unknown'
}

function activeState(value: string): SystemdActiveState {
  if (
    value === 'active' ||
    value === 'inactive' ||
    value === 'failed' ||
    value === 'activating' ||
    value === 'deactivating'
  ) {
    return value
  }
  if (value === 'not-found') return 'not-found'
  return 'unknown'
}

function parseMainPid(value: string): number | null {
  if (value === '0') return null
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new LubanError('E_UNAVAILABLE', 'systemd returned an invalid MainPID snapshot', {
      retriable: true,
    })
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new LubanError('E_UNAVAILABLE', 'systemd returned an unsafe MainPID snapshot', {
      retriable: true,
    })
  }
  return parsed
}

function stableRuntimeState(snapshot: SystemdSnapshot): boolean {
  const enabled =
    snapshot.enabled === 'enabled' ||
    snapshot.enabled === 'disabled' ||
    snapshot.enabled === 'not-found'
  const running =
    snapshot.active === 'active' && snapshot.subState === 'running' && snapshot.mainPid !== null
  const inactive =
    snapshot.active === 'inactive' && snapshot.subState === 'dead' && snapshot.mainPid === null
  const failed =
    snapshot.active === 'failed' && snapshot.subState === 'failed' && snapshot.mainPid === null
  return enabled && (running || inactive || failed)
}

function runtimeReady(snapshot: SystemdSnapshot): boolean {
  return (
    snapshot.enabled === 'enabled' &&
    snapshot.active === 'active' &&
    snapshot.subState === 'running' &&
    snapshot.mainPid !== null
  )
}

function enabledSemantics(state: InternalSystemdEnabledState): 'enabled' | 'disabled' | 'unknown' {
  if (state === 'enabled') return 'enabled'
  if (state === 'disabled' || state === 'not-found') return 'disabled'
  return 'unknown'
}

function activeSemantics(snapshot: SystemdSnapshot): 'active' | 'stopped' | 'unknown' {
  if (
    snapshot.active === 'active' &&
    snapshot.subState === 'running' &&
    snapshot.mainPid !== null
  ) {
    return 'active'
  }
  if (
    ((snapshot.active === 'inactive' && snapshot.subState === 'dead') ||
      (snapshot.active === 'failed' && snapshot.subState === 'failed')) &&
    snapshot.mainPid === null
  ) {
    return 'stopped'
  }
  return 'unknown'
}

function sameActivationSemantics(expected: SystemdSnapshot, actual: SystemdSnapshot): boolean {
  const expectedEnabled = enabledSemantics(expected.enabled)
  const actualEnabled = enabledSemantics(actual.enabled)
  const expectedActive = activeSemantics(expected)
  const actualActive = activeSemantics(actual)
  return (
    expectedEnabled !== 'unknown' &&
    expectedEnabled === actualEnabled &&
    expectedActive !== 'unknown' &&
    expectedActive === actualActive
  )
}

function stoppedRuntime(snapshot: SystemdSnapshot): boolean {
  return activeSemantics(snapshot) === 'stopped' && snapshot.mainPid === null
}

function publicUnitState(state: EffectiveSystemdUnitState): SystemdUnitState {
  if (state === 'foreign') return 'different'
  if (state === 'stale') return 'changed'
  return state
}

function publicEnabledState(state: InternalSystemdEnabledState): SystemdEnabledState {
  return state === 'enabled-runtime' ? 'unknown' : state
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
    const dshExecutable = options.dshExecutable.trim()
    if (dshExecutable === '' || containsControlCharacter(dshExecutable)) {
      throw new LubanError('E_INVALID_INPUT', 'dsh executable is invalid')
    }
    const currentUser = options.currentUser ?? userInfo().username
    if (!USER_PATTERN.test(currentUser)) {
      throw new LubanError('E_INVALID_INPUT', 'current systemd user is invalid')
    }
    this.#runner = options.runner
    this.#serviceName = options.serviceName
    this.#dshExecutable = dshExecutable
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

  public render(
    profile: 'ubuntu-server',
    dshExecutable: string = this.#dshExecutable,
    fixedPath: string = this.#fixedPath(),
  ): string {
    if (!isAbsolute(dshExecutable)) {
      throw new LubanError(
        'E_INVALID_INPUT',
        'systemd unit rendering requires a resolved absolute dsh executable',
      )
    }
    return [
      '[Unit]',
      'Description=dsh-luban workbench (DSH web profile)',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=exec',
      `ExecStart=${systemdArg(dshExecutable)} ${systemdArg('--profile')} ${systemdArg(profile)} ${systemdArg('--no-open')}`,
      `Environment=${systemdArg(`PATH=${fixedPath}`)}`,
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
    return (await this.#prepare(user, profile)).preflight
  }

  /** Return a secret-free, read-only snapshot of the user unit. */
  public async status(
    user: string = this.#currentUser,
    profile: 'ubuntu-server' = 'ubuntu-server',
  ): Promise<SystemdStatus> {
    const prepared = await this.#prepare(user, profile)
    const snapshot = prepared.snapshot ?? (await this.#snapshot())
    return {
      schemaVersion: 1,
      service: this.#service,
      user,
      unitPath: this.unitPath,
      linger: prepared.preflight.linger,
      unit: prepared.preflight.unit,
      enabled: publicEnabledState(snapshot.enabled),
      active: snapshot.active,
    }
  }

  public async install(user: string, profile: 'ubuntu-server'): Promise<void> {
    const prepared = await this.#prepare(user, profile)
    if (prepared.preflight.linger !== 'enabled') {
      throw new LubanError(
        'E_UNAVAILABLE',
        'Current-user linger must already be enabled before installing the systemd unit',
      )
    }
    this.#assertInstallable(prepared.effectiveUnit)
    if (prepared.snapshot === undefined) {
      throw new LubanError('E_UNAVAILABLE', 'systemd preflight did not produce a safe snapshot')
    }

    const previous = prepared.snapshot
    let ownedIdentity: FileIdentity
    let created = false
    if (prepared.local.state === 'missing') {
      this.#assertManagerAbsent(previous)
      ownedIdentity = await this.#createUnit(prepared.expected)
      created = true
    } else {
      this.#assertExactUnit(prepared.local)
      ownedIdentity = prepared.local.identity
      const managerAbsent = this.#managerAbsent(previous)
      if (!managerAbsent) {
        this.#assertManagedConfiguration(previous, await realpath(this.unitPath))
      }
      if (!stableRuntimeState(previous)) {
        throw new LubanError(
          'E_UNAVAILABLE',
          'Existing systemd service state is not stable enough for safe installation',
          { retriable: true },
        )
      }
      if (!managerAbsent && runtimeReady(previous)) {
        await this.#assertOwnedUnit(ownedIdentity, prepared.expected)
        await this.#assertLaunchUnchanged(prepared.launch)
        return
      }
    }

    let reloadAttempted = false
    let activationAttempted = false
    try {
      await this.#assertOwnedUnit(ownedIdentity, prepared.expected)
      await this.#assertLaunchUnchanged(prepared.launch)
      reloadAttempted = true
      await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
      await this.#assertOwnedUnit(ownedIdentity, prepared.expected)
      await this.#assertLaunchUnchanged(prepared.launch)
      const loaded = await this.#snapshot()
      this.#assertManagedConfiguration(loaded, await realpath(this.unitPath))
      if (!sameActivationSemantics(previous, loaded)) {
        throw new LubanError(
          'E_UNAVAILABLE',
          'systemd activation state changed during daemon reload',
          { retriable: true },
        )
      }

      activationAttempted = true
      await this.#checked(
        'systemctl',
        ['--user', 'enable', '--now', this.#service],
        'enable dsh-luban service',
      )
      const verified = await this.#prepare(user, profile)
      if (
        verified.preflight.linger !== 'enabled' ||
        verified.effectiveUnit !== 'exact' ||
        verified.snapshot === undefined ||
        !runtimeReady(verified.snapshot)
      ) {
        throw new LubanError(
          'E_UNAVAILABLE',
          'systemd service did not reach enabled, active, running, and MainPID-ready state',
          { retriable: true },
        )
      }
      await this.#assertOwnedUnit(ownedIdentity, prepared.expected)
      await this.#assertLaunchUnchanged(prepared.launch)
    } catch (error: unknown) {
      if (activationAttempted) {
        try {
          await this.#restoreActivation(previous, ownedIdentity, prepared.expected, prepared.launch)
        } catch (rollbackError: unknown) {
          throw new LubanError('E_IO', 'Unable to safely roll back systemd activation', {
            cause: rollbackError,
          })
        }
      } else if (reloadAttempted && !created) {
        try {
          await this.#restoreReloadedConfiguration(
            previous,
            ownedIdentity,
            prepared.expected,
            prepared.launch,
          )
        } catch (rollbackError: unknown) {
          throw new LubanError('E_IO', 'Unable to restore systemd configuration after reload', {
            cause: rollbackError,
          })
        }
      }
      if (created) {
        try {
          if (reloadAttempted && !activationAttempted) {
            await this.#quiesceCreatedUnit(previous, ownedIdentity, prepared.expected)
          }
          await this.#removeOwnedUnit(ownedIdentity, prepared.expected)
          if (reloadAttempted) {
            await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units', true)
            this.#assertManagerAbsent(await this.#snapshot(true))
          }
        } catch (rollbackError: unknown) {
          throw new LubanError(
            'E_IO',
            'Unable to safely roll back the newly created systemd unit',
            { cause: rollbackError },
          )
        }
      }
      throw error
    }
  }

  public async uninstall(user: string = this.#currentUser): Promise<void> {
    this.#assertLinux()
    this.#assertCurrentUser(user)
    const launch = await this.#resolveLaunch()
    const expected = this.render('ubuntu-server', launch.dsh.path, launch.fixedPath)
    const unit = await this.#inspectUnit(expected)
    const snapshot = await this.#snapshot()

    if (unit.state === 'missing') {
      if (!stoppedRuntime(snapshot)) {
        throw new LubanError(
          'E_UNAVAILABLE',
          'Refusing to uninstall while a same-name systemd service is still running',
          { retriable: true },
        )
      }
      await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
      this.#assertManagerAbsent(await this.#snapshot())
      return
    }

    this.#assertExactUnit(unit)
    await this.#assertLaunchUnchanged(launch)
    if (this.#managerAbsent(snapshot)) {
      await this.#assertOwnedUnit(unit.identity, expected)
      await this.#removeOwnedUnit(unit.identity, expected)
      await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
      this.#assertManagerAbsent(await this.#snapshot())
      return
    }
    this.#assertManagedConfiguration(snapshot, await realpath(this.unitPath))
    await this.#disableAndVerify()
    await this.#assertOwnedUnit(unit.identity, expected)
    await this.#removeOwnedUnit(unit.identity, expected)
    await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
    this.#assertManagerAbsent(await this.#snapshot())
  }

  get #service(): string {
    return `${this.#serviceName}${UNIT_SUFFIX}`
  }

  async #prepare(user: string, profile: 'ubuntu-server'): Promise<PreparedUnit> {
    this.#assertLinux()
    this.#assertCurrentUser(user)
    const launch = await this.#resolveLaunch()
    const expected = this.render(profile, launch.dsh.path, launch.fixedPath)
    const [linger, local] = await Promise.all([
      this.#lingerState(user),
      this.#inspectUnit(expected),
    ])
    let snapshot: SystemdSnapshot | undefined
    let effectiveUnit: EffectiveSystemdUnitState = local.state
    if (local.state === 'missing' || local.state === 'exact') {
      snapshot = await this.#snapshot()
      effectiveUnit = await this.#reconcileUnit(local, snapshot)
    }
    return {
      launch,
      expected,
      local,
      ...(snapshot === undefined ? {} : { snapshot }),
      effectiveUnit,
      preflight: {
        schemaVersion: 1,
        service: this.#service,
        user,
        unitPath: this.unitPath,
        linger,
        unit: publicUnitState(effectiveUnit),
        ready: linger === 'enabled' && (effectiveUnit === 'missing' || effectiveUnit === 'exact'),
      },
    }
  }

  async #reconcileUnit(
    local: InspectedUnit,
    snapshot: SystemdSnapshot,
  ): Promise<EffectiveSystemdUnitState> {
    if (local.state === 'missing') {
      return this.#managerAbsent(snapshot) ? 'missing' : 'foreign'
    }
    if (local.state !== 'exact') return local.state
    if (this.#managerAbsent(snapshot)) return 'exact'
    const canonicalPath = await realpath(this.unitPath)
    return this.#managedConfiguration(snapshot, canonicalPath) && stableRuntimeState(snapshot)
      ? 'exact'
      : 'stale'
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

  #fixedPathDirectories(): readonly string[] {
    const pathValue = process.env.PATH
    if (pathValue === undefined || pathValue === '') {
      throw new LubanError('E_UNAVAILABLE', 'Unable to construct a fixed service PATH')
    }
    let nodeDirectory: string
    try {
      nodeDirectory = dirname(realpathSync(process.execPath))
    } catch (error: unknown) {
      throw new LubanError('E_UNAVAILABLE', 'Unable to resolve the current Node executable', {
        cause: error,
      })
    }
    const configured = pathValue.split(delimiter)
    if (
      configured.length > MAX_PATH_DIRECTORIES ||
      configured.some((directory) => directory === '' || !isAbsolute(directory))
    ) {
      throw new LubanError('E_UNAVAILABLE', 'Executable PATH contains an unsafe directory')
    }
    const directories = [...new Set([nodeDirectory, ...configured])]
    for (const directory of directories) systemdArg(directory)
    const fixedPath = directories.join(':')
    if (fixedPath.length > MAX_FIXED_PATH_LENGTH) {
      throw new LubanError('E_UNAVAILABLE', 'Executable PATH is too large for the service unit')
    }
    return directories
  }

  #fixedPath(): string {
    return this.#fixedPathDirectories().join(':')
  }

  async #resolveLaunch(): Promise<ResolvedLaunch> {
    const directories = this.#fixedPathDirectories()
    const node = await this.#requiredExecutable(await realpath(process.execPath), 'Node')
    const nodeCommand = process.platform === 'win32' ? 'node.exe' : 'node'
    const resolvedNode = await this.#resolveFromDirectories(nodeCommand, directories)
    if (resolvedNode === undefined || !sameExecutable(node, resolvedNode)) {
      throw new LubanError(
        'E_UNAVAILABLE',
        'The fixed service PATH does not resolve node to the current Node executable',
      )
    }

    let dsh: ResolvedExecutable | undefined
    if (isAbsolute(this.#dshExecutable)) {
      dsh = await this.#inspectExecutable(this.#dshExecutable)
    } else {
      if (this.#dshExecutable.includes('/') || this.#dshExecutable.includes('\\')) {
        throw new LubanError('E_INVALID_INPUT', 'relative dsh executable paths are not permitted')
      }
      dsh = await this.#resolveFromDirectories(this.#dshExecutable, directories)
    }
    if (dsh === undefined) {
      throw new LubanError(
        'E_UNAVAILABLE',
        'No executable regular file could be resolved for dsh',
        {
          retriable: true,
        },
      )
    }
    systemdArg(dsh.path)
    return { dsh, node, fixedPath: directories.join(':') }
  }

  async #requiredExecutable(path: string, label: string): Promise<ResolvedExecutable> {
    const executable = await this.#inspectExecutable(path)
    if (executable === undefined) {
      throw new LubanError('E_UNAVAILABLE', `${label} is not an executable regular file`, {
        retriable: true,
      })
    }
    return executable
  }

  async #resolveFromDirectories(
    executable: string,
    directories: readonly string[],
  ): Promise<ResolvedExecutable | undefined> {
    for (const directory of directories) {
      const inspected = await this.#inspectExecutable(resolve(directory, executable))
      if (inspected !== undefined) return inspected
    }
    return undefined
  }

  async #inspectExecutable(candidate: string): Promise<ResolvedExecutable | undefined> {
    try {
      const resolved = await realpath(candidate)
      if (!isAbsolute(resolved)) return undefined
      systemdArg(resolved)
      const pathStats = await lstat(resolved)
      if (pathStats.isSymbolicLink() || !pathStats.isFile()) return undefined
      await access(resolved, constants.X_OK)
      const handle = await open(resolved, constants.O_RDONLY | NO_FOLLOW)
      try {
        const openedStats = await handle.stat()
        const finalStats = await lstat(resolved)
        if (
          !openedStats.isFile() ||
          finalStats.isSymbolicLink() ||
          !finalStats.isFile() ||
          !sameIdentity(
            identityOf(openedStats.dev, openedStats.ino),
            identityOf(finalStats.dev, finalStats.ino),
          )
        ) {
          return undefined
        }
        return {
          path: resolved,
          identity: executableIdentityOf(
            openedStats.dev,
            openedStats.ino,
            openedStats.size,
            openedStats.ctimeMs,
          ),
        }
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      if (
        isFileSystemError(error, 'ENOENT') ||
        isFileSystemError(error, 'ENOTDIR') ||
        isFileSystemError(error, 'EACCES') ||
        isFileSystemError(error, 'EPERM') ||
        isFileSystemError(error, 'ELOOP')
      ) {
        return undefined
      }
      if (error instanceof LubanError) throw error
      throw new LubanError('E_IO', 'Unable to inspect an executable', { cause: error })
    }
  }

  async #assertLaunchUnchanged(expected: ResolvedLaunch): Promise<void> {
    const current = await this.#resolveLaunch()
    if (
      current.fixedPath !== expected.fixedPath ||
      !sameExecutable(current.dsh, expected.dsh) ||
      !sameExecutable(current.node, expected.node)
    ) {
      throw new LubanError('E_IO', 'The dsh or Node launch environment changed during operation')
    }
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

    await this.#assertOwnedUnit(identity, content)
    return identity
  }

  async #assertOwnedUnit(identity: FileIdentity, expected: string): Promise<void> {
    const inspected = await this.#inspectUnit(expected)
    if (
      inspected.state !== 'exact' ||
      inspected.identity === undefined ||
      !sameIdentity(inspected.identity, identity)
    ) {
      throw new LubanError('E_IO', 'Managed systemd unit changed during operation')
    }
  }

  async #removeOwnedUnit(identity: FileIdentity, expected: string): Promise<void> {
    await this.#assertOwnedUnit(identity, expected)
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

  async #snapshot(compensating = false): Promise<SystemdSnapshot> {
    const args = ['--user', 'show', this.#service, '--all', '--no-pager']
    for (const property of SHOW_PROPERTIES) args.push('-p', property)
    const result = await this.#run('systemctl', args, compensating)
    if (result.exitCode !== 0) {
      assertProcessSuccess(result, 'inspect dsh-luban service')
    }
    const values = new Map<ShowProperty, string>()
    const lines = result.stdout.endsWith('\n')
      ? result.stdout.slice(0, -1).split('\n')
      : result.stdout.split('\n')
    for (const line of lines) {
      const separator = line.indexOf('=')
      if (separator <= 0) {
        throw new LubanError('E_UNAVAILABLE', 'systemd returned a malformed service snapshot')
      }
      const key = line.slice(0, separator)
      const value = line.slice(separator + 1)
      if (
        !SHOW_PROPERTIES.includes(key as ShowProperty) ||
        values.has(key as ShowProperty) ||
        containsControlCharacter(value)
      ) {
        throw new LubanError('E_UNAVAILABLE', 'systemd returned an unsafe service snapshot')
      }
      values.set(key as ShowProperty, value)
    }
    if (values.size !== SHOW_PROPERTIES.length) {
      throw new LubanError('E_UNAVAILABLE', 'systemd service snapshot is incomplete')
    }
    const value = (key: ShowProperty): string => {
      const found = values.get(key)
      if (found === undefined) {
        throw new LubanError('E_UNAVAILABLE', 'systemd service snapshot is incomplete')
      }
      return found
    }
    return {
      id: value('Id'),
      loadState: value('LoadState'),
      fragmentPath: value('FragmentPath'),
      dropInPaths: value('DropInPaths'),
      needDaemonReload: value('NeedDaemonReload'),
      enabled: enabledState(value('UnitFileState')),
      active: activeState(value('ActiveState')),
      subState: value('SubState'),
      mainPid: parseMainPid(value('MainPID')),
      type: value('Type'),
    }
  }

  #managerAbsent(snapshot: SystemdSnapshot): boolean {
    return (
      snapshot.id === this.#service &&
      snapshot.loadState === 'not-found' &&
      snapshot.fragmentPath === '' &&
      snapshot.dropInPaths === '' &&
      snapshot.needDaemonReload === 'no' &&
      snapshot.enabled === 'not-found' &&
      snapshot.active === 'inactive' &&
      snapshot.subState === 'dead' &&
      snapshot.mainPid === null &&
      snapshot.type === ''
    )
  }

  #managedConfiguration(snapshot: SystemdSnapshot, canonicalUnitPath: string): boolean {
    return (
      snapshot.id === this.#service &&
      snapshot.loadState === 'loaded' &&
      snapshot.fragmentPath === canonicalUnitPath &&
      snapshot.dropInPaths === '' &&
      snapshot.needDaemonReload === 'no' &&
      snapshot.type === 'exec'
    )
  }

  #assertManagerAbsent(snapshot: SystemdSnapshot): void {
    if (this.#managerAbsent(snapshot)) return
    throw new LubanError(
      'E_INVALID_INPUT',
      'A same-name foreign or stale systemd service is already present',
    )
  }

  #assertManagedConfiguration(snapshot: SystemdSnapshot, canonicalUnitPath: string): void {
    if (this.#managedConfiguration(snapshot, canonicalUnitPath)) return
    throw new LubanError(
      'E_INVALID_INPUT',
      'The effective systemd service does not match the managed unit',
    )
  }

  async #restoreReloadedConfiguration(
    previous: SystemdSnapshot,
    identity: FileIdentity,
    expected: string,
    launch: ResolvedLaunch,
  ): Promise<void> {
    await this.#assertOwnedUnit(identity, expected)
    await this.#assertLaunchUnchanged(launch)
    await this.#checked(
      'systemctl',
      ['--user', 'daemon-reload'],
      'restore user unit configuration',
      true,
    )
    await this.#assertOwnedUnit(identity, expected)
    await this.#assertLaunchUnchanged(launch)
    const current = await this.#snapshot(true)
    this.#assertManagedConfiguration(current, await realpath(this.unitPath))
    if (!sameActivationSemantics(previous, current)) {
      await this.#restoreActivation(previous, identity, expected, launch)
    }
  }

  async #quiesceCreatedUnit(
    previous: SystemdSnapshot,
    identity: FileIdentity,
    expected: string,
  ): Promise<void> {
    await this.#assertOwnedUnit(identity, expected)
    const current = await this.#snapshot(true)
    if (this.#managerAbsent(current)) return
    this.#assertManagedConfiguration(current, await realpath(this.unitPath))
    if (!sameActivationSemantics(previous, current)) {
      await this.#restoreActivation(previous, identity, expected)
    }
  }

  async #restoreActivation(
    previous: SystemdSnapshot,
    identity: FileIdentity,
    expected: string,
    launch?: ResolvedLaunch,
  ): Promise<void> {
    await this.#assertOwnedUnit(identity, expected)
    const canonicalPath = await realpath(this.unitPath)
    const current = await this.#snapshot(true)
    this.#assertManagedConfiguration(current, canonicalPath)
    if (sameActivationSemantics(previous, current)) return

    await this.#disableAndVerify(true)
    const restoreEnabled = enabledSemantics(previous.enabled) === 'enabled'
    const restoreActive = activeSemantics(previous) === 'active'
    if ((restoreEnabled || restoreActive) && launch !== undefined) {
      await this.#assertLaunchUnchanged(launch)
    }
    if (restoreEnabled) {
      await this.#checked(
        'systemctl',
        ['--user', 'enable', this.#service],
        'restore systemd enabled state',
        true,
      )
    }
    if (restoreActive) {
      await this.#checked(
        'systemctl',
        ['--user', 'start', this.#service],
        'restore systemd active state',
        true,
      )
    }
    const restored = await this.#snapshot(true)
    this.#assertManagedConfiguration(restored, canonicalPath)
    if (!sameActivationSemantics(previous, restored)) {
      throw new LubanError('E_UNAVAILABLE', 'systemd activation state could not be restored', {
        retriable: true,
      })
    }
  }

  async #disableAndVerify(compensating = false): Promise<void> {
    const canonicalPath = await realpath(this.unitPath)
    this.#assertManagedConfiguration(await this.#snapshot(compensating), canonicalPath)
    let result: ProcessResult | undefined
    let commandError: unknown
    try {
      result = await this.#run(
        'systemctl',
        ['--user', 'disable', '--now', this.#service],
        compensating,
      )
    } catch (error: unknown) {
      commandError = error
    }
    const verified = await this.#snapshot(compensating)
    this.#assertManagedConfiguration(verified, canonicalPath)
    if (verified.enabled === 'disabled' && stoppedRuntime(verified) && verified.mainPid === null) {
      return
    }
    if (result !== undefined && result.exitCode !== 0) {
      assertProcessSuccess(result, 'disable dsh-luban service')
    }
    if (commandError !== undefined) {
      throw new LubanError('E_UNAVAILABLE', 'Unable to disable the systemd service', {
        retriable: true,
        cause: commandError,
      })
    }
    throw new LubanError('E_UNAVAILABLE', 'systemd service shutdown could not be verified', {
      retriable: true,
    })
  }

  #assertInstallable(state: EffectiveSystemdUnitState): void {
    if (state === 'missing' || state === 'exact') return
    throw new LubanError(
      'E_INVALID_INPUT',
      state === 'different'
        ? 'Existing systemd unit content differs from the managed unit'
        : state === 'foreign' || state === 'stale'
          ? 'A same-name foreign or stale systemd service prevents safe installation'
          : 'Existing systemd unit is not a safe regular file',
    )
  }

  #assertExactUnit(unit: InspectedUnit): asserts unit is InspectedUnit & {
    readonly state: 'exact'
    readonly identity: FileIdentity
  } {
    if (unit.state !== 'exact' || unit.identity === undefined) {
      throw new LubanError('E_INVALID_INPUT', 'Unable to verify the managed systemd unit')
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

  async #run(
    command: string,
    args: readonly string[],
    compensating = false,
  ): Promise<ProcessResult> {
    return await this.#runner.run(command, args, {
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: 4_096,
      signal: compensating ? undefined : this.#signal,
    })
  }

  async #checked(
    command: string,
    args: readonly string[],
    operation: string,
    compensating = false,
  ): Promise<void> {
    assertProcessSuccess(await this.#run(command, args, compensating), operation)
  }
}
