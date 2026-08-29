import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'

interface UiJob {
  readonly id: string
  readonly templateId: string
  readonly status: 'queued' | 'running' | 'failed' | 'done'
  readonly version: number
  readonly errorLogExcerpt?: string
}

interface UiTemplate {
  readonly id: string
  readonly title: string
}

interface UiResource {
  readonly diskFreeGb: number
  readonly load1: number
  readonly queueDepth: number
  readonly paused: boolean
}

interface UiArtifact {
  readonly name: string
  readonly sizeBytes: number
  readonly downloadUrl: string
}

let runtimeContext: ClientContext | undefined

const STYLE = `
.luban-server{display:grid;gap:12px;color:var(--color-text,#e5e7eb);max-width:1100px}
.luban-server__toolbar,.luban-server__form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.luban-server input,.luban-server select,.luban-server button{font:inherit;border:1px solid #475569;border-radius:6px;padding:7px 9px;background:#111827;color:inherit}
.luban-server button{cursor:pointer;background:#1d4ed8;border-color:#2563eb}.luban-server button:disabled{opacity:.55}
.luban-server__resource{display:flex;gap:16px;flex-wrap:wrap;padding:10px;background:#0f172a;border:1px solid #334155;border-radius:8px}
.luban-server__paused,.luban-server__error{color:#fca5a5;white-space:pre-wrap}.luban-server__ok{color:#86efac}
.luban-server__jobs{display:grid;gap:8px}.luban-server__job{padding:10px;background:#1e293b;border:1px solid #475569;border-radius:8px}
.luban-server__job header{display:flex;justify-content:space-between;gap:12px}.luban-server__meta{font-size:12px;color:#94a3b8;overflow-wrap:anywhere}
.luban-server__artifacts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.luban-server__artifacts a{color:#93c5fd}
@media(max-width:700px){.luban-server__form>*{flex:1 1 180px}.luban-server__job header{display:grid}}
`

function isJob(value: unknown): value is UiJob {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Readonly<Record<string, unknown>>
  return (
    typeof row.id === 'string' &&
    typeof row.templateId === 'string' &&
    (row.status === 'queued' ||
      row.status === 'running' ||
      row.status === 'failed' ||
      row.status === 'done') &&
    typeof row.version === 'number'
  )
}

function isTemplate(value: unknown): value is UiTemplate {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Readonly<Record<string, unknown>>
  return typeof row.id === 'string' && typeof row.title === 'string'
}

function parseRows<Value>(
  value: unknown,
  key: string,
  guard: (item: unknown) => item is Value,
): Value[] {
  if (typeof value !== 'object' || value === null)
    throw new Error('Server mode returned invalid JSON')
  const rows = (value as Readonly<Record<string, unknown>>)[key]
  if (!Array.isArray(rows) || !rows.every(guard))
    throw new Error(`Server mode returned invalid ${key}`)
  return rows
}

function parseResource(value: unknown): UiResource {
  if (typeof value !== 'object' || value === null) throw new Error('Resource report is invalid')
  const row = value as Readonly<Record<string, unknown>>
  if (
    typeof row.diskFreeGb !== 'number' ||
    typeof row.load1 !== 'number' ||
    typeof row.queueDepth !== 'number' ||
    typeof row.paused !== 'boolean'
  )
    throw new Error('Resource report is invalid')
  return {
    diskFreeGb: row.diskFreeGb,
    load1: row.load1,
    queueDepth: row.queueDepth,
    paused: row.paused,
  }
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

async function enqueue(templateId: string, workspace: string): Promise<void> {
  const response = await fetch('/luban-server-mode/jobs', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify({ templateId, params: { workspace } }),
  })
  if (!response.ok)
    throw new Error((await response.text()) || `Enqueue failed (${String(response.status)})`)
}

async function sendErrorToCurrentSession(job: UiJob): Promise<void> {
  const ctx = runtimeContext
  if (ctx === undefined) throw new Error('DSH client runtime is unavailable')
  const current = ctx.sessions.list.getSnapshot().current
  if (current === undefined) throw new Error('Open a DSH session first')
  const scoped = ctx.sessions.scope(current)
  const session = scoped === undefined ? undefined : ctx.sessions.sessionOf(scoped)
  if (session === undefined) throw new Error('Current DSH session is unavailable')
  const response = await fetch(`/luban-server-mode/jobs/${encodeURIComponent(job.id)}/error-log`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`Unable to read error excerpt (${String(response.status)})`)
  const body = (await response.json()) as unknown
  if (typeof body !== 'object' || body === null) throw new Error('Error excerpt is invalid')
  const excerpt = (body as Readonly<Record<string, unknown>>).excerpt
  if (typeof excerpt !== 'string' || excerpt === '')
    throw new Error('This build has no error excerpt')
  const result = await session.prompt(
    [
      {
        type: 'text',
        text: `Build ${job.id} (${job.templateId}) failed. Diagnose this log excerpt:\n\n${excerpt}`,
      },
    ],
    'queue',
  )
  if (!result.ok) throw new Error(result.error.message)
}

