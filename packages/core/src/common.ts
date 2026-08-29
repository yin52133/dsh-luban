/** A nominal string identifier that cannot be mixed with another identifier type. */
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name }

export type TaskId = Brand<string, 'TaskId'>
export type SessionId = Brand<string, 'SessionId'>
export type PlanId = Brand<string, 'PlanId'>
export type HostId = Brand<string, 'HostId'>
export type ActorId = Brand<string, 'ActorId'>
export type PackageName = Brand<string, 'PackageName'>

export interface Actor {
  readonly kind: 'user' | 'agent'
  readonly id: ActorId
  readonly displayName?: string
}

export type Unsubscribe = () => void
export type EpochMs = number

export interface Clock {
  now(): EpochMs
}

/** Production clock kept injectable so state machines stay deterministic in tests. */
export const systemClock: Clock = Object.freeze({
  now: (): EpochMs => Date.now(),
})

export function asTaskId(value: string): TaskId {
  return value as TaskId
}

export function asSessionId(value: string): SessionId {
  return value as SessionId
}

export function asPlanId(value: string): PlanId {
  return value as PlanId
}

export function asHostId(value: string): HostId {
  return value as HostId
}

export function asActorId(value: string): ActorId {
  return value as ActorId
}

export function asPackageName(value: string): PackageName {
  return value as PackageName
}
