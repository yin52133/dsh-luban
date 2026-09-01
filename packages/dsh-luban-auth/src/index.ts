import { type Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { systemClock } from '@yin52133/dsh-luban-core'
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
export const inject = ['webServer']
export const provide = 'lubanAuth'

function originPort(origin: URL): number {
  if (origin.port !== '') return Number(origin.port)
  return origin.protocol === 'https:' ? 443 : 80
}

/** Refuse a topology that exposes the unauthenticated DSH listener or proxies another service. */
export function assertProtectedDshUpstream(
  webServer: Pick<WebServer, 'host' | 'port'>,
  upstream: URL,
): void {
  if (webServer.host !== '127.0.0.1') {
    throw new TypeError('luban-auth: DSH WebServer must bind to 127.0.0.1')
  }
  if (originPort(upstream) !== webServer.port) {
    throw new TypeError('luban-auth: upstream port must match the DSH WebServer listening port')
  }
}

/** Cordis plugin entry point: initialize state, provide AuthService, then own the sidecar effect. */
export async function apply(ctx: Context, config: LubanAuthConfig): Promise<void> {
  const upstream = parseUpstream(config.upstream)
  assertProtectedDshUpstream(ctx.webServer, upstream)
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
