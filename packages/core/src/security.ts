const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*([^\s,;]+)/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/gu,
]

/** Redact common credential shapes before logs, snippets, or archives leave a boundary. */
export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, pattern) =>
      redacted.replace(pattern, (match: string): string => {
        const separator = /\s*[:=]\s*/u.exec(match)?.[0]
        if (separator === undefined) return '[REDACTED]'
        return `${match.slice(0, match.indexOf(separator))}${separator}[REDACTED]`
      }),
    input,
  )
}
