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

export interface UiPlanSections {
  readonly background: string
  readonly impact: string
  readonly changes: string
  readonly verification: string
}

export interface UiPlan {
  readonly id: string
  readonly taskId?: string
  readonly sessionId?: string
  readonly status: string
  readonly sections: UiPlanSections
  readonly filePath: string
  readonly decisions: readonly {
    readonly decision: 'approve' | 'reject'
    readonly comment?: string
    readonly at: number
  }[]
  readonly version: number
}

const STYLE = `
.luban-plan{display:grid;gap:14px;color:var(--lb-text,#172033);min-width:0}
.luban-plan form,.luban-plan__toolbar{display:grid;gap:8px}.luban-plan__toolbar{grid-template-columns:repeat(3,minmax(0,1fr))}
.luban-plan input,.luban-plan textarea,.luban-plan button{font:inherit;border:1px solid var(--lb-border,#cbd5e1);border-radius:6px;padding:8px;background:var(--lb-panel,#fff);color:inherit}
.luban-plan textarea{min-height:76px;resize:vertical}.luban-plan button{cursor:pointer;background:#1d4ed8;color:#fff;border-color:#2563eb}.luban-plan button:disabled{opacity:.55}
.luban-plan__list{display:grid;gap:10px}.luban-plan__card{border:1px solid var(--lb-border,#cbd5e1);background:var(--lb-bg,#f8fafc);border-radius:8px;padding:12px;display:grid;gap:8px}
.luban-plan__card h3{margin:0;font-size:14px}.luban-plan__meta{font-size:12px;color:var(--lb-muted,#526177);overflow-wrap:anywhere}.luban-plan__actions{display:flex;gap:8px;flex-wrap:wrap}.luban-plan__revision{border-top:1px solid var(--lb-border,#cbd5e1);padding-top:8px}.luban-plan__reject{background:#991b1b!important}.luban-plan__error{color:var(--lb-error,#b91c1c);white-space:pre-wrap}
@media(max-width:760px){.luban-plan__toolbar{grid-template-columns:1fr}.luban-plan__actions>*{flex:1 1 130px}}
`

export function plansFrom(value: unknown): UiPlan[] {
  if (typeof value !== 'object' || value === null) throw new Error('Plan API returned invalid JSON')
  const plans = (value as Readonly<Record<string, unknown>>).plans
  if (!Array.isArray(plans)) throw new Error('Plan API returned invalid plans')
  return plans.map((value): UiPlan => {
    if (typeof value !== 'object' || value === null)
      throw new Error('Plan API returned an invalid plan')
    const row = value as Readonly<Record<string, unknown>>
    if (
      typeof row.id !== 'string' ||
      typeof row.status !== 'string' ||
      typeof row.filePath !== 'string' ||
      typeof row.version !== 'number' ||
      typeof row.sections !== 'object' ||
      row.sections === null ||
      !Array.isArray(row.decisions)
    )
      throw new Error('Plan API returned an invalid plan')
    return row as unknown as UiPlan
  })
}

