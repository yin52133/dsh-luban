import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis row identifier used by the generated bundle patch. */
export const name = __PLUGIN_ID_JSON__

/**
 * Mount the Host half. Resources registered inside `ctx.effect` are disposed
 * when the row is hot-disabled or its profile shuts down.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    // Register Host services, routes, tools, or event listeners here.
    return () => undefined
  })
}
