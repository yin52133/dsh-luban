import type { AccountId, AccountSessionRegistry, SessionId } from '@yin52133/dsh-luban-core'
import { LubanError, asAccountId } from '@yin52133/dsh-luban-core'

export const ALICE = asAccountId('alice')
export const BOB = asAccountId('bob')

/** In-memory equivalent of M01's immutable session ownership registry for package tests. */
export function memoryAccountSessions(
  initial: readonly (readonly [AccountId, SessionId])[] = [],
): AccountSessionRegistry {
  const owners = new Map<SessionId, AccountId>(
    initial.map(([accountId, sessionId]): readonly [SessionId, AccountId] => [
      sessionId,
      accountId,
    ]),
  )
  return {
    bind(accountId, sessionId): Promise<void> {
      const current = owners.get(sessionId)
      if (current !== undefined && current !== accountId) {
        throw new LubanError(
          'E_ACCOUNT_SCOPE_MISMATCH',
          `Session ${sessionId} already belongs to another account`,
        )
      }
      owners.set(sessionId, accountId)
      return Promise.resolve()
    },
    ownerOf(sessionId): Promise<AccountId | null> {
      return Promise.resolve(owners.get(sessionId) ?? null)
    },
  }
}
