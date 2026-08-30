import type { IncomingMessage } from 'node:http'
import type { AuthMiddlewareRequest } from 'dsh-luban-core'
import { BrowserError } from './errors.js'

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*([^\s,;]+)/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/gu,
]

const BASE_ENVIRONMENT = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'LANG',
  'LC_ALL',
] as const

export const DEFAULT_PASSED_ENVIRONMENT = [
  'BROWSER_USE_API_KEY',
  'BROWSER_USE_DEFAULT_LLM',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
] as const

export function redactBrowserLog(input: string): string {
  return SECRET_PATTERNS.reduce(
    (value, pattern) =>
      value.replace(pattern, (match: string): string => {
        const separator = /\s*[:=]\s*/u.exec(match)?.[0]
        if (separator === undefined) return '[REDACTED]'
        return `${match.slice(0, match.indexOf(separator))}${separator}[REDACTED]`
      }),
    input,
  )
}

export function bridgeEnvironment(
  source: NodeJS.ProcessEnv,
  passEnvironment: readonly string[],
  uvEnvironmentDirectory: string,
): NodeJS.ProcessEnv {
  const names = new Set<string>([...BASE_ENVIRONMENT, ...passEnvironment])
  const output: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new BrowserError(
        'E_BROWSER_INVALID_PROFILE',
        `Invalid environment variable name: ${name}`,
      )
    }
    const value = source[name]
    if (value !== undefined) output[name] = value
  }
  output.PYTHONUTF8 = '1'
  output.PYTHONUNBUFFERED = '1'
  output.UV_PROJECT_ENVIRONMENT = uvEnvironmentDirectory
  return output
}

export function authRequest(req: IncomingMessage): AuthMiddlewareRequest {
  const host = req.headers.host ?? 'localhost'
  const url = new URL(req.url ?? '/', `http://${host}`)
  return {
    path: url.pathname,
    method: req.method ?? 'GET',
    accept: typeof req.headers.accept === 'string' ? req.headers.accept : undefined,
    cookie: typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
    sourceIp: req.socket.remoteAddress ?? 'unknown',
  }
}
