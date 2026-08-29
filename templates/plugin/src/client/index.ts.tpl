import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Client services required before this browser half can activate. */
export const inject: readonly string[] = []

/**
 * Mount the browser half. Use an official declared slot before adding UI;
 * this neutral template deliberately invents no universal slot name.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // Register official slot contributions and client services here.
    return () => undefined
  })
}
