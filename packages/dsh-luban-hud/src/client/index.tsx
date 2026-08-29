import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { HudDisplayField } from '../config.js'
import { HUD_TELEMETRY_EVENT } from '../types.js'
import type { HudSnapshotResponse } from '../types.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

const STYLE = `
.luban-hud{position:fixed;right:14px;bottom:12px;z-index:80;pointer-events:auto;max-width:min(94vw,920px);font:12px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;color:#e2e8f0}
.luban-hud__bar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:7px 10px;border:1px solid #475569;border-radius:8px;background:rgba(15,23,42,.96);box-shadow:0 7px 22px rgba(0,0,0,.35);cursor:pointer;color:inherit;font:inherit;text-align:left}
.luban-hud__bar:hover{border-color:#94a3b8}.luban-hud__level{width:8px;height:8px;border-radius:50%;background:#64748b;flex:none}.luban-hud--normal .luban-hud__level{background:#22c55e}.luban-hud--warn .luban-hud__level{background:#eab308}.luban-hud--danger .luban-hud__level{background:#f97316}.luban-hud--critical .luban-hud__level{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.22)}
.luban-hud__item{white-space:nowrap}.luban-hud__label{color:#94a3b8}.luban-hud__error,.luban-hud__health{color:#fca5a5}.luban-hud__hint{color:#fde68a}.luban-hud__toggle{color:#64748b;margin-left:2px}
@media(max-width:680px){.luban-hud{left:8px;right:8px;bottom:8px}.luban-hud__bar{gap:7px}.luban-hud__item--secondary{display:none}}
`

function validEnvelope(value: unknown): value is HudSnapshotResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Readonly<Record<string, unknown>>
  return (
    typeof record.snapshot === 'object' &&
    record.snapshot !== null &&
    typeof record.advisory === 'object' &&
    record.advisory !== null &&
    typeof record.config === 'object' &&
    record.config !== null
  )
}

function number(value: number | 'unknown'): string {
  return value === 'unknown' ? '?' : Math.round(value).toLocaleString('en-US')
}

function percent(value: number | 'unknown'): string {
  return value === 'unknown' ? '?' : `${String(Math.round(value * 100))}%`
}

function text(value: string): string {
  return value === 'unknown' ? '?' : value
}

function has(fields: ReadonlySet<HudDisplayField>, field: HudDisplayField): boolean {
  return fields.has(field)
}

export interface KeepaliveIndicator {
  readonly count: number
  readonly label: string
  readonly title: string
}

interface PublicKeepaliveAlert {
  readonly sessionId: string
  readonly detail?: string
}

function publicClientText(value: string, maximumLength: number): string {
  return value
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximumLength)
}

function publicKeepaliveAlert(input: unknown): PublicKeepaliveAlert | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Readonly<Record<string, unknown>>
  if (typeof record.sessionId !== 'string') return null
  const sessionId = publicClientText(record.sessionId, 160)
  if (sessionId === '' || (record.detail !== undefined && typeof record.detail !== 'string')) {
    return null
  }
  const detail =
    typeof record.detail === 'string' ? publicClientText(record.detail, 256) : undefined
  return {
    sessionId,
    ...(detail === undefined || detail === '' ? {} : { detail }),
  }
}

/** Reduce the optional M03 response field to bounded text consumed by the Web status bar. */
export function keepaliveIndicator(input: unknown): KeepaliveIndicator | null {
  if (typeof input !== 'object' || input === null) return null
  const value = input as Readonly<Record<string, unknown>>
  if (value.healthy !== false || !Array.isArray(value.alerts)) return null
  const alerts = value.alerts
    .slice(0, 8)
    .map(publicKeepaliveAlert)
    .filter((alert): alert is PublicKeepaliveAlert => alert !== null)
  if (alerts.length === 0) return null
  return {
    count: value.alerts.length,
    label: `keepalive ${String(value.alerts.length)} down`,
    title: alerts
      .map((alert): string =>
        alert.detail === undefined ? alert.sessionId : `${alert.sessionId}: ${alert.detail}`,
      )
      .join('; ')
      .slice(0, 512),
  }
}

