import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AuthService, ImageIngestService } from 'dsh-luban-core'
import { LubanError, modulePrefix, systemClock } from 'dsh-luban-core'
import { SystemClipboardAdapter } from './clipboard.js'
import { DynamicSharpProcessor } from './compressor.js'
import { Config as ConfigSchema, type Config as ImagePasteConfig, parseConfig } from './config.js'
import { DshImageSessionInjector } from './dsh-injection.js'
import { ImagePasteHttpApi } from './http-api.js'
import { AttachmentRepository } from './repository.js'
import { FileImageIngestService } from './service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanImageIngest: ImageIngestService
  }
}

export const name = 'luban-image-paste'
export const inject = ['agents', 'webServer', 'lubanAuth']
export const provide = 'lubanImageIngest'
export const Config = ConfigSchema
export type Config = ImagePasteConfig
export { SystemClipboardAdapter, NodeBinaryCommandRunner } from './clipboard.js'
export type { BinaryCommandRunner, CommandResult, CommandSpec } from './clipboard.js'
export { DynamicSharpProcessor } from './compressor.js'
export type { SharpModuleLoader } from './compressor.js'
export { parseConfig } from './config.js'
export { DshImageSessionInjector, imagePrompt } from './dsh-injection.js'
export { ImagePasteHttpApi } from './http-api.js'
export { assertMimeMatches, detectImage, normalizeDeclaredMime } from './image-format.js'
export { AttachmentRepository } from './repository.js'
export type { AttachmentRepositoryOptions, StoreImageInput } from './repository.js'
export { FileImageIngestService } from './service.js'
export type { FileImageIngestServiceOptions, IngestOptions } from './service.js'
export type * from './types.js'

/** Enforce the M01 topology: the authenticated sidecar is the only network listener. */
export function assertLoopbackWebServer(host: string): void {
  if (host !== '127.0.0.1') {
    throw new LubanError(
      'E_INVALID_INPUT',
      'luban-image-paste requires the internal DSH WebServer to bind 127.0.0.1',
    )
  }
}

/** Mount the workspace attachment service, authenticated API, and bounded TTL sweep. */
export async function apply(ctx: Context, input: Partial<ImagePasteConfig> = {}): Promise<void> {
  const config = Object.freeze(parseConfig(input))
  const auth = ctx.get('lubanAuth') as AuthService | undefined
  if (auth === undefined) throw new LubanError('E_UNAVAILABLE', 'lubanAuth is unavailable')
  assertLoopbackWebServer(ctx.webServer.host)
  const repository = await AttachmentRepository.create({
    workspaceRoot: config.workspaceRoot,
    attachDir: config.attachDir,
    clock: systemClock,
  })
  const service = new FileImageIngestService({
    repository,
    accountSessions: auth.accountSessions,
    clipboard: new SystemClipboardAdapter({
      timeoutMs: config.clipboardTimeoutMs,
      maxBytes: config.maxBytes,
    }),
    injector: new DshImageSessionInjector(ctx.agents, repository.workspaceRoot),
    processor: new DynamicSharpProcessor(),
    config,
  })
  const api = new ImagePasteHttpApi(service, auth)
  ctx.provide('lubanImageIngest', service)
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('image-paste'),
      handler: api.handler,
    })
    const interval = setInterval(
      (): void => {
        void service.cleanup(false).catch((error: unknown): void => {
          ctx.logger.warn(
            `luban-image-paste cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          )
        })
      },
      config.cleanupIntervalMinutes * 60 * 1_000,
    )
    interval.unref()
    return (): void => {
      clearInterval(interval)
      unregister()
    }
  }, 'luban-image-paste: route and cleanup lifecycle')
}

const plugin = Object.freeze({ name, inject, provide, Config, apply })
export default plugin
