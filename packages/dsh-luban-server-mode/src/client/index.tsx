import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  csrfHeaders,
  statusLabel,
  registerWorkbenchPage,
  type WorkbenchPageProps,
} from '@yin52133/dsh-luban-core/client'
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

type SessionPromptResult =
  { readonly ok: true } | { readonly ok: false; readonly error: { readonly message: string } }

interface SessionPromptFace {
  prompt(
    content: readonly [{ readonly type: 'text'; readonly text: string }],
    mode: 'queue',
  ): Promise<SessionPromptResult>
}

interface SessionControllerFace {
  readonly list: { getSnapshot(): { readonly current: string | undefined } }
  scope(id: string): ClientContext | undefined
  sessionOf(ctx: ClientContext): SessionPromptFace | undefined
}

type ServerClientContext = ClientContext & { readonly sessions: SessionControllerFace }

const STYLE = `
.luban-server{display:grid;gap:12px;color:var(--lb-text,#172033);max-width:1100px}
.luban-server__toolbar,.luban-server__form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.luban-server input,.luban-server select,.luban-server button{font:inherit;border:1px solid var(--lb-border,#cbd5e1);border-radius:6px;padding:7px 9px;background:var(--lb-panel,#fff);color:inherit}
.luban-server button{cursor:pointer;background:#1d4ed8;color:#fff;border-color:#2563eb}.luban-server button:disabled{opacity:.55}
.luban-server__resource{display:flex;gap:16px;flex-wrap:wrap;padding:10px;background:var(--lb-bg,#f8fafc);border:1px solid var(--lb-border,#cbd5e1);border-radius:8px}
.luban-server__paused,.luban-server__error{color:var(--lb-error,#b91c1c);white-space:pre-wrap}.luban-server__ok{color:var(--lb-success,#166534)}
.luban-server__jobs{display:grid;gap:8px}.luban-server__job{padding:10px;background:var(--lb-panel,#fff);border:1px solid var(--lb-border,#cbd5e1);border-radius:8px}
.luban-server__job header{display:flex;justify-content:space-between;gap:12px}.luban-server__meta{font-size:12px;color:var(--lb-muted,#526177);overflow-wrap:anywhere}
.luban-server__artifacts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.luban-server__artifacts a{color:var(--lb-link,#1d4ed8)}
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

/** Fetch a bounded server-side excerpt and queue it in the active DSH session. */
export async function sendErrorToCurrentSession(
  job: UiJob,
  ctx: ServerClientContext,
): Promise<void> {
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

export function ArtifactLinks({ job }: { readonly job: UiJob }): ReactNode {
  const [artifacts, setArtifacts] = useState<UiArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (job.status !== 'done') return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setArtifacts([])
    void fetch(`/luban-server-mode/jobs/${encodeURIComponent(job.id)}/artifacts`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response): Promise<void> => {
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? '登录已过期，请重新登录后重试。'
              : `无法加载构建产物（HTTP ${String(response.status)}），请重试。`,
          )
        const rows = parseRows(await response.json(), 'artifacts', (value): value is UiArtifact => {
          if (typeof value !== 'object' || value === null) return false
          const row = value as Readonly<Record<string, unknown>>
          return (
            typeof row.name === 'string' &&
            typeof row.sizeBytes === 'number' &&
            typeof row.downloadUrl === 'string' &&
            row.downloadUrl.startsWith('/luban-server-mode/jobs/')
          )
        })
        if (!controller.signal.aborted) setArtifacts(rows)
      })
      .catch((reason: unknown): void => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : '无法加载构建产物，请重试。')
      })
      .finally((): void => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return (): void => controller.abort()
  }, [job.id, job.status, attempt])
  if (job.status !== 'done') return null
  if (loading) return <p role="status">正在加载构建产物…</p>
  if (error !== '')
    return (
      <div role="alert" className="luban-server__error">
        <p>{error}</p>
        <button type="button" onClick={(): void => setAttempt((value) => value + 1)}>
          重试加载产物
        </button>
      </div>
    )
  if (artifacts.length === 0) return <p className="luban-server__meta">此构建没有可下载的产物。</p>
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

export function ServerModeSection({
  sendError,
}: WorkbenchPageProps & {
  readonly sendError?: (job: UiJob) => Promise<void>
}): ReactNode {
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
      if (
        [jobsResponse, templatesResponse, resourceResponse].some(
          (response) => response.status === 404,
        )
      ) {
        throw new Error(
          'Server Mode is unavailable on this host. Open the Luban page on an Ubuntu host with Server Mode enabled.',
        )
      }
      throw new Error('Unable to load server mode')
    }
    const nextTemplates = parseRows(await templatesResponse.json(), 'templates', isTemplate)
    setJobs(parseRows(await jobsResponse.json(), 'jobs', isJob))
    setTemplates(nextTemplates)
    setTemplateId((current): string => (current !== '' ? current : (nextTemplates[0]?.id ?? '')))
    setResource(parseResource(await resourceResponse.json()))
    setError('')
  }, [])

  useEffect(() => {
    let active = true
    let events: EventSource | undefined
    const report = (reason: unknown): void => {
      if (active) setError(reason instanceof Error ? reason.message : 'Unable to load server mode')
    }
    const update = (): void => {
      void refresh().catch(report)
    }
    void refresh()
      .then((): void => {
        if (!active) return
        events = new EventSource('/luban-server-mode/events')
        events.addEventListener('build', update)
        events.addEventListener('resource', update)
        events.addEventListener('baseline', update)
        events.onerror = (): void => setError('Live updates disconnected; the browser will retry')
      })
      .catch(report)
    return (): void => {
      active = false
      events?.close()
    }
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
      if (sendError === undefined) throw new Error('无法连接当前对话，请重新打开构建管理页面。')
      await sendError(job)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to send build log')
    }
  }

  return (
    <section className="luban-server" aria-label="Luban server mode">
      <style>{STYLE}</style>
      <p>在 Ubuntu 主机排队执行构建。可用模板与允许访问的工作区由服务器管理员配置。</p>
      {resource === null ? null : (
        <div className="luban-server__resource">
          <span>剩余磁盘：{resource.diskFreeGb.toFixed(1)} GiB</span>
          <span>系统负载（1 分钟）：{resource.load1.toFixed(2)}</span>
          <span>排队任务：{resource.queueDepth}</span>
          <strong className={resource.paused ? 'luban-server__paused' : 'luban-server__ok'}>
            {resource.paused ? '资源保护已暂停队列' : '队列运行正常'}
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
          aria-label="构建模板"
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
          placeholder="服务器工作区路径"
          value={workspace}
          onChange={(event): void => setWorkspace(event.currentTarget.value)}
        />
        <button disabled={busy || templateId === ''} type="submit">
          {busy ? '提交中…' : '加入构建队列'}
        </button>
        <button
          type="button"
          onClick={(): void => {
            void refresh().catch((reason: unknown): void =>
              setError(reason instanceof Error ? reason.message : 'Unable to load server mode'),
            )
          }}
        >
          刷新
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
              <span>{statusLabel(job.status)}</span>
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
                将错误发送到当前对话
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

/** Add an Ubuntu build-operations page to the Luban workbench. */
export function apply(ctx: ClientContext): void {
  const runtime = ctx as ServerClientContext
  registerWorkbenchPage(ctx, {
    id: 'luban-server-mode',
    title: '构建管理',
    group: '工作',
    order: 30,
    description: '在 Ubuntu 服务器排队构建，查看状态与下载产物。',
    component: (props): ReactNode => (
      <ServerModeSection
        {...props}
        sendError={(job): Promise<void> => sendErrorToCurrentSession(job, runtime)}
      />
    ),
  })
}
