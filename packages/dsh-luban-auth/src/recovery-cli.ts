#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  assertRecoveryAccess,
  inspectRecoveryTarget,
  readRecoveryState,
  recoverAdministrator,
} from './admin-recovery.js'
import { askNewPassword, terminalPrompts } from './recovery-prompts.js'
import { normalizeUsername } from './username.js'

const execute = promisify(execFile)

export interface RecoveryArguments {
  readonly file: string
  readonly service: string
}

/** Accept only target identifiers; passwords cannot enter process arguments. */
export function parseRecoveryArguments(args: readonly string[]): RecoveryArguments {
  if (args[0] !== 'reset-admin')
    throw new Error('用法：luban-auth reset-admin --users-file <绝对路径> [--service dsh-luban]')
  let file: string | undefined
  let service = 'dsh-luban'
  const seen = new Set<string>()
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (
      (key !== '--users-file' && key !== '--service') ||
      value === undefined ||
      value.startsWith('--') ||
      seen.has(key)
    )
      throw new Error('参数无效；仅支持 --users-file 和 --service，密码只能交互输入。')
    seen.add(key)
    if (key === '--users-file') file = value
    else service = value
  }
  if (file === undefined)
    throw new Error('请用 --users-file 明确指定当前服务的账号文件，不会自动猜测或读取隐藏配置。')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$/u.test(service)) throw new Error('服务名无效。')
  return { file, service: service.endsWith('.service') ? service : `${service}.service` }
}

/** Authenticate locally, then permanently drop to the file owner before reading or writing accounts. */
export async function runRecoveryCli(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      '用法：sudo <node绝对路径> <recovery-cli.js绝对路径> reset-admin --users-file <账号文件绝对路径> [--service dsh-luban]\n仅限 Ubuntu/Linux 交互终端。验证 sudo 权限后选择管理员并输入新密码；自动备份、停服和恢复服务。\n',
    )
    return
  }
  const options = parseRecoveryArguments(args)
  assertRecoveryAccess(
    process.platform,
    process.geteuid?.(),
    process.stdin.isTTY && process.stdout.isTTY,
  )
  const target = await inspectRecoveryTarget(options.file)
  // Never retain root privileges while opening user-owned state or invoking its systemd manager.
  if (
    process.setgroups === undefined ||
    process.setgid === undefined ||
    process.setuid === undefined
  )
    throw new Error('当前系统无法安全切换到账号文件所属用户。')
  process.setgroups([])
  process.setgid(target.gid)
  process.setuid(target.uid)
  const environment = {
    ...process.env,
    XDG_RUNTIME_DIR: `/run/user/${String(target.uid)}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${String(target.uid)}/bus`,
  }
  const systemctl = async (...args: string[]): Promise<string> => {
    const result = await execute('/usr/bin/systemctl', ['--user', ...args, options.service], {
      env: environment,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    })
    return result.stdout.trim()
  }
  if ((await systemctl('show', '--property=LoadState', '--value')) !== 'loaded')
    throw new Error('未找到指定的用户服务；请确认 --service 和账号文件属于同一部署。')
  const state = await readRecoveryState(target.file)
  const administrators = Object.values(state.users)
    .filter((user) => user.role === 'admin')
    .map((user) => user.username)
  if (administrators.length === 0) throw new Error('此文件没有管理员账号；首次使用请在网页注册。')
  const prompts = terminalPrompts()
  prompts.write(
    `账号文件：${target.file}\n所属用户 UID：${String(target.uid)}\n将短暂停止并恢复服务：${options.service}\n管理员：${administrators.join('、')}`,
  )
  let username: string
  for (;;) {
    try {
      username = normalizeUsername(await prompts.ask('要复位的管理员用户名：'))
      if (administrators.includes(username)) break
      prompts.write('未找到该管理员，请从上面的管理员中选择。')
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      prompts.write(error.message)
    }
  }
  const password = await askNewPassword(prompts)
  if (
    (await prompts.ask('确认复位并退出该管理员的所有登录？输入 yes 继续：'))
      .trim()
      .toLowerCase() !== 'yes'
  ) {
    prompts.write('已取消，未修改账号或服务。')
    return
  }
  const result = await recoverAdministrator(target, username, password, {
    running: async (): Promise<boolean> => {
      const status = await systemctl('show', '--property=ActiveState', '--value')
      if (status !== 'active' && status !== 'inactive' && status !== 'failed')
        throw new Error('服务正在切换状态，请稍后重试。')
      return status === 'active'
    },
    stop: async (): Promise<void> => {
      await systemctl('stop')
    },
    start: async (): Promise<void> => {
      await systemctl('start')
    },
  })
  prompts.write(
    `管理员 ${result.username} 的密码已复位，已撤销 ${String(result.revokedSessions)} 个登录会话。\n备份：${result.backup}\n请返回原来的网页登录地址，使用新密码登录。`,
  )
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runRecoveryCli(process.argv.slice(2)).catch((error: unknown): void => {
    process.stderr.write(`${error instanceof Error ? error.message : '本地复位失败。'}\n`)
    process.exitCode = 1
  })
}
