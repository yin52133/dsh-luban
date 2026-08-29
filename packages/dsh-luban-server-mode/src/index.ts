import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AuthService, KeepaliveService, ServerModeService, TaskStore } from '@luban/core'
import { modulePrefix } from '@luban/core'
import { TaskboardBuildAlertSink } from './alerts.js'
import { ArtifactLinkSigner, ArtifactManager } from './artifacts.js'
import {
  Config as ConfigSchema,
  type Config as ServerModeConfig,
  parseConfig,
  resolveUserPath,
} from './config.js'
import { ManagedBuildExecutor } from './executor.js'
import { ServerModeHttpApi } from './http-api.js'
import { BuildLedgerStore } from './ledger.js'
import { NodeProcessRunner } from './process-runner.js'
import { BuildQueue, type BuildQueueEvent } from './queue.js'
import { NodeResourceProbe } from './resources.js'
import { DefaultServerModeService } from './service.js'
import { UserSystemdInstaller } from './systemd.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: AuthService
    lubanKeepalive: KeepaliveService
    lubanServerMode: ServerModeService
    lubanTaskStore: TaskStore
  }

  interface Events {
    'luban.build.job'(payload: {
      readonly jobId: string
      readonly from: string
      readonly to: string
    }): void
  }
}

export const name = 'luban-server-mode'
export const inject = ['webServer', 'lubanAuth', 'lubanKeepalive']
export const Config = ConfigSchema
export type Config = ServerModeConfig

export { TaskboardBuildAlertSink } from './alerts.js'
export type { BuildAlertSink } from './alerts.js'
export { ArtifactLinkSigner, ArtifactManager, attachmentName } from './artifacts.js'
export type { SignedArtifactLink } from './artifacts.js'
export { parseConfig, resolveUserPath } from './config.js'
export type { BuildTemplateConfig } from './config.js'
export { ManagedBuildExecutor } from './executor.js'
export type { BuildExecutionRequest, BuildExecutor } from './executor.js'
export { ServerModeHttpApi } from './http-api.js'
export { buildLedgerCodec, BuildLedgerStore, emptyBuildLedger } from './ledger.js'
export type { BuildLedger, BuildRecord } from './ledger.js'
export { assertProcessSuccess, NodeProcessRunner } from './process-runner.js'
export type { ProcessOptions, ProcessResult, ProcessRunner } from './process-runner.js'
export { BuildQueue } from './queue.js'
export type { BuildQueueEvent, BuildQueueOptions } from './queue.js'
export { NodeResourceProbe } from './resources.js'
export type { ResourceProbe, ResourceSample } from './resources.js'
export { DefaultServerModeService } from './service.js'
export { UserSystemdInstaller } from './systemd.js'
export type { SystemdInstallerOptions } from './systemd.js'
export { compileTemplate } from './templates.js'
export type { CompileTemplateInput } from './templates.js'
export { decodeWorkerResult, decodeWorkerSpec } from './worker-protocol.js'
export type { WorkerResult, WorkerSpec } from './worker-protocol.js'

function publishBuildEvent(ctx: Context, event: BuildQueueEvent): void {
  if (event.type !== 'job') return
  ctx.emit('luban.build.job', { jobId: event.job.id, from: event.from, to: event.to })
}

export function supportsServerMode(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux'
}

/** Mount Ubuntu server mode; other platforms stay disabled without side effects. */
export function apply(ctx: Context, input: Partial<ServerModeConfig> = {}): void {
  if (!supportsServerMode()) {
    ctx.logger.warn(
      'dsh-luban-server-mode is Ubuntu-only and remains disabled on %s',
      process.platform,
    )
    return
  }
  const config = parseConfig(input)
  const controller = new AbortController()
  const storeFile = resolveUserPath(config.store.file)
  const artifactDirectory = resolveUserPath(config.artifacts.dir)
  const artifacts = new ArtifactManager(artifactDirectory)
  const optionalTaskStore = ctx.get('lubanTaskStore')
  const queue = new BuildQueue({
    store: new BuildLedgerStore(storeFile),
    executor: new ManagedBuildExecutor({
      keepalive: ctx.lubanKeepalive,
      stateDirectory: dirname(storeFile),
      onError: (error: unknown): void => ctx.logger.warn(error),
    }),
    artifacts,
    probe: new NodeResourceProbe(artifactDirectory),
    templates: config.build.templates,
    workspaceRoots: config.build.workspaceRoots,
    maxConcurrent: config.build.maxConcurrent,
    defaultTimeoutMs: config.build.defaultTimeoutMin * 60_000,
    diskMinGb: config.guard.diskMinGb,
    loadMax: config.guard.loadMax,
    checkIntervalMs: config.guard.checkIntervalSec * 1_000,
    retainRuns: config.artifacts.retainRuns,
    ...(optionalTaskStore === undefined
      ? {}
      : { alerts: new TaskboardBuildAlertSink(optionalTaskStore) }),
    publish: (event): void => publishBuildEvent(ctx, event),
    onError: (error: unknown): void => ctx.logger.warn(error),
  })
  const installer = new UserSystemdInstaller({
    runner: new NodeProcessRunner(),
    serviceName: config.service.name,
    dshExecutable: config.service.dshExecutable,
    timeoutMs: 15_000,
    signal: controller.signal,
  })
  const service = new DefaultServerModeService(installer, queue)
  const api = new ServerModeHttpApi({
    service,
    auth: ctx.lubanAuth,
    artifacts,
    signer: new ArtifactLinkSigner({ ttlSec: config.artifacts.linkTtlSec }),
  })

  ctx.provide('lubanServerMode', service)
  ctx.effect(async () => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('server-mode'),
      handler: api.handler,
    })
    await service.start()
    return async (): Promise<void> => {
      unregister()
      api.dispose()
      controller.abort()
      await service.dispose()
    }
  }, 'luban-server-mode: queue and authenticated API lifecycle')
}
