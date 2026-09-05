import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Component, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'

export interface WorkbenchPageProps {
  readonly close: () => void
}

export interface WorkbenchPage {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly group: '工作' | '协作' | '工具'
  readonly order: number
  readonly component: ComponentType<WorkbenchPageProps>
}

export interface WorkbenchSnapshot {
  readonly open: boolean
  readonly activeId: string | undefined
  readonly pages: readonly WorkbenchPage[]
}

/** Per-DSH-root state, shared even when independently installed plugins bundle this library. */
export class WorkbenchController {
  #snapshot: WorkbenchSnapshot = { open: false, activeId: undefined, pages: [] }
  readonly #listeners = new Set<() => void>()

  public readonly getSnapshot = (): WorkbenchSnapshot => this.#snapshot
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }
  private update(snapshot: WorkbenchSnapshot): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
  public readonly open = (id?: string): void => {
    const pages = this.#snapshot.pages
    const activeId = pages.some((page) => page.id === id)
      ? id
      : (pages.find((page) => page.id === 'luban-taskboard')?.id ?? pages[0]?.id)
    this.update({ ...this.#snapshot, open: true, activeId })
  }
  public readonly close = (): void => this.update({ ...this.#snapshot, open: false })
  public readonly select = (id: string): void => {
    if (this.#snapshot.pages.some((page) => page.id === id))
      this.update({ ...this.#snapshot, activeId: id })
  }
  public add(page: WorkbenchPage): () => void {
    if (this.#snapshot.pages.some((entry) => entry.id === page.id))
      throw new Error(`Duplicate Luban page: ${page.id}`)
    this.update({
      ...this.#snapshot,
      pages: [...this.#snapshot.pages, page].sort((a, b) => a.order - b.order),
    })
    let active = true
    return (): void => {
      if (!active) return
      active = false
      const pages = this.#snapshot.pages.filter((entry) => entry !== page)
      this.update({
        ...this.#snapshot,
        pages,
        activeId: this.#snapshot.activeId === page.id ? pages[0]?.id : this.#snapshot.activeId,
        open: pages.length > 0 && this.#snapshot.open,
      })
    }
  }
}

interface PageBoundaryProps {
  readonly children: ReactNode
}
interface PageBoundaryState {
  readonly failed: boolean
}

/** A broken tool must leave navigation and the return-to-chat action usable. */
class PageBoundary extends Component<PageBoundaryProps, PageBoundaryState> {
  public override state: PageBoundaryState = { failed: false }
  public static getDerivedStateFromError(): PageBoundaryState {
    return { failed: true }
  }
  public override render(): ReactNode {
    return this.state.failed ? (
      <div role="alert" className="luban-workbench__empty">
        <h3>此页面暂时无法显示</h3>
        <p>可以重试，或从左侧切换到其他功能。</p>
        <button type="button" onClick={(): void => this.setState({ failed: false })}>
          重新加载页面
        </button>
      </div>
    ) : (
      this.props.children
    )
  }
}

const STYLE = `
.luban-workbench-trigger{width:100%;display:flex;align-items:center;gap:9px;border:0;border-radius:8px;padding:10px 12px;color:inherit;background:transparent;cursor:pointer;font:inherit;text-align:left}.luban-workbench-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#e8edf3)}
.luban-workbench{position:fixed;inset:16px;margin:auto;width:calc(100vw - 32px);height:calc(100dvh - 32px);max-width:1600px;max-height:none;padding:0;border:1px solid var(--lb-border);border-radius:14px;background:var(--lb-bg);color:var(--lb-text);pointer-events:auto;font:14px/1.6 system-ui,sans-serif;overflow:hidden}
.luban-workbench::backdrop{background:#02061777}.luban-workbench__header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 22px;border-bottom:1px solid var(--lb-border);background:var(--lb-panel)}.luban-workbench__header h1{font-size:18px;margin:0}.luban-workbench__header p{font-size:12px;color:var(--lb-muted);margin:0}.luban-workbench button{font:inherit;cursor:pointer}.luban-workbench__back{padding:8px 14px;border:1px solid var(--lb-border);border-radius:8px;background:var(--lb-panel);color:var(--lb-text)}
.luban-workbench__body{display:grid;grid-template-columns:190px minmax(0,1fr);min-height:0}.luban-workbench__nav{padding:16px 12px;border-right:1px solid var(--lb-border);overflow:auto;background:var(--lb-panel)}.luban-workbench__group{margin:16px 8px 6px;font-size:12px;color:var(--lb-muted)}.luban-workbench__nav button{display:block;width:100%;padding:10px 12px;border:0;border-radius:8px;text-align:left;background:transparent;color:var(--lb-text);margin:3px 0}.luban-workbench__nav button[aria-current=page]{font-weight:650}.luban-workbench__content{padding:24px;overflow:auto;min-width:0}.luban-workbench__content>header{margin-bottom:20px}.luban-workbench__content h2{margin:0;font-size:22px}.luban-workbench__description{color:var(--lb-muted);margin:6px 0}.luban-workbench__empty{padding:28px;border:1px dashed var(--lb-border);border-radius:10px}
.luban-workbench :focus-visible{outline:3px solid #60a5fa;outline-offset:3px}
.luban-workbench{--lb-bg:var(--dsw-alias-bg-base,#f8fafc);--lb-panel:var(--dsw-specific-sidebar-fill,#fff);--lb-text:var(--dsw-alias-label-primary,#172033);--lb-muted:var(--dsw-alias-label-secondary,#526177);--lb-border:var(--dsw-alias-border-l3,#cbd5e1);--lb-link:#1d4ed8;--lb-error:#b91c1c;--lb-success:#166534;--lb-warning:#854d0e;--lb-selected:#dbeafe;display:none;flex-direction:column}.luban-workbench[open]{display:flex}.luban-workbench__body{height:auto;flex:1;min-height:0}.luban-workbench__header{flex:none}.luban-workbench__nav button[aria-current=page]{background:var(--lb-selected);color:var(--lb-link)}
body[data-ds-dark-theme] .luban-workbench{--lb-link:#93c5fd;--lb-error:#fca5a5;--lb-success:#86efac;--lb-warning:#fde68a;--lb-selected:#203c59}
.luban-workbench__content *{box-sizing:border-box}.luban-workbench__content input,.luban-workbench__content select,.luban-workbench__content textarea{max-width:100%}.luban-workbench__content button:disabled{cursor:not-allowed}.luban-workbench__content details{border:1px solid var(--lb-border);border-radius:8px;padding:12px}.luban-workbench__content summary{cursor:pointer;font-weight:600}.luban-workbench__content details[open]>summary{margin-bottom:12px}
@media(max-width:760px){.luban-workbench{inset:0;width:100vw;height:100dvh;border-radius:0}.luban-workbench__body{display:flex;flex-direction:column}.luban-workbench__nav{display:flex;flex-shrink:0;gap:6px;padding:8px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--lb-border)}.luban-workbench__group{display:none}.luban-workbench__nav>div{display:contents}.luban-workbench__nav button{white-space:nowrap;width:auto}.luban-workbench__content{padding:16px}.luban-workbench__header{padding:12px 16px}}
`

/** A native modal supplies focus trapping, Escape and background isolation without a UI dependency. */
export function Workbench({ controller }: { readonly controller: WorkbenchController }): ReactNode {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [mountFailure, setMountFailure] = useState(false)
  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (snapshot.open && !element.open) {
      try {
        element.showModal()
        setMountFailure(false)
      } catch {
        setMountFailure(true)
      }
    } else if (!snapshot.open && element.open) element.close()
  }, [snapshot.open])
  useEffect(() => {
    if (snapshot.open) heading.current?.focus()
  }, [snapshot.open, snapshot.activeId])
  const page = snapshot.pages.find((entry) => entry.id === snapshot.activeId)
  const Page = page?.component
  return (
    <>
      <style>{STYLE}</style>
      {mountFailure ? <p role="alert">无法打开鲁班工作台，请刷新浏览器重试。</p> : null}
      <dialog
        ref={dialog}
        className="luban-workbench"
        aria-labelledby="luban-workbench-title"
        onCancel={(): void => controller.close()}
        onClose={(): void => controller.close()}
      >
        <header className="luban-workbench__header">
          <div>
            <h1 id="luban-workbench-title">鲁班工作台</h1>
            <p>任务、计划与工具，集中处理</p>
          </div>
          <button
            type="button"
            className="luban-workbench__back"
            onClick={(): void => controller.close()}
          >
            返回对话
          </button>
        </header>
        <div className="luban-workbench__body">
          <nav className="luban-workbench__nav" aria-label="鲁班功能">
            {(['工作', '协作', '工具'] as const).map((group) => {
              const pages = snapshot.pages.filter((entry) => entry.group === group)
              return pages.length === 0 ? null : (
                <div key={group}>
                  <p className="luban-workbench__group">{group}</p>
                  {pages.map((entry) => (
                    <button
                      type="button"
                      key={entry.id}
                      aria-current={entry.id === snapshot.activeId ? 'page' : undefined}
                      onClick={(): void => controller.select(entry.id)}
                    >
                      {entry.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </nav>
          <main className="luban-workbench__content">
            <header>
              <h2 ref={heading} tabIndex={-1}>
                {page?.title ?? '暂无可用功能'}
              </h2>
              <p className="luban-workbench__description">
                {page?.description ?? '请启用需要使用的 Luban 插件。'}
              </p>
            </header>
            {snapshot.open && Page !== undefined ? (
              <PageBoundary key={page?.id}>
                <Page close={controller.close} />
              </PageBoundary>
            ) : null}
          </main>
        </div>
      </dialog>
    </>
  )
}

interface WorkbenchRuntime {
  readonly controller: WorkbenchController
  readonly dispose: () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanWorkbench?: WorkbenchRuntime
  }
}

/** Register one independently unloadable page; the shared shell lives only while pages are installed. */
export function registerWorkbenchPage(ctx: Context, page: WorkbenchPage): void {
  ctx.effect(() => {
    const root = ctx.root
    let runtime = root.get('lubanWorkbench')
    if (runtime === undefined) {
      const controller = new WorkbenchController()
      const releases: (() => void)[] = []
      runtime = {
        controller,
        dispose: (): void => {
          for (const release of releases.reverse()) release()
        },
      }
      releases.push(root.provide('lubanWorkbench', runtime))
      try {
        releases.push(
          root.slots.inject('sidebar.footer.action', () =>
            root.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'luban-workbench',
                order: -20,
                label: '鲁班工作台',
              },
              ({ wide }): ReactNode => (
                <button
                  type="button"
                  className="luban-workbench-trigger"
                  title="鲁班工作台"
                  aria-label="鲁班工作台"
                  onClick={(): void => controller.open()}
                >
                  <span aria-hidden="true">▦</span>
                  {wide ? <span>鲁班工作台</span> : null}
                </button>
              ),
            ),
          ),
        )
        releases.push(
          root.slots.inject('shell.overlay', () =>
            root.slots.register(
              { name: 'shell.overlay', id: 'luban-workbench', order: 30 },
              (): ReactNode => <Workbench controller={controller} />,
            ),
          ),
        )
      } catch (error) {
        runtime.dispose()
        throw error
      }
    }
    const owner = runtime
    const remove = owner.controller.add(page)
    return (): void => {
      remove()
      if (owner.controller.getSnapshot().pages.length === 0) owner.dispose()
    }
  }, `luban-workbench: ${page.id}`)
}
