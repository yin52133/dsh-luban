import type { TelemetrySnapshot } from '@yin52133/dsh-luban-core'
import type { HudKeepaliveStatus, TelemetryAdvisory } from './types.js'

const TERMINAL_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu

function integer(value: number | 'unknown'): string {
  return value === 'unknown' ? '?' : Math.round(value).toLocaleString('en-US')
}

/** Collapse untrusted labels or errors to bounded, single-line terminal text. */
export function sanitizeTerminalText(value: string, maximumLength = 160): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength <= 0) {
    throw new TypeError('maximumLength must be a positive safe integer')
  }
  return value
    .replace(TERMINAL_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximumLength)
}

function text(value: string): string {
  if (value === 'unknown') return '?'
  const sanitized = sanitizeTerminalText(value)
  return sanitized === '' ? '?' : sanitized
}

function percentage(value: number | 'unknown'): string {
  return value === 'unknown' ? '?' : `${(value * 100).toFixed(1)}%`
}

/** Render the exact snapshot contract consumed by Web as one terminal-safe first line. */
export function renderCliHeader(
  snapshot: TelemetrySnapshot,
  advisory: TelemetryAdvisory,
  keepalive?: HudKeepaliveStatus,
): string {
  const level = sanitizeTerminalText(advisory.level)
  const fields = [
    `Luban HUD [${level === '' ? 'UNKNOWN' : level.toUpperCase()}]`,
    `ctx ${integer(snapshot.context.used)}/${integer(snapshot.context.max)} (${percentage(snapshot.context.ratio)})`,
    `workspace ${text(snapshot.workspace.name)}`,
    `model ${text(snapshot.model.name)}`,
    `thinking ${text(snapshot.model.thinkingDepth)}`,
    `TPM ${integer(snapshot.rates.tpm1m)}/${integer(snapshot.rates.tpm5m)} (1m/5m)`,
    `RPM ${integer(snapshot.rates.rpm1m)}/${integer(snapshot.rates.rpm5m)} (1m/5m)`,
  ]
  if (keepalive !== undefined && !keepalive.healthy && keepalive.alerts.length > 0) {
    const sessionIds = keepalive.alerts
      .slice(0, 8)
      .map((alert): string => sanitizeTerminalText(alert.sessionId, 80))
      .filter((sessionId): boolean => sessionId !== '')
      .join(',')
    fields.push(
      `keepalive ${String(keepalive.alerts.length)} down${sessionIds === '' ? '' : `: ${sessionIds}`}`,
    )
  }
  return fields.join(' | ')
}
