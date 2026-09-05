const STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  backlog: '待整理',
  todo: '待办',
  doing: '进行中',
  review: '待验收',
  done: '已完成',
  dropped: '已取消',
  draft: '草稿',
  'in-review': '待审批',
  approved: '已批准',
  rejected: '已驳回',
  revising: '修订中',
  queued: '排队中',
  running: '运行中',
  failed: '失败',
  succeeded: '成功',
  cancelled: '已取消',
  idle: '空闲',
  observer: '旁观者',
  operator: '操作者',
  owner: '所有者',
})

/** Keep wire values stable while presenting known business states in the UI language. */
export function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value
}
