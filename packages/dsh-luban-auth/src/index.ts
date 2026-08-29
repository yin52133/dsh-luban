import { type Context } from '@deepseek-ai/cordis'
import { systemClock } from '@luban/core'
import { JsonlAuditLogger } from './audit.js'
import { AuthManager } from './auth-manager.js'
import { Config, expandHomePath, localHostnames, parseUpstream } from './config.js'
import { AuthSidecar } from './sidecar.js'
import { LubanAuthService } from './service.js'
import type { LubanAuthConfig } from './types.js'

export * from './audit.js'
export * from './auth-manager.js'
export * from './config.js'
export * from './http-security.js'
export * from './service.js'
export * from './sidecar.js'
export * from './state.js'
export * from './types.js'

export const name = 'luban-auth'
export const inject: readonly string[] = []
export const provide = 'lubanAuth'

/** Cordis plugin entry point: initialize state, provide AuthService, then own the sidecar effect. */
export async function apply(ctx: Context, config: LubanAuthConfig): Promise<void> {
  const upstream = parseUpstream(config.upstream)
  const audit = new JsonlAuditLogger(expandHomePath(config.auditDirectory), systemClock, 30)
  const manager = new AuthManager({
    filePath: expandHomePath(config.usersFile),
    audit,
    clock: systemClock,
    sessionTtlMs: config.sessionTtlHours * 60 * 60 * 1_000,
    maxFailures: config.maxFailures,
    lockoutMs: config.lockoutMinutes * 60 * 1_000,
    loginRateLimit: config.loginRateLimitPerMinute,
  })
  const bootstrapPassword = process.env[config.bootstrapAdminPasswordEnv]
  await manager.initialize(
    bootstrapPassword === undefined || bootstrapPassword === ''
      ? undefined
      : { username: config.bootstrapAdminUser, password: bootstrapPassword },
  )
  ctx.effect(() => async (): Promise<void> => manager.close(), 'lubanAuth.state')
  new LubanAuthService(ctx, manager)

  if (!(await manager.hasUsers())) {
    ctx.logger.warn(
      `luban-auth: no users configured; set ${config.bootstrapAdminPasswordEnv} for one restart to create ${config.bootstrapAdminUser}`,
    )
  }
  if (config.host === '0.0.0.0' && config.secureCookies !== 'always') {
    ctx.logger.warn('luban-auth: LAN HTTP is not safe for public networks; use a TLS reverse proxy')
  }
  if (process.platform === 'win32') {
    ctx.logger.info(
      'luban-auth: account files are mode-restricted; also verify the Windows user ACL',
    )
  }

  const sidecar = new AuthSidecar({
    config,
    upstream,
    manager,
    trustedHostnames: localHostnames(config.trustedHosts),
    onError: (error): void => ctx.logger.warn(error),
  })
  await ctx.effect(async () => {
    const result = await sidecar.start()
    ctx.logger.info(`luban-auth: listening on ${result.publicUrl}; upstream ${result.upstreamUrl}`)
    return async (): Promise<void> => sidecar.stop()
  }, 'lubanAuth.sidecar')
}

const plugin = Object.freeze({
  name,
  inject,
  provide,
  Config,
  apply,
})

export default plugin
