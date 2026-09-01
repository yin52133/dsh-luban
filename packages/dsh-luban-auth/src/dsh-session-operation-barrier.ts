import type { AccountId } from '@yin52133/dsh-luban-core'

interface AccountBarrierState {
  readonly active: Set<symbol>
  readonly waiters: Set<() => void>
}

/** In-memory signal for retrying account-scoped reads after an overlapping operation settles. */
export class DshSessionOperationBarrier {
  readonly #states = new Map<AccountId, AccountBarrierState>()

  /** Register an operation; callers must invoke the returned function from `finally`. */
  public begin(accountId: AccountId): () => void {
    const state = this.#state(accountId)
    const token = Symbol('dsh-session-operation')
    state.active.add(token)

    return (): void => {
      const current = this.#states.get(accountId)
      if (!current?.active.delete(token)) return

      const waiters = [...current.waiters]
      current.waiters.clear()
      if (current.active.size === 0) this.#states.delete(accountId)
      for (const wake of waiters) wake()
    }
  }

  /** Wait for one active operation to settle, or report that no wait was needed. */
  public waitForChange(accountId: AccountId): Promise<boolean> {
    const state = this.#states.get(accountId)
    if (state === undefined || state.active.size === 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve): void => {
      state.waiters.add((): void => resolve(true))
    })
  }

  #state(accountId: AccountId): AccountBarrierState {
    const existing = this.#states.get(accountId)
    if (existing !== undefined) return existing
    const created: AccountBarrierState = { active: new Set(), waiters: new Set() }
    this.#states.set(accountId, created)
    return created
  }
}
