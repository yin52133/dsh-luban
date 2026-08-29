import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DragEvent, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

type TaskStatus = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'dropped'

export interface UiTask {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly hostScope: 'win' | 'ubuntu' | 'any'
  readonly workspace?: string
  readonly priority: 'P0' | 'P1' | 'P2' | 'P3'
  readonly acceptance?: string
  readonly tags: readonly string[]
  readonly version: number
  readonly autoDone?: boolean
}

export interface UiTaskPlanLink {
  readonly id: string
  readonly taskId: string
  readonly status: string
  readonly filePath: string
}

const COLUMNS: readonly { readonly status: TaskStatus; readonly title: string }[] = [
  { status: 'backlog', title: 'Backlog' },
  { status: 'todo', title: 'Todo' },
  { status: 'doing', title: 'Doing' },
  { status: 'review', title: 'Review' },
  { status: 'done', title: 'Done' },
  { status: 'dropped', title: 'Dropped' },
]

const STYLE = `
.luban-board{display:grid;gap:12px;color:var(--color-text,#e5e7eb);min-width:0}
.luban-board__toolbar,.luban-board__form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.luban-board input,.luban-board select,.luban-board button{font:inherit;border:1px solid #475569;border-radius:6px;padding:7px 9px;background:#111827;color:inherit}
.luban-board button{cursor:pointer;background:#1d4ed8;border-color:#2563eb}.luban-board button:disabled{opacity:.55;cursor:not-allowed}
.luban-board__columns{display:grid;grid-template-columns:repeat(6,minmax(220px,1fr));gap:10px;overflow-x:auto;padding-bottom:8px}
.luban-board__column{background:#0f172a;border:1px solid #334155;border-radius:8px;min-height:220px;padding:8px}
.luban-board__column h3{font-size:13px;margin:2px 4px 8px;color:#cbd5e1;display:flex;justify-content:space-between}
.luban-board__card{background:#1e293b;border:1px solid #475569;border-radius:7px;padding:9px;margin-bottom:8px;cursor:grab}
.luban-board__card strong{display:block;font-size:13px}.luban-board__meta{font-size:11px;color:#94a3b8;margin-top:6px;overflow-wrap:anywhere}.luban-board__plans{display:flex;gap:6px;flex-wrap:wrap}.luban-board__plans a{color:#93c5fd}
.luban-board__tag{display:inline-block;background:#334155;border-radius:999px;padding:1px 6px;margin:4px 4px 0 0;font-size:10px}
.luban-board__auto{color:#fde68a}.luban-board__error{color:#fca5a5;white-space:pre-wrap}.luban-board__empty{color:#64748b;font-size:12px;padding:8px}
@media(max-width:760px){.luban-board__columns{grid-template-columns:repeat(6,minmax(82vw,1fr))}.luban-board__toolbar>*{flex:1 1 140px}}
`

function isTask(value: unknown): value is UiTask {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Readonly<Record<string, unknown>>
  return (
    typeof row.id === 'string' &&
    typeof row.title === 'string' &&
    typeof row.description === 'string' &&
    typeof row.status === 'string' &&
    typeof row.version === 'number' &&
    Array.isArray(row.tags)
  )
}

function tasksFrom(value: unknown): UiTask[] {
  if (typeof value !== 'object' || value === null)
    throw new Error('Taskboard returned invalid JSON')
  const tasks = (value as Readonly<Record<string, unknown>>).tasks
  if (!Array.isArray(tasks) || !tasks.every(isTask))
    throw new Error('Taskboard returned invalid tasks')
  return tasks
}

/** Decode the existing Plan list contract into links grouped by the shared task id. */
export function taskPlanLinksFrom(value: unknown): ReadonlyMap<string, readonly UiTaskPlanLink[]> {
  if (typeof value !== 'object' || value === null) throw new Error('Plan API returned invalid JSON')
  const plans = (value as Readonly<Record<string, unknown>>).plans
  if (!Array.isArray(plans)) throw new Error('Plan API returned invalid plans')
  const grouped = new Map<string, UiTaskPlanLink[]>()
  for (const value of plans) {
    if (typeof value !== 'object' || value === null)
      throw new Error('Plan API returned an invalid plan')
    const row = value as Readonly<Record<string, unknown>>
    if (
      typeof row.id !== 'string' ||
      typeof row.taskId !== 'string' ||
      typeof row.status !== 'string' ||
      typeof row.filePath !== 'string'
    ) {
      if (row.taskId === undefined) continue
      throw new Error('Plan API returned an invalid task-linked plan')
    }
    const link: UiTaskPlanLink = {
      id: row.id,
      taskId: row.taskId,
      status: row.status,
      filePath: row.filePath,
    }
    grouped.set(row.taskId, [...(grouped.get(row.taskId) ?? []), link])
  }
  return grouped
}