async function writeApi(path: string, body: unknown): Promise<void> {
  const response = await fetch(`/luban-plan${path}`, {
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
    throw new Error(detail === '' ? `Plan request failed (${String(response.status)})` : detail)
  }
}

export async function decidePlan(
  id: string,
  decision: 'approve' | 'reject',
  expectedVersion: number,
  comment?: string,
): Promise<void> {
  await writeApi(`/plans/${encodeURIComponent(id)}/decision`, {
    decision,
    expectedVersion,
    ...(comment === undefined ? {} : { comment }),
  })
}

export function isPlanRevisableStatus(status: string): boolean {
  return status === 'rejected' || status === 'revising'
}

/** Resubmit all required plan sections through the versioned revise endpoint. */
export async function revisePlan(
  id: string,
  sections: UiPlanSections,
  expectedVersion: number,
): Promise<void> {
  await writeApi(`/plans/${encodeURIComponent(id)}/revise`, { sections, expectedVersion })
}

export function RevisionEditor({
  planId,
  sections,
  busy,
  onChange,
  onSubmit,
}: {
  readonly planId: string
  readonly sections: UiPlanSections
  readonly busy: boolean
  readonly onChange: (name: keyof UiPlanSections, value: string) => void
  readonly onSubmit: () => void
}): ReactNode {
  return (
    <form
      className="luban-plan__revision"
      aria-label={`Revise ${planId}`}
      onSubmit={(event): void => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <textarea
        required
        aria-label={`Revised background for ${planId}`}
        value={sections.background}
        onChange={(event): void => onChange('background', event.currentTarget.value)}
      />
      <textarea
        required
        aria-label={`Revised impact scope for ${planId}`}
        value={sections.impact}
        onChange={(event): void => onChange('impact', event.currentTarget.value)}
      />
      <textarea
        required
        aria-label={`Revised change locations for ${planId}`}
        value={sections.changes}
        onChange={(event): void => onChange('changes', event.currentTarget.value)}
      />
      <textarea
        required
        aria-label={`Revised verification for ${planId}`}
        value={sections.verification}
        onChange={(event): void => onChange('verification', event.currentTarget.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Revising…' : '提交修订'}
      </button>
    </form>
  )
}

function ReviewCard({
  plan,
  refresh,
  reportError,
}: {
  readonly plan: UiPlan
  readonly refresh: () => Promise<void>
  readonly reportError: (message: string) => void
}): ReactNode {
  const [comment, setComment] = useState('')
  const [revision, setRevision] = useState<UiPlanSections>(plan.sections)
  const [busy, setBusy] = useState(false)
  useEffect((): void => {
    setRevision(plan.sections)
  }, [plan.id, plan.version])
  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(true)
    reportError('')
    try {
      await decidePlan(plan.id, decision, plan.version, decision === 'reject' ? comment : undefined)
      setComment('')
      await refresh()
    } catch (error: unknown) {
      reportError(error instanceof Error ? error.message : 'Unable to review plan')
    } finally {
      setBusy(false)
    }
  }
  const revise = async (): Promise<void> => {
    setBusy(true)
    reportError('')
    try {
      await revisePlan(plan.id, revision, plan.version)
      await refresh()
    } catch (error: unknown) {
      reportError(error instanceof Error ? error.message : 'Unable to revise plan')
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="luban-plan__card" data-plan-id={plan.id}>
      <h3>
        {plan.id} · {statusLabel(plan.status)}
      </h3>
      <div className="luban-plan__meta">
        {plan.taskId === undefined ? '未关联任务' : `任务 ${plan.taskId}`}
        {plan.sessionId === undefined ? '' : ` · 对话 ${plan.sessionId}`} · v{plan.version}
      </div>
      <div>{plan.sections.background}</div>
      <a
        href={`/luban-plan/plans/${encodeURIComponent(plan.id)}/document`}
        target="_blank"
        rel="noreferrer"
      >
        {plan.filePath}
      </a>
      {plan.status === 'in-review' ? (
        <>
          <textarea
            aria-label={`Review comment for ${plan.id}`}
            placeholder="驳回时请填写原因，便于修改后重新提交"
            value={comment}
            onChange={(event): void => setComment(event.currentTarget.value)}
          />
          <div className="luban-plan__actions">
            <button
              type="button"
              disabled={busy}
              onClick={(): void => {
                void decide('approve')
              }}
            >
              批准
            </button>
            <button
              className="luban-plan__reject"
              type="button"
              disabled={busy || comment.trim() === ''}
              onClick={(): void => {
                void decide('reject')
              }}
            >
              驳回并附上原因
            </button>
          </div>
        </>
      ) : null}
      {plan.decisions.at(-1)?.comment === undefined ? null : (
        <div className="luban-plan__meta">Latest feedback: {plan.decisions.at(-1)?.comment}</div>
      )}
      {isPlanRevisableStatus(plan.status) ? (
        <RevisionEditor
          planId={plan.id}
          sections={revision}
          busy={busy}
          onChange={(name, value): void =>
            setRevision((current): UiPlanSections => ({ ...current, [name]: value }))
          }
          onSubmit={(): void => {
            void revise()
          }}
        />
      ) : null}
    </article>
  )
}

export function PlanReviewSection(_props: WorkbenchPageProps): ReactNode {
  const [plans, setPlans] = useState<UiPlan[]>([])
  const [workspace, setWorkspace] = useState('.')
  const [slug, setSlug] = useState('planned-change')
  const [taskId, setTaskId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [background, setBackground] = useState('')
  const [impact, setImpact] = useState('')
  const [changes, setChanges] = useState('')
  const [verification, setVerification] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch('/luban-plan/plans', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Unable to load plans (${String(response.status)})`)
    setPlans(plansFrom(await response.json()))
    setError('')
  }, [])

  useEffect(() => {
    void refresh().catch((reason: unknown): void =>
      setError(reason instanceof Error ? reason.message : 'Unable to load plans'),
    )
    const events = new EventSource('/luban-plan/events')
    events.addEventListener('plan', (): void => {
      void refresh().catch((reason: unknown): void =>
        setError(reason instanceof Error ? reason.message : 'Unable to load plans'),
      )
    })
    events.onerror = (): void => setError('Plan live updates disconnected; retrying automatically')
    return (): void => events.close()
  }, [refresh])

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await writeApi('/plans', {
        workspace,
        slug,
        ...(taskId.trim() === '' ? {} : { taskId }),
        ...(sessionId.trim() === '' ? {} : { sessionId }),
        sections: { background, impact, changes, verification },
      })
      setBackground('')
      setImpact('')
      setChanges('')
      setVerification('')
      await refresh()
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Unable to submit plan')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="luban-plan" aria-label="Luban plan review">
      <style>{STYLE}</style>
      <button
        type="button"
        onClick={(): void => {
          void refresh().catch((reason: unknown): void =>
            setError(reason instanceof Error ? reason.message : '无法刷新计划，请重试'),
          )
        }}
      >
        刷新计划
      </button>
      <details>
        <summary>新建计划</summary>
        <form
          onSubmit={(event): void => {
            void submit(event)
          }}
        >
          <div className="luban-plan__toolbar">
            <label style={{ display: 'grid', gap: 4 }}>
              工作区
              <input
                required
                aria-label="工作区"
                value={workspace}
                onChange={(event): void => setWorkspace(event.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              计划文件名
              <input
                required
                aria-label="计划文件名"
                value={slug}
                onChange={(event): void => setSlug(event.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              任务 ID
              <input
                aria-label="任务 ID"
                placeholder="关联任务 ID（可选）"
                value={taskId}
                onChange={(event): void => setTaskId(event.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              对话 ID
              <input
                aria-label="对话 ID"
                placeholder="关联对话 ID（可选）"
                value={sessionId}
                onChange={(event): void => setSessionId(event.currentTarget.value)}
              />
            </label>
          </div>
          <label style={{ display: 'grid', gap: 4 }}>
            需求背景
            <textarea
              required
              aria-label="需求背景"
              placeholder="1. 背景与需求"
              value={background}
              onChange={(event): void => setBackground(event.currentTarget.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            影响范围
            <textarea
              required
              aria-label="影响范围"
              placeholder="2. 影响范围"
              value={impact}
              onChange={(event): void => setImpact(event.currentTarget.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            修改位置
            <textarea
              required
              aria-label="修改位置"
              placeholder="3. 具体修改位置"
              value={changes}
              onChange={(event): void => setChanges(event.currentTarget.value)}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            验证方式
            <textarea
              required
              aria-label="验证方式"
              placeholder="4. 验证方式"
              value={verification}
              onChange={(event): void => setVerification(event.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? '提交中…' : '提交审批'}
          </button>
        </form>
      </details>
      {error === '' ? null : (
        <div className="luban-plan__error" role="alert">
          {error}
        </div>
      )}
      <div className="luban-plan__list">
        {plans.length === 0 && error === '' ? (
          <p>暂无计划。展开“新建计划”，填写修改范围与验证方式后提交审批。</p>
        ) : null}
        {plans.map((plan) => (
          <ReviewCard key={plan.id} plan={plan} refresh={refresh} reportError={setError} />
        ))}
      </div>
    </section>
  )
}

export const inject = ['slots']

/** Contribute the authenticated plan review page to the Luban workbench. */
export function apply(ctx: ClientContext): void {
  registerWorkbenchPage(ctx, {
    id: 'luban-plan',
    title: '计划审批',
    group: '工作',
    order: 20,
    description: '查看修改范围、审批计划，确认后再执行。',
    component: PlanReviewSection,
  })
}
