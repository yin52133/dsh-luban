import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { assertPassword } from './auth-manager.js'

export interface RecoveryPrompts {
  ask(label: string, secret?: boolean): Promise<string>
  write(message: string): void
}

/** Prompt without echoing secrets, restoring terminal state on completion or Ctrl+C. */
export function terminalPrompts(): RecoveryPrompts {
  return {
    write: (message): void => {
      process.stdout.write(`${message}\n`)
    },
    ask: (label, secret = false): Promise<string> =>
      new Promise((resolve, reject): void => {
        const output = secret
          ? new Writable({
              write(_chunk, _encoding, callback): void {
                callback()
              },
            })
          : process.stdout
        const input = createInterface({ input: process.stdin, output, terminal: true })
        let answered = false
        input.once('SIGINT', (): void => {
          input.close()
        })
        input.once('close', (): void => {
          if (secret) {
            output.end()
            process.stdout.write('\n')
          }
          if (!answered) reject(new Error('已取消，未提交密码。'))
        })
        // Enter raw mode before showing the prompt so fast input cannot be echoed by the terminal.
        process.stdout.write(label)
        input.question('', (answer): void => {
          answered = true
          input.close()
          resolve(answer)
        })
      }),
  }
}

/** Keep invalid or mismatched passwords in the retry loop without changing persistent state. */
export async function askNewPassword(prompts: RecoveryPrompts): Promise<string> {
  for (;;) {
    const password = await prompts.ask('新密码（不回显）：', true)
    try {
      assertPassword(password)
    } catch {
      prompts.write('密码须为 8–1024 个字符，请重新输入。')
      continue
    }
    const confirmation = await prompts.ask('再次输入新密码：', true)
    if (password !== confirmation) {
      prompts.write('两次密码不一致，请重新输入。')
      continue
    }
    return password
  }
}
