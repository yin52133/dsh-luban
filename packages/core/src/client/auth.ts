/** Resolve a fresh CSRF token before a mutation; failed authentication never falls through. */
export async function csrfHeaders(): Promise<Record<string, string>> {
  const controller = new AbortController()
  const timeout = setTimeout((): void => controller.abort(), 10_000)
  try {
    const response = await fetch('/luban-auth/session', {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403)
      throw new Error('登录已失效，请返回首页重新登录后再试。未提交本次操作。')
    if (!response.ok)
      throw new Error(`无法验证登录状态（${String(response.status)}），请检查连接后重试。`)
    const value: unknown = await response.json()
    const token =
      typeof value === 'object' && value !== null
        ? (value as Readonly<Record<string, unknown>>).csrfToken
        : undefined
    if (typeof token !== 'string' || token.trim() === '')
      throw new Error('登录验证信息不完整，请重新登录后再试。未提交本次操作。')
    return { 'x-luban-csrf': token }
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new Error('登录验证超时，请检查连接后重试。')
    throw error instanceof Error ? error : new Error('无法验证登录状态，请检查连接后重试。')
  } finally {
    clearTimeout(timeout)
  }
}
