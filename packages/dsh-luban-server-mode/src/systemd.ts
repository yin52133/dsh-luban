import { mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LubanError } from '@luban/core'
import type { ProcessRunner } from './process-runner.js'
import { assertProcessSuccess } from './process-runner.js'

export interface SystemdInstallerOptions {
  readonly runner: ProcessRunner
  readonly serviceName: string
  readonly dshExecutable: string
  readonly timeoutMs: number
  readonly platform?: NodeJS.Platform
  readonly unitDirectory?: string
  readonly signal?: AbortSignal
}

function systemdArg(value: string): string {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new LubanError('E_INVALID_INPUT', 'systemd argument contains an invalid character')
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

async function atomicText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filePath)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

export class UserSystemdInstaller {
  readonly #runner: ProcessRunner
  readonly #serviceName: string
  readonly #dshExecutable: string
  readonly #timeoutMs: number
  readonly #platform: NodeJS.Platform
  readonly #unitDirectory: string
  readonly #signal: AbortSignal | undefined

  public constructor(options: SystemdInstallerOptions) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$/u.test(options.serviceName)) {
      throw new LubanError('E_INVALID_INPUT', 'systemd service name is invalid')
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new LubanError('E_INVALID_INPUT', 'systemd command timeout must be positive')
    }
    this.#runner = options.runner
    this.#serviceName = options.serviceName
    this.#dshExecutable = options.dshExecutable
    this.#timeoutMs = options.timeoutMs
    this.#platform = options.platform ?? process.platform
    this.#unitDirectory = resolve(options.unitDirectory ?? join(homedir(), '.config/systemd/user'))
    this.#signal = options.signal
  }

  public get unitPath(): string {
    return join(this.#unitDirectory, `${this.#serviceName}.service`)
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

  public async install(user: string, profile: 'ubuntu-server'): Promise<void> {
    this.#assertLinux()
    if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(user)) {
      throw new LubanError('E_INVALID_INPUT', 'systemd linger user is invalid')
    }
    await atomicText(this.unitPath, this.render(profile))
    await this.#checked('loginctl', ['enable-linger', user], 'enable user linger')
    await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
    await this.#checked(
      'systemctl',
      ['--user', 'enable', '--now', `${this.#serviceName}.service`],
      'enable dsh-luban service',
    )
  }

  public async uninstall(): Promise<void> {
    this.#assertLinux()
    const disabled = await this.#runner.run(
      'systemctl',
      ['--user', 'disable', '--now', `${this.#serviceName}.service`],
      { timeoutMs: this.#timeoutMs, signal: this.#signal },
    )
    if (
      disabled.exitCode !== 0 &&
      !/not loaded|not found|does not exist|不存在|未找到/iu.test(
        `${disabled.stdout}\n${disabled.stderr}`,
      )
    ) {
      assertProcessSuccess(disabled, 'disable dsh-luban service')
    }
    await rm(this.unitPath, { force: true })
    await this.#checked('systemctl', ['--user', 'daemon-reload'], 'reload user units')
  }

  async #checked(command: string, args: readonly string[], operation: string): Promise<void> {
    const result = await this.#runner.run(command, args, {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    assertProcessSuccess(result, operation)
  }

  #assertLinux(): void {
    if (this.#platform !== 'linux') {
      throw new LubanError('E_PLATFORM_UNSUPPORTED', 'server mode systemd support is Ubuntu-only')
    }
  }
}