function ArtifactLinks({ job }: { readonly job: UiJob }): ReactNode {
  const [artifacts, setArtifacts] = useState<UiArtifact[]>([])
  useEffect(() => {
    if (job.status !== 'done') return
    void fetch(`/luban-server-mode/jobs/${encodeURIComponent(job.id)}/artifacts`, {
      headers: { accept: 'application/json' },
    })
      .then(async (response): Promise<void> => {
        if (!response.ok) throw new Error('Unable to load artifacts')
        const rows = parseRows(await response.json(), 'artifacts', (value): value is UiArtifact => {
          if (typeof value !== 'object' || value === null) return false
          const row = value as Readonly<Record<string, unknown>>
          return (
            typeof row.name === 'string' &&
            typeof row.sizeBytes === 'number' &&
            typeof row.downloadUrl === 'string'
          )
        })
        setArtifacts(rows)
      })
      .catch((): void => setArtifacts([]))
  }, [job.id, job.status])
  if (artifacts.length === 0) return null
  return (
    <div className="luban-server__artifacts">
      {artifacts.map((artifact) => (
        <a href={artifact.downloadUrl} key={artifact.name}>
          {artifact.name} ({Math.ceil(artifact.sizeBytes / 1024)} KiB)
        </a>
      ))}
    </div>
  )
}

export function ServerModeSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [jobs, setJobs] = useState<UiJob[]>([])
  const [templates, setTemplates] = useState<UiTemplate[]>([])
  const [resource, setResource] = useState<UiResource | null>(null)
  const [templateId, setTemplateId] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const [jobsResponse, templatesResponse, resourceResponse] = await Promise.all([
      fetch('/luban-server-mode/jobs', { headers: { accept: 'application/json' } }),
      fetch('/luban-server-mode/templates', { headers: { accept: 'application/json' } }),
      fetch('/luban-server-mode/resources', { headers: { accept: 'application/json' } }),
    ])
    if (!jobsResponse.ok || !templatesResponse.ok || !resourceResponse.ok) {
      throw new Error('Unable to load server mode')
    }
    const nextTemplates = parseRows(await templatesResponse.json(), 'templates', isTemplate)
    setJobs(parseRows(await jobsResponse.json(), 'jobs', isJob))
    setTemplates(nextTemplates)
    setTemplateId((current): string => (current !== '' ? current : (nextTemplates[0]?.id ?? '')))
    setResource(parseResource(await resourceResponse.json()))
  }, [])

  useEffect(() => {
    void refresh().catch((reason: unknown): void => {
      setError(reason instanceof Error ? reason.message : 'Unable to load server mode')
    })
    const events = new EventSource('/luban-server-mode/events')
    const update = (): void => {
      void refresh()
    }
    events.addEventListener('build', update)
    events.addEventListener('resource', update)
    events.addEventListener('baseline', update)
    events.onerror = (): void => setError('Live updates disconnected; the browser will retry')
    return (): void => events.close()
  }, [refresh])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await enqueue(templateId, workspace)
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to enqueue build')
    } finally {
      setBusy(false)
    }
  }

  const sendLog = async (job: UiJob): Promise<void> => {
    setError('')
    try {
      await sendErrorToCurrentSession(job)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to send build log')
    }
  }

  return (
    <section className="luban-server" aria-label="Luban server mode">
      <style>{STYLE}</style>
      <h2>Luban Server Mode</h2>
      {resource === null ? null : (
        <div className="luban-server__resource">
          <span>Disk free: {resource.diskFreeGb.toFixed(1)} GiB</span>
          <span>Load (1m): {resource.load1.toFixed(2)}</span>
          <span>Queued: {resource.queueDepth}</span>
          <strong className={resource.paused ? 'luban-server__paused' : 'luban-server__ok'}>
            {resource.paused ? 'Queue paused by guard' : 'Queue healthy'}
          </strong>
        </div>
      )}
      <form
        className="luban-server__form"
        onSubmit={(event): void => {
          void submit(event)
        }}
      >
        <select
          value={templateId}
          onChange={(event): void => setTemplateId(event.currentTarget.value)}
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.title}
            </option>
          ))}
        </select>
        <input
          required
          placeholder="Workspace path"
          value={workspace}
          onChange={(event): void => setWorkspace(event.currentTarget.value)}
        />
        <button disabled={busy || templateId === ''} type="submit">
          {busy ? 'Enqueueing…' : 'Enqueue build'}
        </button>
        <button
          type="button"
          onClick={(): void => {
            void refresh()
          }}
        >
          Refresh
        </button>
      </form>
      {error === '' ? null : (
        <div className="luban-server__error" role="alert">
          {error}
        </div>
      )}
      <div className="luban-server__jobs">
        {jobs.map((job) => (
          <article className="luban-server__job" key={job.id}>
            <header>
              <strong>{job.templateId}</strong>
              <span>{job.status}</span>
            </header>
            <div className="luban-server__meta">
              {job.id} · version {job.version}
            </div>
            {job.status === 'failed' ? (
              <button
                type="button"
                onClick={(): void => {
                  void sendLog(job)
                }}
              >
                Send error to current session
              </button>
            ) : null}
            <ArtifactLinks job={job} />
          </article>
        ))}
      </div>
    </section>
  )
}

export const inject = ['slots', 'sessions']

/** Add an Ubuntu build-operations page to DSH Settings. */
export function apply(ctx: ClientContext): void {
  runtimeContext = ctx
  ctx.effect(
    () => (): void => {
      if (runtimeContext === ctx) runtimeContext = undefined
    },
    'luban-server-mode: client context lifecycle',
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'luban-server-mode',
        order: 90,
        label: 'Server Mode',
      },
      ServerModeSection,
    ),
  )
}
