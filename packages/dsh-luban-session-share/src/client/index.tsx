import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { registerWorkbenchPage, type WorkbenchPageProps } from '@yin52133/dsh-luban-core/client'
import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

export interface UiSession {
  readonly id: string
  readonly host: string
  readonly ownerTaskId?: string
  readonly healthy: boolean
  readonly status: string
  readonly version: number
  readonly role: 'owner' | 'operator' | 'observer'
  readonly lockHolder?: { readonly id: string; readonly displayName?: string } | null
}

export interface UiTakeover {
  readonly id: string
  readonly sessionId: string
  readonly requestedBy: { readonly id: string; readonly displayName?: string }
  readonly sessionVersion: number
  readonly status: 'pending' | 'granted' | 'denied' | 'expired'
  readonly expiresAt: number
}

interface UiSessionEvent {
  readonly type: 'output' | 'status'
  readonly seq: number
  readonly text?: string
  readonly status?: string
  readonly at: number
}

const STYLE = `
.luban-share{display:grid;gap:12px;color:var(--color-text,#e5e7eb);min-width:0}
.luban-share__grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(320px,2fr);gap:12px}
.luban-share__list,.luban-share__detail{display:grid;gap:8px;align-content:start}.luban-share__card{border:1px solid #334155;background:#0f172a;border-radius:8px;padding:10px;text-align:left;color:inherit}
.luban-share button,.luban-share input{font:inherit;border:1px solid #475569;border-radius:6px;padding:8px;background:#111827;color:inherit}.luban-share button{cursor:pointer;background:#1d4ed8;border-color:#2563eb}.luban-share button:disabled{opacity:.55;cursor:not-allowed}
.luban-share__meta{font-size:12px;color:#94a3b8;overflow-wrap:anywhere}.luban-share__healthy{color:#86efac}.luban-share__unhealthy,.luban-share__error{color:#fca5a5}.luban-share__log{margin:0;min-height:220px;max-height:420px;overflow:auto;white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:8px;padding:10px;font:12px/1.45 ui-monospace,monospace}
.luban-share__actions,.luban-share__input{display:flex;gap:8px;flex-wrap:wrap}.luban-share__input input{flex:1 1 240px}.luban-share__takeover{border-left:3px solid #f59e0b;padding-left:9px}.luban-share__empty{color:#64748b;font-size:12px}
@media(max-width:760px){.luban-share__grid{grid-template-columns:1fr}.luban-share__actions>*{flex:1 1 120px}}
`

function row(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Session Share returned invalid ${label}`)
  }
  return value as Readonly<Record<string, unknown>>
}

function sessionFrom(value: unknown): UiSession {
  const valueRow = row(value, 'session')
  if (
    typeof valueRow.id !== 'string' ||
    typeof valueRow.host !== 'string' ||
    typeof valueRow.healthy !== 'boolean' ||
    typeof valueRow.status !== 'string' ||
    typeof valueRow.version !== 'number' ||
    (valueRow.role !== 'owner' && valueRow.role !== 'operator' && valueRow.role !== 'observer')
  ) {
    throw new Error('Session Share returned an invalid session')
  }
  return valueRow as unknown as UiSession
}

function takeoverFrom(value: unknown): UiTakeover {
  const valueRow = row(value, 'takeover')
  if (
    typeof valueRow.id !== 'string' ||
    typeof valueRow.sessionId !== 'string' ||
    typeof valueRow.sessionVersion !== 'number' ||
    typeof valueRow.expiresAt !== 'number' ||
    typeof valueRow.requestedBy !== 'object' ||
    valueRow.requestedBy === null ||
    (valueRow.status !== 'pending' &&
      valueRow.status !== 'granted' &&
      valueRow.status !== 'denied' &&
      valueRow.status !== 'expired')
  ) {
    throw new Error('Session Share returned an invalid takeover')
  }
  return valueRow as unknown as UiTakeover
}

function sessionEventFrom(value: unknown): UiSessionEvent {
  const valueRow = row(value, 'session event')
  if (
    (valueRow.type !== 'output' && valueRow.type !== 'status') ||
    typeof valueRow.seq !== 'number' ||
    typeof valueRow.at !== 'number'
  ) {
    throw new Error('Session Share returned an invalid session event')
  }
  return valueRow as unknown as UiSessionEvent
}

async function csrfHeaders(): Promise<Record<string, string>> {
  try {
    const response = await fetch('/luban-auth/session', { headers: { accept: 'application/json' } })
    if (!response.ok) return {}
    const value = (await response.json()) as unknown
    if (typeof value !== 'object' || value === null) return {}
    const token = (value as Readonly<Record<string, unknown>>).csrfToken
    return typeof token === 'string' && token !== '' ? { 'x-luban-csrf': token } : {}
  } catch {
    return {}
  }
}

async function writeApi(path: string, body: unknown): Promise<void> {
  const response = await fetch(`/luban-session-share${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(
      detail === '' ? `Session Share request failed (${String(response.status)})` : detail,
    )
  }
}

