import type { ChannelEndpoint } from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import type { SerialChannelAdapter } from './serial.js'
import type { ResolvedInvocation } from './templates.js'
import type { ManagedChannel } from './types.js'

interface ResourceClaim {
  readonly key: string
  readonly label: string
  readonly kind: 'serial' | 'android' | 'probe' | 'tool'
  readonly value: string
}

interface ResourceOwner {
  readonly kind: 'template' | 'channel'
  readonly id: string
}

function claimsFor(invocation: ResolvedInvocation): readonly ResourceClaim[] {
  if (
    invocation.template.category !== 'flash' &&
    invocation.template.category !== 'reset' &&
    invocation.template.category !== 'android' &&
    invocation.template.id !== 'openocd-server'
  ) {
    return []
  }
  const claims: ResourceClaim[] = []
  const port = invocation.params.port
  if (port !== undefined) {
    claims.push({
      key: `serial:${port.toLocaleUpperCase()}`,
      label: `serial port ${port}`,
      kind: 'serial',
      value: port,
    })
  }
  const device = invocation.params.device
  if (device !== undefined) {
    const android = invocation.template.tool === 'adb' || invocation.template.tool === 'fastboot'
    claims.push({
      key: `${android ? 'android' : 'probe'}:${device.toLocaleLowerCase()}`,
      label: `${android ? 'Android device' : 'debug target'} ${device}`,
      kind: android ? 'android' : 'probe',
      value: device,
    })
  }
  const probe = invocation.params.probe
  if (probe !== undefined) {
    claims.push({
      key: `probe:${probe.toLocaleLowerCase()}`,
      label: `debug probe ${probe}`,
      kind: 'probe',
      value: probe,
    })
  }
  if (invocation.template.tool === 'openocd') {
    const interfaceConfig = invocation.params.interfaceConfig
    if (interfaceConfig !== undefined) {
      claims.push({
        key: `tool:openocd-interface:${interfaceConfig.toLocaleLowerCase()}`,
        label: `OpenOCD interface ${interfaceConfig}`,
        kind: 'tool',
        value: interfaceConfig,
      })
    }
    const targetConfig = invocation.params.targetConfig
    if (targetConfig !== undefined) {
      claims.push({
        key: `tool:openocd-target:${targetConfig.toLocaleLowerCase()}`,
        label: `OpenOCD target ${targetConfig}`,
        kind: 'tool',
        value: targetConfig,
      })
    }
  }
  if (claims.length === 0) {
    const target = invocation.params.interfaceConfig ?? invocation.template.tool
    claims.push({
      key: `tool:${invocation.template.tool}:${target.toLocaleLowerCase()}`,
      label: `${invocation.template.tool} target ${target}`,
      kind: 'tool',
      value: target,
    })
  }
  return claims
}

function claimsForEndpoint(endpoint: ChannelEndpoint): readonly ResourceClaim[] {
  if (endpoint.kind === 'serial' && endpoint.params.port !== undefined) {
    const port = endpoint.params.port
    return [
      {
        key: `serial:${port.toLocaleUpperCase()}`,
        label: `serial port ${port}`,
        kind: 'serial',
        value: port,
      },
    ]
  }
  if (
    (endpoint.kind === 'adb' || endpoint.kind === 'fastboot') &&
    endpoint.params.deviceId !== undefined
  ) {
    const device = endpoint.params.deviceId
    return [
      {
        key: `android:${device.toLocaleLowerCase()}`,
        label: `Android device ${device}`,
        kind: 'android',
        value: device,
      },
    ]
  }
  return []
}

function activeConflict(
  claim: ResourceClaim,
  channels: readonly ManagedChannel[],
): ManagedChannel | undefined {
  if (claim.kind === 'serial') {
    return channels.find(
      (channel): boolean =>
        channel.endpoint.kind === 'serial' &&
        channel.endpoint.params.port?.toLocaleUpperCase() === claim.value.toLocaleUpperCase(),
    )
  }
  if (claim.kind === 'android') {
    return channels.find(
      (channel): boolean =>
        (channel.endpoint.kind === 'adb' || channel.endpoint.kind === 'fastboot') &&
        channel.endpoint.params.deviceId?.toLocaleLowerCase() === claim.value.toLocaleLowerCase(),
    )
  }
  return undefined
}

