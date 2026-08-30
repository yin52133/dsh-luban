import { LubanError } from '@luban/core'

const MANAGED_ID = /^luban-[a-z0-9][a-z0-9_.-]{0,57}$/u

/** Convert an application id into the common luban-* managed-session namespace. */
export function managedSessionId(id: string): string {
  const normalized = id.startsWith('luban-') ? id : `luban-${id}`
  if (!MANAGED_ID.test(normalized)) {
    throw new LubanError(
      'E_INVALID_INPUT',
      'session id must contain only lowercase letters, digits, dots, underscores, and hyphens',
    )
  }
  return normalized
}

export function posixCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((value): string => `'${value.replaceAll("'", `'"'"'`)}'`).join(' ')
}

/** Quote one argv vector using the CommandLineToArgvW escaping convention. */
function windowsArgument(value: string): string {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new LubanError('E_INVALID_INPUT', 'Windows command argument contains a control character')
  }
  if (value !== '' && !/[\s"]/u.test(value)) return value
  let result = '"'
  let backslashes = 0
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1
    } else if (character === '"') {
      result += `${'\\'.repeat(backslashes * 2 + 1)}"`
      backslashes = 0
    } else {
      result += `${'\\'.repeat(backslashes)}${character}`
      backslashes = 0
    }
  }
  return `${result}${'\\'.repeat(backslashes * 2)}"`
}

export function windowsArguments(args: readonly string[]): string {
  return args.map(windowsArgument).join(' ')
}

export function windowsCommand(command: string, args: readonly string[]): string {
  return [windowsArgument(command), windowsArguments(args)]
    .filter((value) => value !== '')
    .join(' ')
}