/** Load optional Plan metadata without coupling the Taskboard package to Plan internals. */
export async function loadTaskPlanLinks(): Promise<ReadonlyMap<string, readonly UiTaskPlanLink[]>> {
  const response = await fetch('/luban-plan/plans', { headers: { accept: 'application/json' } })
  if (response.status === 404) return new Map()
  if (!response.ok) throw new Error(`Unable to load linked plans (${String(response.status)})`)
  return taskPlanLinksFrom(await response.json())
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

async function writeApi(path: string, method: string, body: unknown): Promise<void> {
  const response = await fetch(`/luban-taskboard${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(await csrfHeaders()),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text === '' ? `Taskboard request failed (${String(response.status)})` : text)
  }
}

/** Persist the status change used by drag-and-drop with optimistic locking. */
export async function moveTask(
  id: string,
  status: TaskStatus,
  expectedVersion: number,
): Promise<void> {
  await writeApi(`/tasks/${encodeURIComponent(id)}/transition`, 'POST', {
    to: status,
    expectedVersion,
  })
}

export function TaskPlanLinks({
  taskId,
  plans,
}: {
  readonly taskId: string
  readonly plans: readonly UiTaskPlanLink[]
}): ReactNode {
  if (plans.length === 0) return null
  return (
    <div className="luban-board__meta luban-board__plans" aria-label={`Plans for ${taskId}`}>
      {plans.map((plan) => (
        <a
          href={`/luban-plan/plans/${encodeURIComponent(plan.id)}/document`}
          key={plan.id}
          target="_blank"
          rel="noreferrer"
          title={plan.filePath}
        >
          Plan {plan.id} · {plan.status}
        </a>
      ))}
    </div>
  )
}

export function TaskCard({
  task,
  plans,
}: {
  readonly task: UiTask
  readonly plans: readonly UiTaskPlanLink[]
}): ReactNode {
  const onDragStart = (event: DragEvent<HTMLElement>): void => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(
      'application/x-luban-task',
      JSON.stringify({ id: task.id, version: task.version }),
    )
  }
  return (
    <article
      className="luban-board__card"
      draggable
      onDragStart={onDragStart}
      data-task-id={task.id}
    >
      <strong>{task.title}</strong>
      {task.description === '' ? null : <div className="luban-board__meta">{task.description}</div>}
      <div className="luban-board__meta">
        {task.priority} · {task.hostScope}
        {task.workspace === undefined ? '' : ` · ${task.workspace}`}
      </div>
      {task.acceptance === undefined ? null : (
        <div className="luban-board__meta">Acceptance: {task.acceptance}</div>
      )}
      {task.autoDone === true ? (
        <div className="luban-board__auto">Auto-completed · review required</div>
      ) : null}
      <TaskPlanLinks taskId={task.id} plans={plans} />
      <div>
        {task.tags.map((tag) => (
          <span className="luban-board__tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
    </article>
  )
}

export function TaskboardSection(_props: SettingsSectionOwnerProps): ReactNode {
  const [tasks, setTasks] = useState<UiTask[]>([])
  const [planLinks, setPlanLinks] = useState<ReadonlyMap<string, readonly UiTaskPlanLink[]>>(
    new Map(),
  )
  const [hostFilter, setHostFilter] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [title, setTitle] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch('/luban-taskboard/tasks', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Unable to load tasks (${String(response.status)})`)
    setTasks(tasksFrom(await response.json()))
    setPlanLinks(await loadTaskPlanLinks())
  }, [])

  useEffect(() => {
    void refresh().catch((reason: unknown): void => {
      setError(reason instanceof Error ? reason.message : 'Unable to load tasks')
    })
    const events = new EventSource('/luban-taskboard/events')
    const onBaseline = (event: MessageEvent<string>): void => {
      try {
        const value = JSON.parse(event.data) as unknown
        if (Array.isArray(value) && value.every(isTask)) setTasks(value)
      } catch {
        setError('Taskboard baseline event was invalid')
      }
    }
    const onTask = (): void => {
      void refresh().catch((reason: unknown): void => {
        setError(reason instanceof Error ? reason.message : 'Unable to refresh tasks')
      })
    }
    events.addEventListener('baseline', onBaseline as EventListener)
    events.addEventListener('task', onTask)
    events.onerror = (): void =>
      setError('Live updates disconnected; the browser will retry automatically')
    return (): void => events.close()
  }, [refresh])

  const filtered = useMemo(
    (): readonly UiTask[] =>
      tasks.filter(
        (task): boolean =>
          (hostFilter === '' || task.hostScope === 'any' || task.hostScope === hostFilter) &&
          (workspaceFilter === '' || (task.workspace?.includes(workspaceFilter) ?? false)) &&
          (tagFilter === '' || task.tags.some((tag): boolean => tag.includes(tagFilter))),
      ),
    [hostFilter, tagFilter, tasks, workspaceFilter],
  )

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await writeApi('/tasks', 'POST', {
        title,
        description: '',
        status: acceptance.trim() === '' ? 'backlog' : 'todo',
        hostScope: 'any',
        priority: 'P2',
        ...(acceptance.trim() === '' ? {} : { acceptance }),
        tags: [],
      })
      setTitle('')
      setAcceptance('')
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to create task')
    } finally {
      setBusy(false)
    }
  }

  const drop = async (event: DragEvent<HTMLElement>, status: TaskStatus): Promise<void> => {
    event.preventDefault()
    setError('')
    try {
      const value = JSON.parse(event.dataTransfer.getData('application/x-luban-task')) as unknown
      if (typeof value !== 'object' || value === null) throw new Error('Invalid dragged task')
      const row = value as Readonly<Record<string, unknown>>
      const id = row.id
      const version = row.version
      if (typeof id !== 'string' || typeof version !== 'number')
        throw new Error('Invalid dragged task')
      await moveTask(id, status, version)
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to move task')
    }
  }

  return (
    <section className="luban-board" aria-label="Luban taskboard">
      <style>{STYLE}</style>
      <h2>Luban Taskboard</h2>
      <div className="luban-board__toolbar" aria-label="Task filters">
        <select
          value={hostFilter}
          onChange={(event): void => setHostFilter(event.currentTarget.value)}
        >
          <option value="">All hosts</option>
          <option value="win">Windows</option>
          <option value="ubuntu">Ubuntu</option>
        </select>
        <input
          aria-label="Workspace filter"
          placeholder="Workspace"
          value={workspaceFilter}
          onChange={(event): void => setWorkspaceFilter(event.currentTarget.value)}
        />
        <input
          aria-label="Tag filter"
          placeholder="Tag"
          value={tagFilter}
          onChange={(event): void => setTagFilter(event.currentTarget.value)}
        />
        <button
          type="button"
          onClick={(): void => {
            void refresh()
          }}
        >
          Refresh
        </button>
      </div>
      <form
        className="luban-board__form"
        onSubmit={(event): void => {
          void submit(event)
        }}
      >
        <input
          required
          maxLength={200}
          placeholder="New task"
          value={title}
          onChange={(event): void => setTitle(event.currentTarget.value)}
        />
        <input
          maxLength={10000}
          placeholder="Acceptance criteria (creates Todo)"
          value={acceptance}
          onChange={(event): void => setAcceptance(event.currentTarget.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error === '' ? null : (
        <div className="luban-board__error" role="alert">
          {error}
        </div>
      )}
      <div className="luban-board__columns">
        {COLUMNS.map(({ status, title: columnTitle }) => {
          const columnTasks = filtered.filter((task): boolean => task.status === status)
          return (
            <section
              className="luban-board__column"
              key={status}
              onDragOver={(event): void => event.preventDefault()}
              onDrop={(event): void => {
                void drop(event, status)
              }}
            >
              <h3>
                <span>{columnTitle}</span>
                <span>{columnTasks.length}</span>
              </h3>
              {columnTasks.length === 0 ? (
                <div className="luban-board__empty">Drop tasks here</div>
              ) : (
                columnTasks.map((task) => (
                  <TaskCard task={task} plans={planLinks.get(task.id) ?? []} key={task.id} />
                ))
              )}
            </section>
          )
        })}
      </div>
    </section>
  )
}

export const inject = ['slots']

/** Contribute a full responsive Taskboard page to DSH Settings. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'luban-taskboard',
        order: 40,
        label: 'Taskboard',
      },
      TaskboardSection,
    ),
  )
}