export async function approveTakeover(
  id: string,
  expectedVersion: number,
  decision: 'approve' | 'deny',
): Promise<void> {
  await writeApi(`/takeovers/${encodeURIComponent(id)}/decision`, { decision, expectedVersion })
}

export async function injectSessionInput(id: string, text: string): Promise<void> {
  await writeApi(`/sessions/${encodeURIComponent(id)}/input`, { text })
}

function eventLine(event: UiSessionEvent): string {
  if (event.type === 'output') return event.text ?? ''
  return `\n[${new Date(event.at).toLocaleTimeString()}] ${event.status ?? 'status changed'}\n`
}

export function SessionShareSection(_props: WorkbenchPageProps): ReactNode {
  const [sessions, setSessions] = useState<UiSession[]>([])
  const [takeovers, setTakeovers] = useState<UiTakeover[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [events, setEvents] = useState<UiSessionEvent[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const [sessionResponse, takeoverResponse] = await Promise.all([
      fetch('/luban-session-share/sessions', { headers: { accept: 'application/json' } }),
      fetch('/luban-session-share/takeovers', { headers: { accept: 'application/json' } }),
    ])
    if (!sessionResponse.ok || !takeoverResponse.ok) {
      throw new Error('Unable to load shared sessions')
    }
    const sessionBody = row(await sessionResponse.json(), 'session list')
    const takeoverBody = row(await takeoverResponse.json(), 'takeover list')
    if (!Array.isArray(sessionBody.sessions) || !Array.isArray(takeoverBody.requests)) {
      throw new Error('Session Share returned an invalid list')
    }
    const nextSessions = sessionBody.sessions.map(sessionFrom)
    setSessions(nextSessions)
    setTakeovers(takeoverBody.requests.map(takeoverFrom))
    setSelectedId((current): string =>
      nextSessions.some((session): boolean => session.id === current)
        ? current
        : (nextSessions[0]?.id ?? ''),
    )
  }, [])

  useEffect(() => {
    void refresh().catch((reason: unknown): void =>
      setError(reason instanceof Error ? reason.message : 'Unable to load shared sessions'),
    )
    const stream = new EventSource('/luban-session-share/events')
    const update = (): void => {
      void refresh().catch((reason: unknown): void =>
        setError(reason instanceof Error ? reason.message : 'Unable to refresh shared sessions'),
      )
    }
    stream.addEventListener('baseline', update)
    stream.addEventListener('registry', update)
    stream.onerror = (): void => setError('Registry updates disconnected; retrying automatically')
    return (): void => stream.close()
  }, [refresh])

  useEffect(() => {
    setEvents([])
    if (selectedId === '') return undefined
    const stream = new EventSource(
      `/luban-session-share/sessions/${encodeURIComponent(selectedId)}/events`,
    )
    const baseline = (event: MessageEvent<string>): void => {
      try {
        const body = row(JSON.parse(event.data) as unknown, 'session baseline')
        if (!Array.isArray(body.recent)) throw new Error('Session baseline is invalid')
        setEvents(body.recent.map(sessionEventFrom).slice(-500))
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : 'Session baseline is invalid')
      }
    }
    const append = (event: MessageEvent<string>): void => {
      try {
        const next = sessionEventFrom(JSON.parse(event.data) as unknown)
        setEvents((current): UiSessionEvent[] => [...current.slice(-499), next])
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : 'Session event is invalid')
      }
    }
    stream.addEventListener('baseline', baseline as EventListener)
    stream.addEventListener('session', append as EventListener)
    stream.onerror = (): void => setError('Session output disconnected; retrying automatically')
    return (): void => stream.close()
  }, [selectedId])

  const selected = useMemo(
    (): UiSession | undefined => sessions.find((session): boolean => session.id === selectedId),
    [selectedId, sessions],
  )
  const pending = takeovers.filter((request): boolean => request.status === 'pending')

  const mutate = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await operation()
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Session Share request failed')
    } finally {
      setBusy(false)
    }
  }

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (selected === undefined || input.trim() === '') return
    await mutate(async (): Promise<void> => {
      await injectSessionInput(selected.id, input)
      setInput('')
    })
  }

  return (
    <section className="luban-share" aria-label="Luban shared sessions">
      <style>{STYLE}</style>
      <h2>Luban Session Share</h2>
      {error === '' ? null : (
        <div className="luban-share__error" role="alert">
          {error}
        </div>
      )}
      {pending.map((request) => (
        <div className="luban-share__takeover" key={request.id}>
          <strong>{request.requestedBy.displayName ?? request.requestedBy.id}</strong> requests{' '}
          {request.sessionId} until {new Date(request.expiresAt).toLocaleTimeString()}.
          <div className="luban-share__actions">
            <button
              type="button"
              disabled={busy}
              onClick={(): void => {
                void mutate(() => approveTakeover(request.id, request.sessionVersion, 'approve'))
              }}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(): void => {
                void mutate(() => approveTakeover(request.id, request.sessionVersion, 'deny'))
              }}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
      <div className="luban-share__grid">
        <div className="luban-share__list">
          {sessions.length === 0 ? (
            <div className="luban-share__empty">No live local or peer sessions.</div>
          ) : (
            sessions.map((session) => (
              <button
                className="luban-share__card"
                type="button"
                key={`${session.host}/${session.id}`}
                onClick={(): void => setSelectedId(session.id)}
              >
                <strong>{session.id}</strong>
                <div className="luban-share__meta">
                  {session.host} · {session.role} · v{session.version}
                </div>
                <div
                  className={session.healthy ? 'luban-share__healthy' : 'luban-share__unhealthy'}
                >
                  {session.healthy ? session.status : `Unhealthy · ${session.status}`}
                </div>
              </button>
            ))
          )}
        </div>
        <div className="luban-share__detail">
          {selected === undefined ? (
            <div className="luban-share__empty">Select a session.</div>
          ) : (
            <>
              <h3>
                {selected.host} / {selected.id}
              </h3>
              <div className="luban-share__meta">
                Lock: {selected.lockHolder?.displayName ?? selected.lockHolder?.id ?? 'none'} ·
                Role: {selected.role}
                {selected.ownerTaskId === undefined ? '' : ` · Task ${selected.ownerTaskId}`}
              </div>
              <pre className="luban-share__log">{events.map(eventLine).join('')}</pre>
              <div className="luban-share__actions">
                {selected.role === 'observer' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(): void => {
                      void mutate(() =>
                        writeApi(`/sessions/${encodeURIComponent(selected.id)}/takeover`, {}),
                      )
                    }}
                  >
                    Request control
                  </button>
                ) : null}
                {selected.role === 'operator' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(): void => {
                      void mutate(() =>
                        writeApi(`/sessions/${encodeURIComponent(selected.id)}/release`, {}),
                      )
                    }}
                  >
                    Release control
                  </button>
                ) : null}
              </div>
              <form
                className="luban-share__input"
                onSubmit={(event): void => {
                  void submitInput(event)
                }}
              >
                <input
                  aria-label="Session input"
                  maxLength={65_536}
                  disabled={selected.role === 'observer' || busy}
                  placeholder={
                    selected.role === 'observer'
                      ? 'Request control to send input'
                      : 'Send follow-up'
                  }
                  value={input}
                  onChange={(event): void => setInput(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  disabled={selected.role === 'observer' || busy || input.trim() === ''}
                >
                  Send
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

export const inject = ['slots']

/** Contribute a responsive shared-session observer and takeover page to the Luban workbench. */
export function apply(ctx: ClientContext): void {
  registerWorkbenchPage(ctx, {
    id: 'luban-session-share',
    title: '会话共享',
    group: '协作',
    order: 40,
    description: '观察共享会话、查看接管申请与控制权限。',
    component: SessionShareSection,
  })
}
