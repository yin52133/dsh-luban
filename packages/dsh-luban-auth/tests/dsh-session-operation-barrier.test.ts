import { asAccountId } from 'dsh-luban-core'
import { describe, expect, it } from 'vitest'
import { DshSessionOperationBarrier } from '../src/dsh-session-operation-barrier.js'

const alice = asAccountId('alice')
const bob = asAccountId('bob')

describe('DshSessionOperationBarrier', () => {
  it('returns false immediately when the account has no active operation', async () => {
    const barrier = new DshSessionOperationBarrier()

    await expect(barrier.waitForChange(alice)).resolves.toBe(false)
  })

  it('wakes every current waiter when any concurrent operation settles', async () => {
    const barrier = new DshSessionOperationBarrier()
    const settleFirst = barrier.begin(alice)
    const settleSecond = barrier.begin(alice)
    const firstWaiter = barrier.waitForChange(alice)
    const secondWaiter = barrier.waitForChange(alice)
    let observed = false
    void firstWaiter.then((): void => {
      observed = true
    })

    await Promise.resolve()
    expect(observed).toBe(false)
    settleSecond()
    await expect(firstWaiter).resolves.toBe(true)
    await expect(secondWaiter).resolves.toBe(true)

    const remaining = barrier.waitForChange(alice)
    settleFirst()
    await expect(remaining).resolves.toBe(true)
    await expect(barrier.waitForChange(alice)).resolves.toBe(false)
  })

  it('has no lost wakeup when settle follows registration in the same turn', async () => {
    const barrier = new DshSessionOperationBarrier()
    const settle = barrier.begin(alice)
    const changed = barrier.waitForChange(alice)

    settle()
    await expect(changed).resolves.toBe(true)
  })

  it('isolates interleaved accounts', async () => {
    const barrier = new DshSessionOperationBarrier()
    const settleAlice = barrier.begin(alice)
    const aliceChange = barrier.waitForChange(alice)
    let aliceObserved = false
    void aliceChange.then((): void => {
      aliceObserved = true
    })

    await expect(barrier.waitForChange(bob)).resolves.toBe(false)
    const settleBob = barrier.begin(bob)
    settleBob()
    await Promise.resolve()
    expect(aliceObserved).toBe(false)

    settleAlice()
    await expect(aliceChange).resolves.toBe(true)
  })

  it('makes repeated settle calls harmless, including after account reuse', async () => {
    const barrier = new DshSessionOperationBarrier()
    const staleSettle = barrier.begin(alice)
    staleSettle()
    staleSettle()

    const settleCurrent = barrier.begin(alice)
    staleSettle()
    const changed = barrier.waitForChange(alice)
    let observed = false
    void changed.then((): void => {
      observed = true
    })
    await Promise.resolve()
    expect(observed).toBe(false)

    settleCurrent()
    await expect(changed).resolves.toBe(true)
    settleCurrent()
    await expect(barrier.waitForChange(alice)).resolves.toBe(false)
  })
})
