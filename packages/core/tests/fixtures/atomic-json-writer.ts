import { AtomicJsonStore } from '../../src/storage.js'

interface CrashSnapshot {
  readonly generation: 'old' | 'new'
  readonly payload: string
  readonly closingMarker: string
}

function requiredArgument(index: number, label: string): string {
  const value = process.argv[index]
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

const filePath = requiredArgument(2, 'file path')
const payloadBytes = Number.parseInt(requiredArgument(3, 'payload bytes'), 10)
if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) {
  throw new Error('payload bytes must be a positive safe integer')
}

const store = new AtomicJsonStore<CrashSnapshot>({
  filePath,
  codec: {
    decode(value: unknown): CrashSnapshot {
      return value as CrashSnapshot
    },
    encode(value: CrashSnapshot): unknown {
      return value
    },
  },
  initial: (): CrashSnapshot => ({
    generation: 'old',
    payload: 'stable-old-payload',
    closingMarker: 'old-complete',
  }),
  backupCount: 0,
  beforePublish: async (): Promise<void> => {
    process.stdout.write('before-publish\n')
    await new Promise<void>(() => {
      setInterval((): void => undefined, 60_000)
    })
  },
})

await store.write({
  generation: 'new',
  payload: 'n'.repeat(payloadBytes),
  closingMarker: 'new-complete',
})
