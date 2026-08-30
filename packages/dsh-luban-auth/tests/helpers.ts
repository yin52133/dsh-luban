import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock } from 'dsh-luban-core'
import { AuthManager } from '../src/auth-manager.js'
import type { AuditRecord, AuditSink, PasswordHasher } from '../src/types.js'

export class MutableClock implements Clock {
  public constructor(public value = Date.UTC(2026, 7, 30, 8, 0, 0)) {}

  public now(): number {
    return this.value
  }

  public advance(milliseconds: number): void {
    this.value += milliseconds
  }
}

export class MemoryAudit implements AuditSink {
  public readonly entries: AuditRecord[] = []
  public closed = false

  public record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry)
    return Promise.resolve()
  }

  public close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

export class DeterministicHasher implements PasswordHasher {
  public hashCount = 0
  public verifyCount = 0

  public hash(password: string): Promise<string> {
    this.hashCount += 1
    return Promise.resolve(`$argon2id$test$${Buffer.from(password, 'utf8').toString('base64url')}`)
  }

  public async verify(encodedHash: string, password: string): Promise<boolean> {
    this.verifyCount += 1
    return encodedHash === (await this.hash(password))
  }
}

export interface ManagerFixture {
  readonly directory: string
  readonly filePath: string
  readonly clock: MutableClock
  readonly audit: MemoryAudit
  readonly hasher: DeterministicHasher
  readonly manager: AuthManager
  cleanup(): Promise<void>
}

export async function createManagerFixture(
  overrides: {
    readonly maxFailures?: number
    readonly loginRateLimit?: number
    readonly sessionTtlMs?: number
  } = {},
): Promise<ManagerFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-luban-auth-test-'))
  const filePath = join(directory, 'users.json')
  const clock = new MutableClock()
  const audit = new MemoryAudit()
  const hasher = new DeterministicHasher()
  let randomCounter = 0
  const manager = new AuthManager({
    filePath,
    audit,
    clock,
    sessionTtlMs: overrides.sessionTtlMs ?? 60_000,
    maxFailures: overrides.maxFailures ?? 3,
    lockoutMs: 30_000,
    loginRateLimit: overrides.loginRateLimit ?? 10,
    passwordHasher: hasher,
    randomBytes(size): Buffer {
      randomCounter += 1
      return Buffer.alloc(size, randomCounter)
    },
  })
  await manager.initialize()
  return {
    directory,
    filePath,
    clock,
    audit,
    hasher,
    manager,
    async cleanup(): Promise<void> {
      await manager.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
