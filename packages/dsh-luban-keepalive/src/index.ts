import type { Context } from '@deepseek-ai/cordis'
import type {
  AccountId,
  KeepaliveEvent,
  KeepaliveService,
  TaskStore,
} from '@yin52133/dsh-luban-core'
import { LubanError } from '@yin52133/dsh-luban-core'
import { TaskboardKeepaliveAlertSink } from './alerts.js'
import { NodeCommandRunner, type CommandRunner } from './command-runner.js'
import {
  Config as ConfigSchema,
  type Config as KeepaliveConfig,
  parseConfig,
  resolveUserPath,
} from './config.js'
import { KeepaliveLedgerStore } from './ledger.js'
import { ManagedKeepaliveService } from './service.js'
import { TmuxKeepaliveAdapter } from './tmux-adapter.js'
import { WindowsTaskKeepaliveAdapter } from './windows-adapter.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanKeepalive: KeepaliveService
    lubanTaskStore: TaskStore
  }

  interface Events {
    'luban.keepalive.health'(payload: {
      readonly accountId?: AccountId
      readonly sessionId: string
      readonly alive: boolean
      readonly detail?: string
    }): void
  }
}

export const name = 'luban-keepalive'
export const inject: readonly string[] = []
export const Config = ConfigSchema
export type Config = KeepaliveConfig

export { TaskboardKeepaliveAlertSink } from './alerts.js'
export type { KeepaliveAlertSink } from './alerts.js'
export { assertSuccess, NodeCommandRunner } from './command-runner.js'
export type { CommandOptions, CommandResult, CommandRunner } from './command-runner.js'
export { runCheckpointedTask } from './checkpoint-runner.js'
export type {
  CheckpointedTaskOptions,
  CheckpointStep,
  CheckpointStepContext,
} from './checkpoint-runner.js'
export { parseConfig, resolveUserPath } from './config.js'
export type { KeepaliveStrategy } from './config.js'
export { emptyLedger, keepaliveLedgerCodec, KeepaliveLedgerStore } from './ledger.js'
export type { KeepaliveLedger, KeepaliveRecord } from './ledger.js'
export { ManagedKeepaliveService } from './service.js'
export type { ManagedKeepaliveOptions } from './service.js'
export { managedSessionId, posixCommand, windowsArguments, windowsCommand } from './session-id.js'
export { TmuxKeepaliveAdapter } from './tmux-adapter.js'
export type { TmuxAdapterOptions } from './tmux-adapter.js'
export { WindowsTaskKeepaliveAdapter } from './windows-adapter.js'
export type { WindowsAdapterOptions } from './windows-adapter.js'
export { WindowsHostTaskOperator } from './windows-host.js'
export type { WindowsHostPlan, WindowsHostStatus, WindowsHostTaskOptions } from './windows-host.js'
export {
  childTaskDefinition,
  hostTaskDefinition,
  isManagedChildTaskXml,
  matchesWindowsTaskXml,
  renderWindowsTaskXml,
  WINDOWS_HOST_TASK_NAME,
  WINDOWS_SESSION_TASK_PREFIX,
  windowsSessionTaskName,
} from './windows-task.js'
export type {
  WindowsHostAcceptanceLaunch,
  WindowsHostLaunch,
  WindowsTaskDefinition,
  WindowsTaskRepositoryOptions,
  WindowsTaskState,
  WindowsTaskTrigger,
} from './windows-task.js'

export interface AdapterFactoryOptions {
  readonly platform: NodeJS.Platform
  readonly config: KeepaliveConfig
  readonly runner: CommandRunner
  readonly signal: AbortSignal
}

/** Resolve boot recovery without treating truthy-looking environment text as authorization. */
export function resolveBootRestore(configured: boolean, environment: string | undefined): boolean {
  return configured || environment === '1'
}

export function createPlatformAdapter(
  options: AdapterFactoryOptions,
): TmuxKeepaliveAdapter | WindowsTaskKeepaliveAdapter {
  const strategy =
    options.config.strategy === 'auto'
      ? options.platform === 'linux'
        ? 'tmux'
        : options.platform === 'win32'
          ? 'service'
          : 'unsupported'
      : options.config.strategy
  const common = {
    runner: options.runner,
    timeoutMs: options.config.commandTimeoutSec * 1_000,
    signal: options.signal,
  }
  if (strategy === 'tmux' && options.platform === 'linux') return new TmuxKeepaliveAdapter(common)
  if (strategy === 'service' && options.platform === 'win32') {
    return new WindowsTaskKeepaliveAdapter(common)
  }
  throw new LubanError(
    'E_PLATFORM_UNSUPPORTED',
    `keepalive strategy ${strategy} is not supported on ${options.platform}`,
  )
}

function publishCordisEvent(ctx: Context, event: KeepaliveEvent): void {
  if (event.type !== 'health') return
  for (const session of event.report.sessions) {
    ctx.emit('luban.keepalive.health', {
      ...(session.accountId === undefined ? {} : { accountId: session.accountId }),
      sessionId: session.id,
      alive: session.alive,
      ...(session.detail === undefined ? {} : { detail: session.detail }),
    })
  }
}

/** Mount the platform HAL, durable recovery service, and health patrol. */
export function apply(ctx: Context, input: Partial<KeepaliveConfig> = {}): void {
  const config = parseConfig(input)
  const controller = new AbortController()
  const runner = new NodeCommandRunner()
  const adapter = createPlatformAdapter({
    platform: process.platform,
    config,
    runner,
    signal: controller.signal,
  })
  const optionalTaskStore = config.alertToTaskboard ? ctx.get('lubanTaskStore') : undefined
  const service = new ManagedKeepaliveService({
    adapter,
    ledger: new KeepaliveLedgerStore(resolveUserPath(config.ledgerFile)),
    patrolIntervalMs: config.patrolIntervalSec * 1_000,
    ...(optionalTaskStore === undefined
      ? {}
      : { alerts: new TaskboardKeepaliveAlertSink(optionalTaskStore) }),
    onError: (error: unknown): void => ctx.logger.warn(error),
    publish: (event): void => publishCordisEvent(ctx, event),
  })

  ctx.provide('lubanKeepalive', service)
  ctx.effect(() => {
    service.start()
    if (resolveBootRestore(config.bootRestore, process.env.LUBAN_BOOT_RESTORE)) {
      void service.restore().catch((error: unknown): void => ctx.logger.warn(error))
    }
    return async (): Promise<void> => {
      controller.abort()
      await service.dispose()
    }
  }, 'luban-keepalive: boot recovery and patrol lifecycle')
}
