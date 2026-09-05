import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  csrfHeaders,
  registerWorkbenchPage,
  type WorkbenchPageProps,
} from '@yin52133/dsh-luban-core/client'
import type { DragEvent, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'dropped'

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
  { status: 'backlog', title: '待整理' },
  { status: 'todo', title: '待办' },
  { status: 'doing', title: '进行中' },
  { status: 'review', title: '待验收' },
  { status: 'done', title: '已完成' },
  { status: 'dropped', title: '已取消' },
]

const TRANSITION_TARGETS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  backlog: ['todo', 'dropped'],
  todo: ['doing', 'dropped'],
  doing: ['review', 'todo'],
  review: ['done', 'doing'],
  done: [],
  dropped: [],
})

function isTaskStatus(value: string): value is TaskStatus {
  return COLUMNS.some((column): boolean => column.status === value)
}

const STYLE = `
.luban-board{display:grid;gap:12px;color:var(--lb-text,#172033);min-width:0}
.luban-board__form input{flex:1 1 240px}.luban-board__toolbar,.luban-board__form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.luban-board input,.luban-board select,.luban-board button{font:inherit;border:1px solid var(--lb-border,#cbd5e1);border-radius:6px;padding:7px 9px;background:var(--lb-panel,#fff);color:inherit}
.luban-board button{cursor:pointer;background:#1d4ed8;color:#fff;border-color:#2563eb}.luban-board button:disabled{opacity:.55;cursor:not-allowed}
.luban-board__columns{display:grid;grid-template-columns:repeat(6,minmax(220px,1fr));gap:10px;overflow-x:auto;padding-bottom:8px}
.luban-board__column{background:var(--lb-bg,#f8fafc);border:1px solid var(--lb-border,#cbd5e1);border-radius:8px;min-height:220px;padding:8px}
.luban-board__column h3{font-size:13px;margin:2px 4px 8px;color:var(--lb-muted,#526177);display:flex;justify-content:space-between}
.luban-board__card{background:var(--lb-panel,#fff);border:1px solid var(--lb-border,#cbd5e1);border-radius:7px;padding:9px;margin-bottom:8px;cursor:grab}
.luban-board__card strong{display:block;font-size:13px}.luban-board__meta{font-size:11px;color:var(--lb-muted,#526177);margin-top:6px;overflow-wrap:anywhere}.luban-board__plans{display:flex;gap:6px;flex-wrap:wrap}.luban-board__plans a{color:var(--lb-link,#1d4ed8)}
.luban-board__transition{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-top:8px}.luban-board__transition select,.luban-board__transition button{min-width:0;padding:5px 7px;font-size:12px}
.luban-board__tag{display:inline-block;background:var(--lb-border,#cbd5e1);border-radius:999px;padding:1px 6px;margin:4px 4px 0 0;font-size:10px}
.luban-board__auto{color:var(--lb-warning,#854d0e)}.luban-board__error{color:var(--lb-error,#b91c1c);white-space:pre-wrap}.luban-board__empty{color:var(--lb-muted,#526177);font-size:12px;padding:8px}
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
    isTaskStatus(row.status) &&
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

/** Persist the status change shared by drag, touch, and keyboard input. */
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

export interface TaskTransitionDependencies {
  readonly move: (id: string, status: TaskStatus, expectedVersion: number) => Promise<void>
  readonly refresh: () => Promise<void>
  readonly setBusyTaskId: (taskId: string | undefined) => void
  readonly reportError: (message: string) => void
  readonly lock: TaskTransitionLock
}

export interface TaskTransitionLock {
  current: boolean
}

/** Run one UI transition while keeping drag, touch, and keyboard behavior consistent. */
export async function performTaskTransition(
  task: Pick<UiTask, 'id' | 'status' | 'version'>,
  status: TaskStatus,
  dependencies: TaskTransitionDependencies,
): Promise<boolean> {
  if (dependencies.lock.current) return false
  if (!TRANSITION_TARGETS[task.status].includes(status)) {
    dependencies.reportError(
      task.status === status
        ? `Task ${task.id} is already in ${status}`
        : `Cannot move task from ${task.status} to ${status}`,
    )
    return false
  }
  dependencies.lock.current = true
  try {
    dependencies.setBusyTaskId(task.id)
    dependencies.reportError('')
    await dependencies.move(task.id, status, task.version)
    await dependencies.refresh()
    return true
  } catch (reason: unknown) {
    dependencies.reportError(reason instanceof Error ? reason.message : 'Unable to move task')
    return false
  } finally {
    dependencies.lock.current = false
    dependencies.setBusyTaskId(undefined)
  }
}

/** Resolve a drag gesture against the latest rendered task snapshot, not untrusted payload data. */
export function taskForDrop(tasks: readonly UiTask[], payload: string): UiTask {
  let value: unknown
  try {
    value = JSON.parse(payload) as unknown
  } catch {
    throw new Error('Invalid dragged task')
  }
  if (typeof value !== 'object' || value === null) throw new Error('Invalid dragged task')
  const row = value as Readonly<Record<string, unknown>>
  if (typeof row.id !== 'string' || typeof row.version !== 'number')
    throw new Error('Invalid dragged task')

  const task = tasks.find((candidate): boolean => candidate.id === row.id)
  if (task === undefined) throw new Error(`Task ${row.id} is no longer on this board`)
  if (row.version !== task.version)
    throw new Error(`Task ${task.id} changed since dragging; retry with the refreshed card`)
  return task
}

/** Validate a drop before entering the shared, synchronously locked mutation boundary. */
export async function performTaskDrop(
  tasks: readonly UiTask[],
  payload: string,
  target: TaskStatus,
  dependencies: TaskTransitionDependencies,
): Promise<boolean> {
  if (dependencies.lock.current) return false
  try {
    return await performTaskTransition(taskForDrop(tasks, payload), target, dependencies)
  } catch (reason: unknown) {
    dependencies.reportError(reason instanceof Error ? reason.message : 'Unable to move task')
    return false
  }
}

function transitionTargetFor(
  status: TaskStatus,
  preferred: TaskStatus | undefined,
): TaskStatus | undefined {
  const targets = TRANSITION_TARGETS[status]
  return preferred !== undefined && targets.includes(preferred) ? preferred : targets[0]
}

/** Native select/button controls remain operable without pointer drag gestures. */
export function TaskTransitionControl({
  task,
  target,
  busy,
  onTargetChange,
  onMove,
}: {
  readonly task: UiTask
  readonly target: TaskStatus | undefined
  readonly busy: boolean
  readonly onTargetChange: (status: TaskStatus) => void
  readonly onMove: (status: TaskStatus) => void
}): ReactNode {
  const targets = TRANSITION_TARGETS[task.status]
  if (target === undefined || targets.length === 0) return null
  return (
    <form
      className="luban-board__transition"
      aria-label={`Change status for ${task.title}`}
      onSubmit={(event): void => {
        event.preventDefault()
        onMove(target)
      }}
    >
      <select
        aria-label={`Target status for ${task.title}`}
        value={target}
        disabled={busy}
        onChange={(event): void => {
          const status = event.currentTarget.value
          if (isTaskStatus(status) && targets.includes(status)) onTargetChange(status)
        }}
      >
        {targets.map((status) => (
          <option value={status} key={status}>
            移至 {COLUMNS.find((column) => column.status === status)?.title ?? status}
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy}>
        {busy ? '移动中…' : '移动'}
      </button>
    </form>
  )
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
  transitionTarget,
  transitionBusy,
  onTransitionTargetChange,
  onTransition,
}: {
  readonly task: UiTask
  readonly plans: readonly UiTaskPlanLink[]
  readonly transitionTarget: TaskStatus | undefined
  readonly transitionBusy: boolean
  readonly onTransitionTargetChange: (status: TaskStatus) => void
  readonly onTransition: (status: TaskStatus) => void
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
      draggable={!transitionBusy}
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
        <div className="luban-board__meta">验收条件：{task.acceptance}</div>
      )}
      {task.autoDone === true ? (
        <div className="luban-board__auto">自动完成 · 请人工验收</div>
      ) : null}
      <TaskPlanLinks taskId={task.id} plans={plans} />
      <div>
        {task.tags.map((tag) => (
          <span className="luban-board__tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <TaskTransitionControl
        task={task}
        target={transitionTarget}
        busy={transitionBusy}
        onTargetChange={onTransitionTargetChange}
        onMove={onTransition}
      />
    </article>
  )
}

export function TaskboardSection(_props: WorkbenchPageProps): ReactNode {
  const [tasks, setTasks] = useState<UiTask[]>([])
  const [planLinks, setPlanLinks] = useState<ReadonlyMap<string, readonly UiTaskPlanLink[]>>(
    new Map(),
  )
  const [hostFilter, setHostFilter] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [title, setTitle] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | undefined>()
  const transitionLock = useRef(false)
  const [transitionTargets, setTransitionTargets] = useState<Readonly<Record<string, TaskStatus>>>(
    {},
  )
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch('/luban-taskboard/tasks', {
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`Unable to load tasks (${String(response.status)})`)
    setTasks(tasksFrom(await response.json()))
    setPlanLinks(await loadTaskPlanLinks())
    setError('')
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
    if (title.trim() === '') {
      setError('任务标题不能为空，请输入标题后重新提交。')
      return
    }
    setCreating(true)
    setError('')
    try {
      await writeApi('/tasks', 'POST', {
        title: title.trim(),
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
      setCreating(false)
    }
  }

  const transition = async (
    task: Pick<UiTask, 'id' | 'status' | 'version'>,
    status: TaskStatus,
  ): Promise<void> => {
    await performTaskTransition(task, status, {
      move: moveTask,
      refresh,
      setBusyTaskId,
      reportError: setError,
      lock: transitionLock,
    })
  }

  const drop = async (event: DragEvent<HTMLElement>, status: TaskStatus): Promise<void> => {
    event.preventDefault()
    await performTaskDrop(tasks, event.dataTransfer.getData('application/x-luban-task'), status, {
      move: moveTask,
      refresh,
      setBusyTaskId,
      reportError: setError,
      lock: transitionLock,
    })
  }

  return (
    <section className="luban-board" aria-label="Luban taskboard">
      <style>{STYLE}</style>
      <div className="luban-board__toolbar" aria-label="Task filters">
        <select
          value={hostFilter}
          onChange={(event): void => setHostFilter(event.currentTarget.value)}
        >
          <option value="">全部主机</option>
          <option value="win">Windows</option>
          <option value="ubuntu">Ubuntu</option>
        </select>
        <input
          aria-label="按工作区筛选"
          placeholder="工作区"
          value={workspaceFilter}
          onChange={(event): void => setWorkspaceFilter(event.currentTarget.value)}
        />
        <input
          aria-label="按标签筛选"
          placeholder="标签"
          value={tagFilter}
          onChange={(event): void => setTagFilter(event.currentTarget.value)}
        />
        <button
          type="button"
          onClick={(): void => {
            void refresh().catch((reason: unknown): void =>
              setError(reason instanceof Error ? reason.message : '无法刷新任务，请重试'),
            )
          }}
        >
          刷新
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
          placeholder="任务标题"
          value={title}
          onChange={(event): void => setTitle(event.currentTarget.value)}
        />
        <input
          maxLength={10000}
          placeholder="验收条件（填写后进入待办）"
          value={acceptance}
          onChange={(event): void => setAcceptance(event.currentTarget.value)}
        />
        <button type="submit" disabled={creating}>
          {creating ? '添加中…' : '添加任务'}
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
                <div className="luban-board__empty">暂无任务，可拖入任务卡片</div>
              ) : (
                columnTasks.map((task) => (
                  <TaskCard
                    task={task}
                    plans={planLinks.get(task.id) ?? []}
                    transitionTarget={transitionTargetFor(task.status, transitionTargets[task.id])}
                    transitionBusy={busyTaskId !== undefined}
                    onTransitionTargetChange={(status): void =>
                      setTransitionTargets((current) => ({ ...current, [task.id]: status }))
                    }
                    onTransition={(status): void => {
                      void transition(task, status)
                    }}
                    key={task.id}
                  />
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

/** Contribute a full responsive Taskboard page to the Luban workbench. */
export function apply(ctx: ClientContext): void {
  registerWorkbenchPage(ctx, {
    id: 'luban-taskboard',
    title: '任务看板',
    group: '工作',
    order: 10,
    description: '从待办到完成，集中管理任务与验收条件。',
    component: TaskboardSection,
  })
}