/** Exclusive template lease plus channel/device occupancy preflight. */
export class DeviceExecutionGate {
  readonly #activeChannels: () => readonly ManagedChannel[]
  readonly #serial: SerialChannelAdapter | undefined
  readonly #preflightTimeoutMs: number
  readonly #held = new Map<string, ResourceOwner>()

  public constructor(options: {
    readonly activeChannels: () => readonly ManagedChannel[]
    readonly serial?: SerialChannelAdapter
    readonly preflightTimeoutMs?: number
  }) {
    const preflightTimeoutMs = options.preflightTimeoutMs ?? 10_000
    if (!Number.isSafeInteger(preflightTimeoutMs) || preflightTimeoutMs <= 0) {
      throw new TypeError('preflightTimeoutMs must be a positive integer')
    }
    this.#activeChannels = options.activeChannels
    this.#serial = options.serial
    this.#preflightTimeoutMs = preflightTimeoutMs
  }

  public async acquire(invocation: ResolvedInvocation, signal?: AbortSignal): Promise<() => void> {
    const claims = claimsFor(invocation)
    if (claims.length === 0) return (): void => undefined
    if (signal?.aborted === true) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Device preflight was cancelled', {
        retriable: true,
      })
    }
    const release = this.#reserve(claims, {
      kind: 'template',
      id: invocation.template.id,
    })
    try {
      for (const claim of claims) {
        if (claim.kind !== 'serial') continue
        if (this.#serial === undefined) {
          throw new LubanError(
            'E_CHANNEL_UNAVAILABLE',
            `Cannot verify ${claim.label} occupancy because the serial adapter is unavailable`,
            {
              retriable: true,
              details: { reason: 'preflight-unavailable', resource: claim.key },
            },
          )
        }
        const baud = invocation.params.baud
        await this.#checkSerial(
          this.#serial,
          claim.value,
          baud === undefined ? undefined : Number(baud),
          signal,
        )
      }
      return release
    } catch (error: unknown) {
      release()
      throw error
    }
  }

  /** Hold the same resource lease from channel open through close/pump completion. */
  public acquireChannel(endpoint: ChannelEndpoint, signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject): void => {
      try {
        if (signal?.aborted === true) {
          throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Channel open was cancelled', {
            retriable: true,
          })
        }
        const claims = claimsForEndpoint(endpoint)
        resolve(
          claims.length === 0
            ? (): void => undefined
            : this.#reserve(claims, { kind: 'channel', id: endpoint.id }),
        )
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error('Channel resource preflight failed'))
      }
    })
  }

  #reserve(claims: readonly ResourceClaim[], requester: ResourceOwner): () => void {
    for (const claim of claims) {
      const channel = activeConflict(claim, this.#activeChannels())
      if (channel !== undefined) {
        throw new LubanError(
          'E_CHANNEL_UNAVAILABLE',
          `${claim.label} is occupied by another Luban channel; close it before retrying`,
          {
            retriable: true,
            details: {
              reason: 'occupied',
              resource: claim.key,
              owner: 'luban-active-channel',
            },
          },
        )
      }
      const owner = this.#held.get(claim.key)
      if (owner !== undefined) {
        const description =
          owner.kind === 'template' ? `running template ${owner.id}` : `Luban channel ${owner.id}`
        throw new LubanError(
          'E_CHANNEL_UNAVAILABLE',
          `${claim.label} is occupied by ${description}; wait for it to release the resource`,
          {
            retriable: true,
            details: {
              reason: 'occupied',
              resource: claim.key,
              owner: owner.kind === 'template' ? owner.id : 'luban-channel-lease',
              ownerId: owner.id,
            },
          },
        )
      }
    }
    for (const claim of claims) this.#held.set(claim.key, requester)
    let active = true
    return (): void => {
      if (!active) return
      active = false
      for (const claim of claims) {
        if (this.#held.get(claim.key) === requester) this.#held.delete(claim.key)
      }
    }
  }

  async #checkSerial(
    serial: SerialChannelAdapter,
    port: string,
    baudRate: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const deadline = new AbortController()
    const combined =
      signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject): void => {
      timer = setTimeout((): void => {
        reject(
          new LubanError('E_TIMEOUT', `Serial occupancy preflight timed out for ${port}`, {
            retriable: true,
            details: { reason: 'preflight-timeout', path: port },
          }),
        )
        deadline.abort()
      }, this.#preflightTimeoutMs)
      timer.unref()
    })
    try {
      await Promise.race([serial.checkAvailable(port, baudRate, combined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
