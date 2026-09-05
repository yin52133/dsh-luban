import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

/** Show gateway account controls only when Luban authentication is installed. */
export function AccountControls(): ReactNode {
  const [user, setUser] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/luban-auth/session', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
      .then(async (response): Promise<void> => {
        if (!response.ok) return
        const body: unknown = await response.json()
        if (typeof body !== 'object' || body === null || controller.signal.aborted) return
        const name = (body as Readonly<Record<string, unknown>>).user
        if (typeof name === 'string' && name.length <= 64) setUser(name)
      })
      .catch((): void => {
        // Authentication is optional for standalone HUD installations.
      })
    return (): void => controller.abort()
  }, [])
  if (user === '') return null
  return (
    <form className="luban-hud__account" method="post" action="/luban-auth/logout">
      <span>账号：{user}</span>
      <button type="submit">退出登录</button>
    </form>
  )
}
