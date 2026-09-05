// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Workbench, WorkbenchController } from '../src/client/workbench.js'

// jsdom does not implement the browser's top-layer dialog methods.
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  value: function (this: HTMLDialogElement): void {
    this.setAttribute('open', '')
  },
})
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  value: function (this: HTMLDialogElement): void {
    this.removeAttribute('open')
  },
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('workbench UI', () => {
  it('mounts only the active tool, closes to return to chat, and opens taskboard again', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.removeAttribute('open')
    })
    const controller = new WorkbenchController()
    controller.add({
      id: 'luban-taskboard',
      title: '任务看板',
      description: '管理任务',
      group: '工作',
      order: 0,
      component: () => createElement('p', null, 'Task data'),
    })
    controller.add({
      id: 'luban-plan',
      title: '计划审批',
      description: '确认后执行',
      group: '工作',
      order: 1,
      component: () => createElement('p', null, 'Plan data'),
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(Workbench, { controller }))
        await Promise.resolve()
      })
      expect(container.textContent).not.toContain('Task data')
      await act(async () => {
        controller.open()
        await Promise.resolve()
      })
      expect(container.querySelector('dialog')?.open).toBe(true)
      expect(container.textContent).toContain('Task data')
      await act(async () => {
        controller.select('luban-plan')
        await Promise.resolve()
      })
      expect(container.textContent).toContain('Plan data')
      expect(container.textContent).not.toContain('Task data')
      await act(async () => {
        container.querySelector<HTMLButtonElement>('.luban-workbench__back')?.click()
        await Promise.resolve()
      })
      expect(container.querySelector('dialog')?.open).toBe(false)
      expect(container.textContent).not.toContain('Plan data')
      await act(async () => {
        controller.open()
        await Promise.resolve()
      })
      expect(container.textContent).toContain('Task data')
    } finally {
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
    }
  })
})
