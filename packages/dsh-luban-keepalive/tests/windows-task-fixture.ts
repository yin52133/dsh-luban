import { readFile } from 'node:fs/promises'
import type { CommandOptions, CommandResult, CommandRunner } from '../src/command-runner.js'

export interface ScheduledTaskCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CommandOptions
}

function result(stdout = '', exitCode = 0, stderr = ''): CommandResult {
  return { exitCode, stdout, stderr, durationMs: 1 }
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

/** In-memory schtasks model; only the temporary XML staging file touches the test filesystem. */
export class FakeScheduledTaskRunner implements CommandRunner {
  public readonly calls: ScheduledTaskCall[] = []
  public readonly tasks = new Map<string, string>()
  public readonly running = new Set<string>()
  public readonly createdXml: string[] = []
  public failNextCreateAfterStore = false
  public failNextRun = false
  public failNextDelete = false
  public statusStderr = ''
  public missingStderr = 'ERROR: The system cannot find the file specified.'
  public elevated = true

  public async run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options })
    if (command === 'whoami.exe') {
      return result('"DESKTOP\\builder","S-1-5-21-1000"\r\n')
    }
    if (command === 'powershell.exe') {
      const encoded = valueAfter(args, '-EncodedCommand')
      if (encoded === undefined) throw new Error('Invalid fake PowerShell call')
      const script = Buffer.from(encoded, 'base64').toString('utf16le')
      if (script.includes('WindowsBuiltInRole')) {
        return result(this.elevated ? 'elevated' : 'standard')
      }
      const taskName = /-TaskName '([^']+)'/u.exec(script)?.[1]
      if (taskName === undefined) throw new Error('Invalid fake task-state script')
      const name = `\\${taskName}`
      if (!this.tasks.has(name)) return result('', 1, 'task missing')
      return result(this.running.has(name) ? 'running' : 'stopped', 0, this.statusStderr)
    }
    if (command !== 'schtasks.exe') throw new Error(`Unexpected command: ${command}`)

    if (args[0] === '/Create') {
      const name = valueAfter(args, '/TN')
      const path = valueAfter(args, '/XML')
      if (name === undefined || path === undefined) throw new Error('Invalid fake create call')
      if (this.tasks.has(name)) return result('', 1, 'ERROR: task already exists')
      const xml = await readFile(path, 'utf8')
      this.createdXml.push(xml)
      this.tasks.set(name, xml)
      if (this.failNextCreateAfterStore) {
        this.failNextCreateAfterStore = false
        return result('', 1, 'simulated create failure')
      }
      return result()
    }

    if (args[0] === '/Query' && args.includes('/TN')) {
      const name = valueAfter(args, '/TN')
      if (name === undefined) throw new Error('Invalid fake query call')
      const xml = this.tasks.get(name)
      if (xml === undefined) return this.#missing()
      if (args.includes('/XML')) return result(xml)
      if (args.includes('/V')) {
        return result(
          `Status: ${this.running.has(name) ? 'Running' : 'Ready'}`,
          0,
          this.statusStderr,
        )
      }
      return result()
    }

    if (args[0] === '/Query') {
      return result(
        [...this.tasks.keys()]
          .map(
            (name): string => `"${name}","N/A","${this.running.has(name) ? 'Running' : 'Ready'}"`,
          )
          .join('\r\n'),
      )
    }

    const name = valueAfter(args, '/TN')
    if (name === undefined || !this.tasks.has(name)) return this.#missing()
    if (args[0] === '/Run') {
      if (this.failNextRun) {
        this.failNextRun = false
        return result('', 1, 'simulated run failure')
      }
      this.running.add(name)
      return result()
    }
    if (args[0] === '/End') {
      if (!this.running.delete(name)) return result('', 1, 'task is not currently running')
      return result()
    }
    if (args[0] === '/Delete') {
      if (this.failNextDelete) {
        this.failNextDelete = false
        return result('', 1, 'simulated delete failure')
      }
      this.tasks.delete(name)
      this.running.delete(name)
      return result()
    }
    throw new Error(`Unexpected schtasks arguments: ${args.join(' ')}`)
  }

  #missing(): CommandResult {
    return result('', 1, this.missingStderr)
  }
}