/** Persistent rc2 shell overlay; closing the SSE while hidden prevents browser timer leaks. */
export function HudStatusBar(): ReactNode {
  const [envelope, setEnvelope] = useState<HudSnapshotResponse>()
  const [error, setError] = useState('')
  const [compactOverride, setCompactOverride] = useState<boolean>()

  useEffect((): (() => void) => {
    let active = true
    let stream: EventSource | undefined

    const accept = (value: unknown): void => {
      if (!active || !validEnvelope(value)) return
      setEnvelope(value)
      setError('')
    }
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch('/luban-hud/snapshot', {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`HUD request failed (${String(response.status)})`)
        accept((await response.json()) as unknown)
      } catch (reason: unknown) {
        if (active) setError(reason instanceof Error ? reason.message : 'HUD is unavailable')
      }
    }
    const close = (): void => {
      stream?.close()
      stream = undefined
    }
    const open = (): void => {
      close()
      if (!active || document.hidden) return
      stream = new EventSource('/luban-hud/events')
      const update = (event: MessageEvent<string>): void => {
        try {
          accept(JSON.parse(event.data) as unknown)
        } catch {
          if (active) setError('HUD stream returned invalid JSON')
        }
      }
      stream.addEventListener(HUD_TELEMETRY_EVENT, update as EventListener)
      stream.onerror = (): void => {
        if (active) setError('HUD stream reconnecting')
      }
    }
    const visible = (): void => {
      if (document.hidden) close()
      else {
        void refresh()
        open()
      }
    }
    document.addEventListener('visibilitychange', visible)
    void refresh()
    open()
    return (): void => {
      active = false
      document.removeEventListener('visibilitychange', visible)
      close()
    }
  }, [])

  const fields = useMemo(
    (): ReadonlySet<HudDisplayField> => new Set(envelope?.config.display.fields ?? ['context']),
    [envelope],
  )
  if (envelope === undefined) {
    return (
      <aside className="luban-hud luban-hud--unknown" aria-live="polite">
        <style>{STYLE}</style>
        <div className="luban-hud__bar">
          <span className="luban-hud__level" />
          <span>{error === '' ? 'Luban HUD loading…' : error}</span>
        </div>
      </aside>
    )
  }

  const { snapshot, advisory } = envelope
  const keepalive = keepaliveIndicator(envelope.keepalive)
  const compact = compactOverride ?? envelope.config.display.compact
  const title = `${advisory.message}${keepalive === null ? '' : `; ${keepalive.title}`}; click to ${compact ? 'expand' : 'compact'}`
  return (
    <aside
      className={`luban-hud luban-hud--${advisory.level}`}
      aria-live="polite"
      data-level={advisory.level}
      data-keepalive={keepalive === null ? 'healthy' : 'unhealthy'}
    >
      <style>{STYLE}</style>
      <button
        className="luban-hud__bar"
        type="button"
        title={title}
        onClick={(): void => setCompactOverride(!compact)}
      >
        <span className="luban-hud__level" aria-label={advisory.level} />
        {has(fields, 'context') ? (
          <span className="luban-hud__item">
            <span className="luban-hud__label">ctx </span>
            {number(snapshot.context.used)}/{number(snapshot.context.max)} ·{' '}
            {percent(snapshot.context.ratio)}
          </span>
        ) : null}
        {!compact && has(fields, 'workspace') ? (
          <span className="luban-hud__item">
            <span className="luban-hud__label">ws </span>
            {text(snapshot.workspace.name)}
          </span>
        ) : null}
        {!compact && has(fields, 'model') ? (
          <span className="luban-hud__item">
            <span className="luban-hud__label">model </span>
            {text(snapshot.model.name)}
          </span>
        ) : null}
        {!compact && has(fields, 'thinking') ? (
          <span className="luban-hud__item luban-hud__item--secondary">
            <span className="luban-hud__label">think </span>
            {text(snapshot.model.thinkingDepth)}
          </span>
        ) : null}
        {!compact && has(fields, 'tpm') ? (
          <span className="luban-hud__item luban-hud__item--secondary">
            <span className="luban-hud__label">TPM </span>
            {number(snapshot.rates.tpm1m)}/{number(snapshot.rates.tpm5m)}
          </span>
        ) : null}
        {!compact && has(fields, 'rpm') ? (
          <span className="luban-hud__item luban-hud__item--secondary">
            <span className="luban-hud__label">RPM </span>
            {number(snapshot.rates.rpm1m)}/{number(snapshot.rates.rpm5m)}
          </span>
        ) : null}
        {advisory.compactionSuggested ? (
          <span className="luban-hud__hint">compact recommended</span>
        ) : null}
        {keepalive === null ? null : (
          <span className="luban-hud__health" title={keepalive.title} role="alert">
            {keepalive.label}
          </span>
        )}
        {envelope.failures.length > 0 || error !== '' ? (
          <span className="luban-hud__error" title={error || envelope.failures[0]?.message}>
            partial
          </span>
        ) : null}
        <span className="luban-hud__toggle">{compact ? '＋' : '－'}</span>
      </button>
    </aside>
  )
}

export const inject = ['slots']

/** Contribute one ordered status bar to the rc2 frame-wide shell overlay. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'luban-hud',
        order: 90,
        label: 'Luban HUD',
      },
      HudStatusBar,
    ),
  )
}
