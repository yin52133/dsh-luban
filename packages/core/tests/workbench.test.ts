import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerWorkbenchPage, WorkbenchController } from '../src/client/workbench.js'
import type { WorkbenchPage } from '../src/client/workbench.js'

const page = (id: string, order = 1): WorkbenchPage => ({
  id,
  order,
  title: id,
  description: 'Test page',
  group: '工作',
  component: () => null,
})

describe('workbench navigation', () => {
  it('opens taskboard by default, validates selection, and falls back after unload', () => {
    const controller = new WorkbenchController()
    controller.add(page('luban-plan'))
    const remove = controller.add(page('luban-taskboard', 0))
    controller.open()
    expect(controller.getSnapshot().activeId).toBe('luban-taskboard')
    controller.select('missing')
    expect(controller.getSnapshot().activeId).toBe('luban-taskboard')
    remove()
    expect(controller.getSnapshot().activeId).toBe('luban-plan')
    controller.close()
    expect(controller.getSnapshot().open).toBe(false)
  })
  it('notifies subscribers, rejects duplicates and makes disposal idempotent', () => {
    const controller = new WorkbenchController()
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    const remove = controller.add(page('one'))
    expect(() => controller.add(page('one'))).toThrow('Duplicate')
    controller.open('one')
    expect(listener).toHaveBeenCalledTimes(2)
    remove()
    remove()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot()).toMatchObject({ open: false, pages: [] })
    unsubscribe()
    controller.open()
    expect(listener).toHaveBeenCalledTimes(3)
  })
  it('shares one shell across real Cordis fibers and releases it only after the last page', async () => {
    const root = new Context()
    const releaseSlot = vi.fn()
    const injectSlot = vi.fn(() => releaseSlot)
    root.provide('slots', { inject: injectSlot })
    const first = await root.plugin((ctx: Context): void =>
      registerWorkbenchPage(ctx, page('first')),
    )
    const second = await root.plugin((ctx: Context): void =>
      registerWorkbenchPage(ctx, page('second')),
    )
    expect(injectSlot).toHaveBeenCalledTimes(2)
    expect(root.lubanWorkbench?.controller.getSnapshot().pages).toHaveLength(2)
    await first.dispose()
    expect(releaseSlot).not.toHaveBeenCalled()
    expect(root.lubanWorkbench?.controller.getSnapshot().pages).toHaveLength(1)
    await second.dispose()
    expect(releaseSlot).toHaveBeenCalledTimes(2)
    expect(root.get('lubanWorkbench')).toBeUndefined()
    await root.fiber.dispose()
  })
})
