import { askNewPassword, terminalPrompts } from '../src/recovery-prompts.js'

try {
  const password = await askNewPassword(terminalPrompts())
  if (password !== 'Recovery test 2026!') throw new Error('Unexpected test input')
  process.stdout.write('PROMPT_SMOKE_PASS\n')
} catch (error) {
  process.stdout.write(`${error instanceof Error ? error.message : 'Prompt failed'}\n`)
  process.exitCode = 1
}
