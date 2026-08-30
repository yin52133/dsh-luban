import type { Actor, Clock, HostId, SessionId } from 'dsh-luban-core'
import { asActorId, asHostId, asSessionId } from 'dsh-luban-core'

export class MutableClock implements Clock {
  public value = Date.UTC(2026, 7, 30, 2, 0, 0)

  public now(): number {
    return this.value
  }

  public advance(milliseconds: number): void {
    this.value += milliseconds
  }
}

export function user(id: string): Actor {
  return { kind: 'user', id: asActorId(id), displayName: id }
}

export function host(id: string): HostId {
  return asHostId(id)
}

export function session(id: string): SessionId {
  return asSessionId(id)
}
