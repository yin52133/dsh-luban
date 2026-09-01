import type { Clock } from '@yin52133/dsh-luban-core'
import { AtomicJsonStore, asTaskId } from '@yin52133/dsh-luban-core'
import { decodeLedger, emptyLedger, type TaskLedger } from '../../src/ledger.js'
import { JsonTaskStore } from '../../src/task-store.js'

function requiredArgument(index: number, label: string): string {
  const value = process.argv[index]
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

const filePath = requiredArgument(2, 'ledger path')
const taskId = asTaskId(requiredArgument(3, 'task id'))
const now = Number.parseInt(requiredArgument(4, 'clock value'), 10)
const dailyQuota = Number.parseInt(requiredArgument(5, 'daily quota'), 10)
if (!Number.isSafeInteger(now) || !Number.isSafeInteger(dailyQuota) || dailyQuota <= 0) {
  throw new Error('clock value and daily quota must be safe integers')
}

const clock: Clock = { now: (): number => now }
const ledger = new AtomicJsonStore<TaskLedger>({
  filePath,
  codec: { decode: decodeLedger, encode: (value): unknown => value },
  initial: (): TaskLedger => emptyLedger(new Date(now).toISOString().slice(0, 10)),
  backupCount: 0,
  beforePublish: async (): Promise<void> => {
    process.stdout.write('before-publish\n')
    await new Promise<void>(() => {
      setInterval((): void => undefined, 60_000)
    })
  },
})
const store = new JsonTaskStore(ledger, clock)
const task = await store.get(taskId)
if (task?.claim === undefined || task.claim === null) throw new Error('claimed task is required')

await store.settleNightRun({
  kind: 'complete',
  id: task.id,
  expectedClaim: task.claim,
  output: {
    kind: 'note',
    ref: 'crash-boundary-result',
    summary: 'settled by crash fixture',
    at: now,
    by: task.claim.actor,
  },
  autoDone: true,
  dailyQuota,
})
