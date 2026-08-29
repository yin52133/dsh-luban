export interface WorkerSpec {
  readonly schemaVersion: 1
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly artifactDirectory: string
  readonly collect: readonly string[]
  readonly resultFile: string
}

export interface WorkerResult {
  readonly schemaVersion: 1
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

function objectValue(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) {
    throw new TypeError(`${name} must be a valid string`)
  }
  return value
}

function texts(value: unknown, name: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: unknown): item is string => typeof item === 'string' && !item.includes('\0'),
    )
  ) {
    throw new TypeError(`${name} must be a string array`)
  }
  return [...value]
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${String(minimum)}`)
  }
  return value
}

export function decodeWorkerSpec(value: unknown): WorkerSpec {
  const row = objectValue(value, 'worker spec')
  if (row.schemaVersion !== 1) throw new TypeError('worker spec schemaVersion must be 1')
  return {
    schemaVersion: 1,
    command: text(row.command, 'worker spec command'),
    args: texts(row.args, 'worker spec args'),
    cwd: text(row.cwd, 'worker spec cwd'),
    timeoutMs: integer(row.timeoutMs, 'worker spec timeoutMs', 1),
    artifactDirectory: text(row.artifactDirectory, 'worker spec artifactDirectory'),
    collect: texts(row.collect, 'worker spec collect'),
    resultFile: text(row.resultFile, 'worker spec resultFile'),
  }
}

export function decodeWorkerResult(value: unknown): WorkerResult {
  const row = objectValue(value, 'worker result')
  if (row.schemaVersion !== 1) throw new TypeError('worker result schemaVersion must be 1')
  return {
    schemaVersion: 1,
    exitCode: integer(row.exitCode, 'worker result exitCode', -1),
    stdout: typeof row.stdout === 'string' ? row.stdout : '',
    stderr: typeof row.stderr === 'string' ? row.stderr : '',
    durationMs: integer(row.durationMs, 'worker result durationMs'),
  }
}
