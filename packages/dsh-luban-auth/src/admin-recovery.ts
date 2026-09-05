import { constants } from 'node:fs'
import { lstat, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AtomicJsonStore } from '@yin52133/dsh-luban-core'
import { assertPassword, defaultPasswordHasher } from './auth-manager.js'
import { authStateCodec, initialAuthState } from './state.js'
import { normalizeUsername } from './username.js'
import type { AuthState } from './types.js'

export interface RecoveryTarget {
  readonly file: string
  readonly uid: number
  readonly gid: number
}

export interface RecoveryService {
  readonly running: () => Promise<boolean>
  readonly stop: () => Promise<void>
  readonly start: () => Promise<void>
}

export interface RecoveryResult {
  readonly username: string
  readonly backup: string
  readonly revokedSessions: number
}

/** Require OS administrator authentication; loopback requests and environment flags grant nothing. */
export function assertRecoveryAccess(
  platform: NodeJS.Platform,
  effectiveUid: number | undefined,
  interactive: boolean,
): void {
  if (platform !== 'linux') throw new Error('本地管理员复位目前仅支持 Ubuntu/Linux 服务器。')
  if (effectiveUid !== 0)
    throw new Error('需要服务器 sudo 管理权限。请通过 sudo 运行此命令，网页登录不能授权复位。')
  if (!interactive) throw new Error('必须在交互终端中操作；不接受管道、密码参数或环境变量。')
}

/** Inspect an existing private account file without following a redirected path. */
export async function inspectRecoveryTarget(input: string): Promise<RecoveryTarget> {
  if (!isAbsolute(input)) throw new Error('--users-file 必须是实际账号文件的绝对路径。')
  const file = resolve(input)
  if ((await realpath(file)) !== file) throw new Error('账号路径不能包含符号链接；请使用真实路径。')
  const metadata = await lstat(file)
  const parent = await lstat(dirname(file))
  if (!metadata.isFile() || metadata.nlink !== 1)
    throw new Error('账号文件必须是普通文件，不能是符号链接或硬链接。')
  if ((metadata.mode & 0o077) !== 0 || (parent.mode & 0o022) !== 0 || parent.uid !== metadata.uid) {
    throw new Error('账号文件必须仅所属用户可读写，父目录不能由其他用户写入且必须属于同一用户。')
  }
  return { file, uid: metadata.uid, gid: metadata.gid }
}

/** Read only a bounded, validated account document; never create a missing recovery target. */
export async function readRecoveryState(file: string): Promise<AuthState> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024)
      throw new Error('账号文件无效或过大。')
    return authStateCodec.decode(JSON.parse(await handle.readFile('utf8')) as unknown)
  } finally {
    await handle.close()
  }
}

/** Replace exactly one administrator credential and revoke only that account's sessions. */
export function resetAdministratorState(
  state: AuthState,
  username: string,
  passwordHash: string,
  now: number,
): { state: AuthState; revokedSessions: number } {
  const name = normalizeUsername(username)
  const account = Object.hasOwn(state.users, name) ? state.users[name] : undefined
  if (account?.role !== 'admin')
    throw new Error('只能复位已有管理员，不能创建账号或提升普通用户权限。')
  const updated = { ...account, passwordHash, updatedAt: now, failedCount: 0 }
  delete updated.lockedUntil
  const sessions = Object.fromEntries(
    Object.entries(state.sessions).filter(([, session]) => session.user !== name),
  )
  return {
    state: { ...state, users: { ...state.users, [name]: updated }, sessions },
    revokedSessions: Object.keys(state.sessions).length - Object.keys(sessions).length,
  }
}

/** Run offline as the verified file owner, retaining a private backup before the atomic update. */
export async function recoverAdministrator(
  target: RecoveryTarget,
  username: string,
  password: string,
  service: RecoveryService,
): Promise<RecoveryResult> {
  assertPassword(password)
  const name = normalizeUsername(username)
  const hash = await defaultPasswordHasher.hash(password)
  const wasRunning = await service.running()
  let result: RecoveryResult | undefined
  let failure: Error | undefined
  try {
    if (wasRunning) await service.stop()
    if (await service.running()) throw new Error('服务仍在运行，未修改账号。请检查指定的服务名。')
    const currentTarget = await inspectRecoveryTarget(target.file)
    if (currentTarget.uid !== target.uid || currentTarget.gid !== target.gid)
      throw new Error('账号文件所属用户已变化，已取消复位。')
    await readRecoveryState(target.file)
    const store = new AtomicJsonStore<AuthState>({
      filePath: target.file,
      codec: authStateCodec,
      initial: initialAuthState,
      backupCount: 0,
    })
    let prepared: RecoveryResult | undefined
    await store.update(async (state): Promise<AuthState> => {
      const now = Date.now()
      const reset = resetAdministratorState(state, name, hash, now)
      const backup = `${target.file}.recovery-${String(now)}-${randomUUID()}.json`
      const handle = await open(backup, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A separate private record contains no password or password hash.
      await writeFile(
        `${backup}.audit.json`,
        `${JSON.stringify({ action: 'reset-admin-requested', username: name, time: now, fileOwnerUid: target.uid, revokedSessions: reset.revokedSessions })}\n`,
        { flag: 'wx', mode: 0o600 },
      )
      prepared = { username: name, backup, revokedSessions: reset.revokedSessions }
      return reset.state
    })
    result = prepared
  } catch (error) {
    failure = error instanceof Error ? error : new Error('本地复位失败。')
  }
  if (wasRunning) {
    try {
      await service.start()
    } catch {
      throw new Error(
        result === undefined
          ? '复位未完成且服务恢复失败；请检查服务日志和已有备份。'
          : `密码已复位，但服务启动失败；请手动检查并启动服务。备份：${result.backup}`,
      )
    }
  }
  if (failure !== undefined) throw failure
  if (result === undefined) throw new Error('复位未完成。')
  return result
}
