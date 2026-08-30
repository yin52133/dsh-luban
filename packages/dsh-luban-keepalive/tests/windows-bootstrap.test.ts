import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import type { ChildProcess, spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  createWindowsHostEnvironment,
  runWindowsHostBootstrap,
} from '../src/windows-host-bootstrap.js'

describe('Windows host bootstrap', (): void => {
  it('preserves the normal user environment used to launch DSH', (): void => {
    const environment = createWindowsHostEnvironment(
      {
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\builder\\AppData\\Local',
        PATH: 'C:\\custom-bin',
        USERPROFILE: 'C:\\Users\\builder',
      },
      process.execPath,
    )

    expect(environment.PATH).toBe('C:\\custom-bin')
    expect(environment.USERPROFILE).toBe('C:\\Users\\builder')
    expect(environment.ProgramFiles).toBe('C:\\Program Files')
    expect(environment.LOCALAPPDATA).toBe('C:\\Users\\builder\\AppData\\Local')
    expect(environment).toMatchObject({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
    })
  })

  it('spawns the selected DSH entry and supplies restart/acceptance context', async (): Promise<void> => {
    const captured: {
      command?: string
      args?: readonly string[]
      options?: Readonly<Record<string, unknown>>
    } = {}
    const fakeSpawn = ((
      command: string,
      args: readonly string[],
      options: Readonly<Record<string, unknown>>,
    ): ChildProcess => {
      captured.command = command
      captured.args = args
      captured.options = options
      const child = new EventEmitter() as ChildProcess
      queueMicrotask((): void => {
        child.emit('close', 0)
      })
      return child
    }) as typeof spawn
    const dshEntry = resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')
    const runDir = resolve('private-m03-run')
    const runId = '11111111-1111-4111-8111-111111111111'
    const result = await runWindowsHostBootstrap(
      [
        '--dsh-entry',
        dshEntry,
        '--dsh-home',
        resolve('.dsh'),
        '--profile',
        'win-debug',
        '--acceptance-run-dir',
        runDir,
        '--acceptance-run-id',
        runId,
        '--acceptance-spec-sha256',
        'a'.repeat(64),
      ],
      {
        platform: 'win32',
        now: (): number => 1_000_000,
        uptime: (): number => 500,
        spawn: fakeSpawn,
        environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\custom-bin' },
      },
    )

    expect(result).toBe(0)
    expect(captured.command).toBe(process.execPath)
    expect(captured.args).toEqual([dshEntry, '--profile', 'win-debug', '--no-open'])
    expect(captured.options).toMatchObject({ shell: false, windowsHide: true })
    const environment = captured.options?.env as NodeJS.ProcessEnv
    expect(environment).toMatchObject({
      LUBAN_BOOT_RESTORE: '1',
      DSH_HOME: resolve('.dsh'),
      LUBAN_M03_HOST_STARTED_AT: '1000000',
      LUBAN_M03_BOOT_STARTED_AT: '500000',
      LUBAN_M03_ACCEPTANCE_RUN_DIR: runDir,
      LUBAN_M03_ACCEPTANCE_RUN_ID: runId,
      LUBAN_M03_ACCEPTANCE_SPEC_SHA256: 'a'.repeat(64),
    })
    expect(environment.PATH).toBe('C:\\custom-bin')
    expect(environment.TEMP).toBe(runDir)
    expect(environment.TMP).toBe(runDir)
  })
})
